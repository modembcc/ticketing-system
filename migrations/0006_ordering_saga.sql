ALTER TABLE ordering.reservations
  ADD COLUMN payment_id UUID REFERENCES payments.payments (id),
  ADD COLUMN amount_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ordering.reservations DROP CONSTRAINT reservations_state_check;
ALTER TABLE ordering.reservations ADD CONSTRAINT reservations_state_check
  CHECK (state IN ('AWAITING_PAYMENT', 'PAID', 'FAILED', 'EXPIRED', 'FULFILLED', 'REFUNDING', 'REFUNDED'));

CREATE TABLE ordering.tickets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id  UUID NOT NULL REFERENCES ordering.reservations (id),
  seat_id         UUID NOT NULL UNIQUE,
  customer_id     TEXT NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  qr_token        TEXT NOT NULL UNIQUE
);

CREATE INDEX tickets_reservation_id_idx ON ordering.tickets (reservation_id);
