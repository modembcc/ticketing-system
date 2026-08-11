CREATE SCHEMA IF NOT EXISTS ordering;

CREATE TABLE ordering.reservations (
  id           UUID PRIMARY KEY,
  event_id     UUID NOT NULL REFERENCES catalog.events (id),
  customer_id  TEXT NOT NULL,
  seat_ids     UUID[] NOT NULL,
  state        TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT'
                 CHECK (state IN ('AWAITING_PAYMENT', 'EXPIRED')),
  held_until   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reservations_sweep_idx ON ordering.reservations (state, held_until);
