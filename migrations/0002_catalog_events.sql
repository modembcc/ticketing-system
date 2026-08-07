CREATE SCHEMA IF NOT EXISTS catalog;

CREATE TABLE catalog.events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  venue           TEXT NOT NULL,
  starts_at       TIMESTAMPTZ NOT NULL,
  sale_starts_at  TIMESTAMPTZ NOT NULL,
  sale_ends_at    TIMESTAMPTZ NOT NULL,
  capacity        INTEGER NOT NULL CHECK (capacity > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sale_starts_at < sale_ends_at)
);
