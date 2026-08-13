import Fastify, { type FastifyInstance } from "fastify";
import type { ConfirmChannel } from "amqplib";
import { Pool } from "pg";
import { registerAdminDlqRoutes } from "./routes/admin-dlq.js";
import { registerAdminEventRoutes } from "./routes/admin-events.js";
import { registerCustomerEventRoutes } from "./routes/events.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerReservationRoutes } from "./routes/reservations.js";

export interface BuildAppOptions {
  pool: Pool;
  // Only needed for POST /admin/dlq/:id/replay. Optional so the 9+ test
  // files with no reason to touch RabbitMQ don't each pay for a broker
  // Testcontainer they never use.
  publisherChannel?: ConfirmChannel;
}

export function buildApp({ pool, publisherChannel }: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: true });

  // Liveness: process is up and can serve requests. No dependency checks.
  app.get("/health/live", async () => {
    return { status: "ok" };
  });

  // Readiness: process can actually do its job (DB reachable).
  app.get("/health/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      return { status: "ok" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      reply.code(503);
      return { status: "unavailable" };
    }
  });

  registerAdminEventRoutes(app, pool);
  registerCustomerEventRoutes(app, pool);
  registerReservationRoutes(app, pool);
  registerPaymentRoutes(app, pool);
  registerAdminDlqRoutes(app, pool, publisherChannel);

  return app;
}
