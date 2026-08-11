import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createReservation,
  EventNotFoundError,
  ReservationValidationError,
  SaleWindowClosedError,
  SeatsUnavailableError,
} from "../../../../modules/ordering/index.js";
import { serializeReservation } from "./serializers.js";
import { isValidUuid } from "./validation.js";

interface CreateReservationBody {
  eventId?: unknown;
  seatCount?: unknown;
}

export function registerReservationRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Body: CreateReservationBody }>("/reservations", async (req, reply) => {
    const customerId = req.headers["x-customer-id"];
    if (typeof customerId !== "string" || !customerId.trim()) {
      reply.code(400);
      return { error: "X-Customer-Id header is required" };
    }

    const body = req.body ?? {};
    const eventId = typeof body.eventId === "string" ? body.eventId : "";
    if (!isValidUuid(eventId)) {
      reply.code(400);
      return { error: "eventId must be a UUID" };
    }

    const seatCount = typeof body.seatCount === "number" ? body.seatCount : NaN;

    try {
      const reservation = await createReservation(pool, { eventId, customerId, seatCount });
      reply.code(201);
      return serializeReservation(reservation);
    } catch (err) {
      if (err instanceof ReservationValidationError) {
        reply.code(400);
        return { error: err.message };
      }
      if (err instanceof EventNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof SaleWindowClosedError) {
        reply.code(422);
        return { error: err.message, reason: err.reason };
      }
      if (err instanceof SeatsUnavailableError) {
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }
  });
}
