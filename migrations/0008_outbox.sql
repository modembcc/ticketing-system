CREATE SCHEMA IF NOT EXISTS outbox;

-- No FK on aggregate_id: unlike inventory.seats.event_id (which only ever
-- points at catalog.events), this column is deliberately polymorphic —
-- today it's ordering.reservations, later it could be any module's
-- aggregate. A single column can't FK multiple tables, so there's no
-- candidate table to point at.
CREATE TABLE outbox.events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,
  aggregate_id   UUID NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ
);

CREATE INDEX outbox_events_unpublished_idx ON outbox.events (created_at)
  WHERE published_at IS NULL;
