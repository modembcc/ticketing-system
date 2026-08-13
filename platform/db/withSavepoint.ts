import type { PoolClient } from "pg";

let counter = 0;

// A business-logic error (e.g. SeatsUnavailableError) can be thrown after
// partial writes (some seats already held) and still needs to become a
// normal {status, body} return value one level up — so idempotency
// bookkeeping in the enclosing transaction can commit and record it as a
// replayable outcome. But "normal return value" looks identical to "clean
// success" to the enclosing transaction, so without a savepoint boundary
// those partial writes would commit too. Wrap just the risky work: on
// throw, undo only what happened since the savepoint, then rethrow so the
// caller can still convert it to a response.
export async function withSavepoint<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  const name = `sp_${++counter}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}
