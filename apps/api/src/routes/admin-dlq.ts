import type { FastifyInstance } from "fastify";
import type { ConfirmChannel } from "amqplib";
import type { Pool } from "pg";
import { withTransaction } from "../../../../platform/db/withTransaction.js";
import {
  findDlqEntryById,
  listUnresolvedDlqEntries,
  markDlqEntryDiscarded,
  markDlqEntryReplayed,
} from "../../../../platform/dlq/repository.js";
import { serializeDlqEntry } from "./serializers.js";
import { isValidUuid } from "./validation.js";

interface DiscardBody {
  reason?: unknown;
}

export function registerAdminDlqRoutes(app: FastifyInstance, pool: Pool, publisherChannel?: ConfirmChannel): void {
  app.get("/admin/dlq", async () => {
    const entries = await listUnresolvedDlqEntries(pool);
    return entries.map(serializeDlqEntry);
  });

  app.post<{ Params: { id: string } }>("/admin/dlq/:id/replay", async (req, reply) => {
    if (!isValidUuid(req.params.id)) {
      reply.code(400);
      return { error: "id must be a UUID" };
    }

    const entry = await findDlqEntryById(pool, req.params.id);
    if (!entry || entry.replayedAt || entry.discardedAt) {
      reply.code(404);
      return { error: "unresolved DLQ entry not found" };
    }

    if (!publisherChannel) {
      reply.code(503);
      return { error: "broker unavailable, cannot replay" };
    }

    // Requeue to the source queue with a fresh attempt budget — no
    // x-retry-count header carried over, so whatever fixed the underlying
    // issue gets the message a full new set of retries rather than picking
    // up mid-backoff. Same confirm-then-commit ordering as the outbox
    // relay: publish, wait for the broker to actually have it, only then
    // record success — skipping the wait here would risk marking an entry
    // replayed that the broker never received, with nothing left to
    // redeliver it (DLQ entries have no outbox-style fallback behind them).
    publisherChannel.publish("", entry.sourceQueue, Buffer.from(entry.rawContent, "utf8"), {
      persistent: true,
    });
    await publisherChannel.waitForConfirms();

    await withTransaction(pool, (client) => markDlqEntryReplayed(client, entry.id));

    reply.code(200);
    return { id: entry.id, status: "replayed" };
  });

  app.post<{ Params: { id: string }; Body: DiscardBody }>("/admin/dlq/:id/discard", async (req, reply) => {
    if (!isValidUuid(req.params.id)) {
      reply.code(400);
      return { error: "id must be a UUID" };
    }

    const reason = req.body?.reason;
    if (typeof reason !== "string" || !reason.trim()) {
      reply.code(400);
      return { error: "reason is required" };
    }

    const entry = await findDlqEntryById(pool, req.params.id);
    if (!entry || entry.replayedAt || entry.discardedAt) {
      reply.code(404);
      return { error: "unresolved DLQ entry not found" };
    }

    // The row itself is the audit log — discarded entries are never
    // deleted, just marked with who/why (no auth yet, so just the reason).
    await withTransaction(pool, (client) => markDlqEntryDiscarded(client, entry.id, reason));

    reply.code(200);
    return { id: entry.id, status: "discarded" };
  });
}
