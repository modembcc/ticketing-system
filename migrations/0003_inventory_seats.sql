CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE inventory.seats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES catalog.events (id),
  label       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'AVAILABLE'
                CHECK (status IN ('AVAILABLE', 'HELD', 'SOLD')),
  hold_id     UUID,
  held_until  TIMESTAMPTZ,
  version     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, label)
);

CREATE INDEX seats_event_id_idx ON inventory.seats (event_id);
