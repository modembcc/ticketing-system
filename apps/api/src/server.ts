import { Pool } from "pg";
import { buildApp } from "./app.js";
import { runMigrations } from "../../../platform/migrate/run.js";
import { startIdemSweeper } from "../../../platform/idem/sweeper.js";
import { closeBrokerConnection, createConsumerChannel, createPublisherChannel } from "../../../platform/broker/connection.js";
import { startRelay } from "../../../platform/outbox/relay.js";
import { startPaymentPoller, startSweeper } from "../../../modules/ordering/index.js";
import { startGatewaySimulator } from "../../../modules/payments/index.js";
import { ensureNotifyQueue, startNotifyConsumer } from "../../../modules/notify/index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}
const rabbitmqUrl = process.env.RABBITMQ_URL;
if (!rabbitmqUrl) {
  throw new Error("RABBITMQ_URL is not set");
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const sweepIntervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? 5000);
const gatewayTickIntervalMs = Number(process.env.GATEWAY_TICK_INTERVAL_MS ?? 1000);
const paymentPollIntervalMs = Number(process.env.PAYMENT_POLL_INTERVAL_MS ?? 500);
const idemSweepIntervalMs = Number(process.env.IDEM_SWEEP_INTERVAL_MS ?? 60_000);
const relayIntervalMs = Number(process.env.RELAY_INTERVAL_MS ?? 200);
const notifyPollIntervalMs = Number(process.env.NOTIFY_POLL_INTERVAL_MS ?? 500);
const mailDir = process.env.MAIL_DIR ?? "./mail";

await runMigrations(connectionString);

const pool = new Pool({ connectionString });
const app = buildApp({ pool });

const publisherChannel = await createPublisherChannel(rabbitmqUrl);
const consumerChannel = await createConsumerChannel(rabbitmqUrl);
// Must exist before the relay ever publishes — an exchange with no bound
// queue silently drops messages, confirms and all. See DECISIONS.md.
await ensureNotifyQueue(consumerChannel);

const stopSweeper = startSweeper(pool, sweepIntervalMs);
const stopGatewaySimulator = startGatewaySimulator(pool, gatewayTickIntervalMs);
const stopPaymentPoller = startPaymentPoller(pool, paymentPollIntervalMs);
const stopIdemSweeper = startIdemSweeper(pool, idemSweepIntervalMs);
const stopRelay = startRelay(pool, publisherChannel, relayIntervalMs);
const stopNotifyConsumer = startNotifyConsumer(pool, consumerChannel, mailDir, notifyPollIntervalMs);

app.addHook("onClose", async () => {
  stopSweeper();
  stopGatewaySimulator();
  stopPaymentPoller();
  stopIdemSweeper();
  stopRelay();
  stopNotifyConsumer();
  await closeBrokerConnection();
  await pool.end();
});

await app.listen({ port, host });
