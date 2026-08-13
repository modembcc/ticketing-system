import amqp, { type ChannelModel, type Channel, type ConfirmChannel } from "amqplib";

export const DOMAIN_EVENTS_EXCHANGE = "domain-events";

// Keyed by "first call wins," not by url — fine because each real process
// (or test file) only ever talks to one broker.
let connectionPromise: Promise<ChannelModel> | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CONNECT_MAX_ATTEMPTS = 10;
const CONNECT_RETRY_DELAY_MS = 1000;

// docker-compose's healthcheck (rabbitmq-diagnostics ping) can report
// "healthy" a moment before the AMQP listener on 5672 is actually accepting
// connections — a real startup race, not a hypothetical one (hit this on
// first `docker compose up` from clean: ECONNREFUSED even though `depends_on:
// condition: service_healthy` had already been satisfied). Retry with a
// fixed backoff rather than trusting the healthcheck's timing exactly.
async function connectWithRetry(url: string): Promise<ChannelModel> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
    try {
      return await amqp.connect(url);
    } catch (err) {
      lastError = err;
      if (attempt < CONNECT_MAX_ATTEMPTS) {
        await delay(CONNECT_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

async function getConnection(url: string): Promise<ChannelModel> {
  if (!connectionPromise) {
    connectionPromise = connectWithRetry(url);
  }
  return connectionPromise;
}

// Publisher side: a confirm channel, so callers can `waitForConfirms()`
// before treating a publish as durable. A plain channel's publish() only
// means "written to the local TCP buffer" — a dropped connection between
// that and the broker actually processing the frame loses the message with
// no trace, the exact failure the outbox pattern exists to prevent.
export async function createPublisherChannel(url: string): Promise<ConfirmChannel> {
  const connection = await getConnection(url);
  const channel = await connection.createConfirmChannel();
  await channel.assertExchange(DOMAIN_EVENTS_EXCHANGE, "topic", { durable: true });
  return channel;
}

export async function createConsumerChannel(url: string): Promise<Channel> {
  const connection = await getConnection(url);
  const channel = await connection.createChannel();
  await channel.assertExchange(DOMAIN_EVENTS_EXCHANGE, "topic", { durable: true });
  return channel;
}

export async function closeBrokerConnection(): Promise<void> {
  if (connectionPromise) {
    const connection = await connectionPromise;
    connectionPromise = null;
    await connection.close();
  }
}
