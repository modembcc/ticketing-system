import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { listEvents } from "../../../../modules/catalog/index.js";
import { countAvailableByEventIds } from "../../../../modules/inventory/index.js";
import { serializeEvent } from "./serializers.js";

export function registerCustomerEventRoutes(app: FastifyInstance, pool: Pool): void {
  app.get("/events", async () => {
    const events = await listEvents(pool);
    const counts = await countAvailableByEventIds(pool, events.map((e) => e.id));
    return events.map((e) => serializeEvent(e, counts.get(e.id) ?? 0));
  });
}
