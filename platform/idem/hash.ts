import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// Sorted-keys JSON so the same logical request body hashes identically
// regardless of property order.
export function hashRequestBody(body: unknown): string {
  const json = JSON.stringify(canonicalize(body));
  return createHash("sha256").update(json).digest("hex");
}
