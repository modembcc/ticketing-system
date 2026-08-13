import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { hashRequestBody } from "./hash.js";
import { completeKey, findIdempotencyKey, insertPendingKey, type IdempotencyRecord } from "./repository.js";

export interface IdempotencyInput {
  key: string;
  endpoint: string;
  requestBody: unknown;
}

// Body is intentionally `unknown`, not a generic: a handler's outcome is a
// union of its success shape and however many distinct error shapes it
// maps its own domain errors to — forcing one type parameter across all of
// them buys nothing and fights the caller at every call site.
export interface HandlerResult {
  status: number;
  body: unknown;
}

function replayOrReject(existing: IdempotencyRecord, requestHash: string): HandlerResult {
  if (existing.requestHash !== requestHash) {
    return { status: 422, body: { error: "Idempotency-Key was already used with a different request body" } };
  }
  if (existing.status === "PENDING") {
    return { status: 409, body: { error: "a request with this Idempotency-Key is still being processed, retry shortly" } };
  }
  return { status: existing.responseStatus ?? 500, body: existing.responseBody };
}

// Key + endpoint + request body hash form the identity (spec's own words).
// The first caller to win the PENDING insert runs `handler` and records its
// result — success or a well-formed business error alike — as the
// permanent, replayable outcome of that key. `handler` is expected to catch
// its own typed domain errors and return them as {status, body}; anything
// it lets propagate is treated as a genuine unexpected failure: the
// transaction rolls back and no idempotency record is left behind, so a
// legitimate retry after an infra failure isn't permanently poisoned.
export async function withIdempotency(
  pool: Pool,
  input: IdempotencyInput,
  handler: (client: PoolClient) => Promise<HandlerResult>,
): Promise<HandlerResult> {
  const requestHash = hashRequestBody(input.requestBody);

  const existing = await findIdempotencyKey(pool, input.key, input.endpoint);
  if (existing) {
    return replayOrReject(existing, requestHash);
  }

  const outcome = await withTransaction(pool, async (client) => {
    const won = await insertPendingKey(client, { key: input.key, endpoint: input.endpoint, requestHash });
    if (!won) {
      return { won: false as const };
    }
    const result = await handler(client);
    await completeKey(client, { key: input.key, endpoint: input.endpoint, status: result.status, body: result.body });
    return { won: true as const, result };
  });

  if (outcome.won) {
    return outcome.result;
  }

  // Lost the race to insert PENDING first — someone else's request for the
  // same key got there between our lookup and our insert attempt.
  const raced = await findIdempotencyKey(pool, input.key, input.endpoint);
  if (raced) {
    return replayOrReject(raced, requestHash);
  }
  throw new Error(`idempotency key ${input.key} vanished after losing the insert race`);
}
