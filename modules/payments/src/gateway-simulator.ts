import type { Pool } from "pg";
import { resolveDuePayments } from "./payments.repository.js";

// How long a confirmed intent "processes" before the fake gateway resolves
// it — stands in for real network/settlement latency. Always resolves to
// SUCCEEDED in M3; declines are simulated by tests writing FAILED directly,
// same way M2 simulated hold expiry by back-dating held_until directly.
// Real chaos modes (decline, timeout, slow) are M7's job.
const FAKE_PROCESSING_DELAY_MS = 1000;

export async function runGatewayTickOnce(pool: Pool): Promise<number> {
  const resolved = await resolveDuePayments(pool, FAKE_PROCESSING_DELAY_MS);
  return resolved.length;
}

export function startGatewaySimulator(pool: Pool, intervalMs: number): () => void {
  const handle = setInterval(() => {
    runGatewayTickOnce(pool).catch((err) => {
      console.error("gateway simulator tick failed", err);
    });
  }, intervalMs);

  return () => clearInterval(handle);
}
