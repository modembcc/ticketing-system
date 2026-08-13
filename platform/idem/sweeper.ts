import type { Pool } from "pg";
import { sweepExpiredIdempotencyKeys } from "./repository.js";

export async function runIdemSweepOnce(pool: Pool): Promise<number> {
  return sweepExpiredIdempotencyKeys(pool);
}

export function startIdemSweeper(pool: Pool, intervalMs: number): () => void {
  const handle = setInterval(() => {
    runIdemSweepOnce(pool).catch((err) => {
      console.error("idempotency key sweeper tick failed", err);
    });
  }, intervalMs);

  return () => clearInterval(handle);
}
