import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { withTransaction } from "../../../../platform/db/withTransaction.js";
import {
  type CreateEventInput,
  EventValidationError,
  findEventById,
  insertEvent,
  listEvents,
  validateCreateEventInput,
} from "../../../../modules/catalog/index.js";
import { countAvailableByEventIds, generateSeats } from "../../../../modules/inventory/index.js";
import { serializeEvent } from "./serializers.js";
import { isValidUuid } from "./validation.js";

interface CreateEventBody {
  name?: unknown;
  venue?: unknown;
  startsAt?: unknown;
  saleStartsAt?: unknown;
  saleEndsAt?: unknown;
  capacity?: unknown;
}

function toDate(value: unknown): Date {
  return new Date(typeof value === "string" ? value : NaN);
}

function parseCreateEventInput(body: CreateEventBody): CreateEventInput {
  return {
    name: typeof body.name === "string" ? body.name : "",
    venue: typeof body.venue === "string" ? body.venue : "",
    startsAt: toDate(body.startsAt),
    saleStartsAt: toDate(body.saleStartsAt),
    saleEndsAt: toDate(body.saleEndsAt),
    capacity: typeof body.capacity === "number" ? body.capacity : NaN,
  };
}

export function registerAdminEventRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Body: CreateEventBody }>("/admin/events", async (req, reply) => {
    const input = parseCreateEventInput(req.body ?? {});

    try {
      validateCreateEventInput(input);
    } catch (err) {
      if (err instanceof EventValidationError) {
        reply.code(400);
        return { error: err.message };
      }
      throw err;
    }

    const { event, seatCount } = await withTransaction(pool, async (client) => {
      const created = await insertEvent(client, input);
      const seats = await generateSeats(client, created.id, created.capacity);
      return { event: created, seatCount: seats.length };
    });

    reply.code(201);
    return serializeEvent(event, seatCount);
  });

  app.get("/admin/events", async () => {
    const events = await listEvents(pool);
    const counts = await countAvailableByEventIds(pool, events.map((e) => e.id));
    return events.map((e) => serializeEvent(e, counts.get(e.id) ?? 0));
  });

  app.get<{ Params: { id: string } }>("/admin/events/:id", async (req, reply) => {
    if (!isValidUuid(req.params.id)) {
      reply.code(400);
      return { error: "id must be a UUID" };
    }

    const event = await findEventById(pool, req.params.id);
    if (!event) {
      reply.code(404);
      return { error: "event not found" };
    }

    const counts = await countAvailableByEventIds(pool, [event.id]);
    return serializeEvent(event, counts.get(event.id) ?? 0);
  });
}
