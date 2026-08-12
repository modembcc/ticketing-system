import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  confirmReservationPayment,
  PaymentNotFoundError,
  ReservationNotAwaitingPaymentError,
} from "../../../../modules/ordering/index.js";
import { findPaymentById } from "../../../../modules/payments/index.js";
import { serializePayment, serializeReservation } from "./serializers.js";
import { isValidUuid } from "./validation.js";

export function registerPaymentRoutes(app: FastifyInstance, pool: Pool): void {
  app.post<{ Params: { id: string } }>("/payments/:id/confirm", async (req, reply) => {
    if (!isValidUuid(req.params.id)) {
      reply.code(400);
      return { error: "id must be a UUID" };
    }

    try {
      const reservation = await confirmReservationPayment(pool, req.params.id);
      return serializeReservation(reservation);
    } catch (err) {
      if (err instanceof PaymentNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      if (err instanceof ReservationNotAwaitingPaymentError) {
        reply.code(409);
        return { error: err.message };
      }
      throw err;
    }
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
