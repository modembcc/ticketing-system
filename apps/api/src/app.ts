import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { registerAdminEventRoutes } from "./routes/admin-events.js";
import { registerCustomerEventRoutes } from "./routes/events.js";
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerReservationRoutes } from "./routes/reservations.js";

export interface BuildAppOptions {
  pool: Pool;
}

export function buildApp({ pool }: BuildAppOptions): FastifyInstance {
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

  return app;
}
