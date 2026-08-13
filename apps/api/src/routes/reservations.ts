import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createReservation,
  EventNotFoundError,
  ReservationValidationError,
  SaleWindowClosedError,
  SeatsUnavailableError,
} from "../../../../modules/ordering/index.js";
import { withSavepoint } from "../../../../platform/db/withSavepoint.js";
import { withIdempotency } from "../../../../platform/idem/withIdempotency.js";
import { serializeReservation } from "./serializers.js";
import { isValidUuid } from "./validation.js";

interface CreateReservationBody {
  eventId?: unknown;
  seatCount?: unknown;
}

export function registerReservationRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Body: CreateReservationBody }>("/reservations", async (req, reply) => {
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      reply.code(400);
      return { error: "Idempotency-Key header is required" };
    }

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

    const result = await withIdempotency(
      pool,
      {
        key: idempotencyKey,
        endpoint: "POST /reservations",
        requestBody: { eventId, seatCount, customerId },
      },
      async (client) => {
        try {
          // createReservation can throw *after* partially holding seats
          // (SeatsUnavailableError, once the retry loop gives up). Without a
          // savepoint boundary, catching that below and returning a normal
          // {status, body} would let the enclosing idempotency transaction
          // commit those partial holds along with the cached error response.
          const reservation = await withSavepoint(client, () =>
            createReservation(client, { eventId, customerId, seatCount }),
          );
          return { status: 201, body: serializeReservation(reservation) };
        } catch (err) {
          if (err instanceof ReservationValidationError) {
            return { status: 400, body: { error: err.message } };
          }
          if (err instanceof EventNotFoundError) {
            return { status: 404, body: { error: err.message } };
          }
          if (err instanceof SaleWindowClosedError) {
            return { status: 422, body: { error: err.message, reason: err.reason } };
          }
          if (err instanceof SeatsUnavailableError) {
            return { status: 409, body: { error: err.message } };
          }
          throw err;
        }
      },
    );

    reply.code(result.status);
    return result.body;
  });
}
