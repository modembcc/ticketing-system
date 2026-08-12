import { Pool } from "pg";
import { buildApp } from "./app.js";
import { runMigrations } from "../../../platform/migrate/run.js";
import { startPaymentPoller, startSweeper } from "../../../modules/ordering/index.js";
import { startGatewaySimulator } from "../../../modules/payments/index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const sweepIntervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? 5000);
const gatewayTickIntervalMs = Number(process.env.GATEWAY_TICK_INTERVAL_MS ?? 1000);
const paymentPollIntervalMs = Number(process.env.PAYMENT_POLL_INTERVAL_MS ?? 500);

await runMigrations(connectionString);

const pool = new Pool({ connectionString });
const app = buildApp({ pool });
const stopSweeper = startSweeper(pool, sweepIntervalMs);
const stopGatewaySimulator = startGatewaySimulator(pool, gatewayTickIntervalMs);
const stopPaymentPoller = startPaymentPoller(pool, paymentPollIntervalMs);

app.addHook("onClose", async () => {
  stopSweeper();
  stopGatewaySimulator();
  stopPaymentPoller();
  await pool.end();
});

await app.listen({ port, host });
