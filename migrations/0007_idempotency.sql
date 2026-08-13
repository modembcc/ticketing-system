CREATE SCHEMA IF NOT EXISTS idem;

-- (key, endpoint) collisions are not aware of expires_at: a key reused after
-- its logical 24h TTL but before the sweeper has physically deleted the row
-- is still treated as a live collision (mismatch/replay/409), not "fresh".
-- The sweeper runs often enough that this window is small; not worth the
-- extra ON CONFLICT ... DO UPDATE ... WHERE complexity for a teaching lab.
CREATE TABLE idem.idempotency_keys (
  key             TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (key, endpoint)
);

CREATE INDEX idempotency_keys_expires_at_idx ON idem.idempotency_keys (expires_at);

CREATE TABLE idem.processed_messages (
  message_id    TEXT NOT NULL,
  consumer      TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_hash   TEXT,
  PRIMARY KEY (message_id, consumer)
);
