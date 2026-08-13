import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  confirmReservationPayment,
  PaymentNotFoundError,
  ReservationNotAwaitingPaymentError,
} from "../../../../modules/ordering/index.js";
import { findPaymentById } from "../../../../modules/payments/index.js";
import { withSavepoint } from "../../../../platform/db/withSavepoint.js";
import { withIdempotency } from "../../../../platform/idem/withIdempotency.js";
import { serializePayment, serializeReservation } from "./serializers.js";
import { isValidUuid } from "./validation.js";

export function registerPaymentRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Params: { id: string } }>("/payments/:id/confirm", async (req, reply) => {
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
      reply.code(400);
      return { error: "Idempotency-Key header is required" };
    }

    if (!isValidUuid(req.params.id)) {
      reply.code(400);
      return { error: "id must be a UUID" };
    }

    // No meaningful request body to hash — the payment id is baked into the
    // endpoint identity instead, so a key accidentally reused across two
    // different payments is caught as a mismatch rather than colliding.
    const result = await withIdempotency(
      pool,
      {
        key: idempotencyKey,
        endpoint: `POST /payments/${req.params.id}/confirm`,
        requestBody: {},
      },
      async (client) => {
        try {
          // No partial-write risk today (confirmPayment only runs after all
          // validation passes), but wrapped for consistency with the
          // reservations route and as insurance against this becoming true
          // after a future change — see withSavepoint's doc comment.
          const reservation = await withSavepoint(client, () => confirmReservationPayment(client, req.params.id));
          return { status: 200, body: serializeReservation(reservation) };
        } catch (err) {
          if (err instanceof PaymentNotFoundError) {
            return { status: 404, body: { error: err.message } };
          }
          if (err instanceof ReservationNotAwaitingPaymentError) {
            return { status: 409, body: { error: err.message } };
          }
          throw err;
        }
      },
    );

    reply.code(result.status);
    return result.body;
  });

  app.get<{ Params: { id: string } }>("/payments/:id", async (req, reply) => {
    if (!isValidUuid(req.params.id)) {
      reply.code(400);
      return { error: "id must be a UUID" };
    }

    const payment = await findPaymentById(pool, req.params.id);
    if (!payment) {
      reply.code(404);
      return { error: "payment not found" };
    }
    return serializePayment(payment);
  });
}
