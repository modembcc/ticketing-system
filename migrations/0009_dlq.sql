CREATE SCHEMA IF NOT EXISTS dlq;

CREATE TABLE dlq.entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_queue    TEXT NOT NULL,
  consumer        TEXT NOT NULL,
  message_id      TEXT,          -- the domain event id, if the payload parsed far enough to have one
  raw_content     TEXT NOT NULL, -- exact message bytes, so replay can republish byte-for-byte
  payload         JSONB,         -- best-effort parsed; NULL for malformed (unparseable) messages
  failure_reason  TEXT NOT NULL,
  attempt_count   INTEGER NOT NULL,
  broker_headers  JSONB,         -- msg.properties.headers as delivered, including any real x-death
                                  -- RabbitMQ attached from the retry-queue TTL hops
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at     TIMESTAMPTZ,
  discarded_at    TIMESTAMPTZ,
  discard_reason  TEXT
);

-- One unresolved entry per (message_id, consumer): if the process crashes
-- between inserting this row and acking the original delivery, RabbitMQ
-- redelivers the un-acked message and the consumer would otherwise insert a
-- second row for the same failure. Once an entry is replayed or discarded,
-- a later failure of the same message is a new episode and gets a fresh row.
CREATE UNIQUE INDEX dlq_entries_unresolved_message_idx
  ON dlq.entries (message_id, consumer)
  WHERE message_id IS NOT NULL AND replayed_at IS NULL AND discarded_at IS NULL;

CREATE INDEX dlq_entries_unresolved_idx ON dlq.entries (created_at)
  WHERE replayed_at IS NULL AND discarded_at IS NULL;
