import type { Pool } from "pg";
import { findPaymentById } from "../../payments/index.js";
import { findPollCandidates } from "./reservations.repository.js";
import { fulfillPaidReservation, settleFailedPayment, settlePaidPayment } from "./settle.js";

// 1s, 2s, 3s, 5s, 5s, 5s... capped, matching the spec's backoff schedule.
// Never scheduled past a reservation's held_until — once the hold expires,
// the sweeper (and the late-refund path) takes over.
const POLL_SCHEDULE_MS = [1000, 2000, 3000, 5000];

function nextDelayMs(attempt: number): number {
  return POLL_SCHEDULE_MS[Math.min(attempt, POLL_SCHEDULE_MS.length - 1)];
}

interface PollTracker {
  attempt: number;
  nextPollAt: number;
}

// In-memory only — on restart every candidate is just re-seeded and polled
// immediately, which is harmless (this is a poll schedule, not a source of
// truth; the database rows are that).
const trackers = new Map<string, PollTracker>();

export async function runPaymentPollOnce(pool: Pool): Promise<number> {
  const now = Date.now();
  const candidates = await findPollCandidates(pool);
  const candidateIds = new Set(candidates.map((c) => c.id));
  for (const id of trackers.keys()) {
    if (!candidateIds.has(id)) trackers.delete(id);
  }

  let settled = 0;

  for (const candidate of candidates) {
    if (candidate.state === "PAID") {
      await fulfillPaidReservation(pool, candidate.id);
      trackers.delete(candidate.id);
      settled++;
      continue;
    }

    let tracker = trackers.get(candidate.id);
    if (!tracker) {
      tracker = { attempt: 0, nextPollAt: now };
      trackers.set(candidate.id, tracker);
    }
    if (now < tracker.nextPollAt) continue;

    const payment = await findPaymentById(pool, candidate.paymentId);
    if (!payment) {
      trackers.delete(candidate.id);
      continue;
    }

    if (payment.status === "SUCCEEDED") {
      await settlePaidPayment(pool, { reservationId: candidate.id, paymentId: candidate.paymentId });
      trackers.delete(candidate.id);
      settled++;
    } else if (payment.status === "FAILED") {
      // A FAILED payment on an already-EXPIRED reservation is a no-op inside
      // settleFailedPayment (nothing to compensate — no money was captured).
      await settleFailedPayment(pool, { reservationId: candidate.id, paymentId: candidate.paymentId });
      trackers.delete(candidate.id);
      settled++;
    } else if (candidate.state === "EXPIRED") {
      // Still PENDING and already expired — nothing left to poll for.
      trackers.delete(candidate.id);
    } else {
      tracker.attempt++;
      const delay = nextDelayMs(tracker.attempt);
      tracker.nextPollAt = Math.min(now + delay, candidate.heldUntil.getTime());
    }
  }

  return settled;
}

export function startPaymentPoller(pool: Pool, tickIntervalMs: number): () => void {
  const handle = setInterval(() => {
    runPaymentPollOnce(pool).catch((err) => {
      console.error("payment poller tick failed", err);
    });
  }, tickIntervalMs);

  return () => clearInterval(handle);
}
