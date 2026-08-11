import type { Pool } from "pg";
import { releaseSeats } from "../../inventory/index.js";
import { withTransaction } from "../../../platform/db/withTransaction.js";
import { expireDueReservations } from "./reservations.repository.js";

const SWEEP_BATCH_SIZE = 100;

export async function runSweepOnce(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const expired = await expireDueReservations(client, SWEEP_BATCH_SIZE);
    for (const reservation of expired) {
      await releaseSeats(client, { seatIds: reservation.seatIds, holdId: reservation.id });
    }
    return expired.length;
  });
}

export function startSweeper(pool: Pool, intervalMs: number): () => void {
  const handle = setInterval(() => {
    runSweepOnce(pool).catch((err) => {
      console.error("sweeper tick failed", err);
    });
  }, intervalMs);

  return () => clearInterval(handle);
}
