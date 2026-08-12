CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE payments.payments (
  id              UUID PRIMARY KEY,
  reservation_id  UUID NOT NULL UNIQUE REFERENCES ordering.reservations (id),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED')),
  amount_cents    INTEGER NOT NULL,
  provider_ref    TEXT NOT NULL,
  confirmed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supports the fake gateway's own tick: find confirmed-but-unresolved intents.
CREATE INDEX payments_due_idx ON payments.payments (confirmed_at) WHERE status = 'PENDING';
