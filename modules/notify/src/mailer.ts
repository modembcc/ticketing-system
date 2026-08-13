import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ReservationFulfilledPayload {
  reservationId: string;
  customerId: string;
  seatIds: string[];
  amountCents: number;
}

export interface DomainEventEnvelope {
  id: string;
  aggregateType?: string;
  aggregateId?: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

// No real SMTP (anti-goal) — a plain RFC5322-ish text file stands in for
// "the email was sent," same fake-gateway philosophy as modules/payments.
export function composeEmail(event: DomainEventEnvelope): { fileName: string; contents: string } {
  const payload = event.payload as ReservationFulfilledPayload;
  const to = `${payload.customerId}@ticketing.invalid`;
  const amount = (payload.amountCents / 100).toFixed(2);

  const contents = [
    `From: Ticketing Saga Lab <no-reply@ticketing.invalid>`,
    `To: ${to}`,
    `Subject: Your reservation is confirmed`,
    `Message-Id: <${event.id}@ticketing.invalid>`,
    `Date: ${new Date(event.createdAt).toUTCString()}`,
    ``,
    `Your reservation ${payload.reservationId} is confirmed!`,
    ``,
    `Seats: ${payload.seatIds.join(", ")}`,
    `Amount charged: $${amount}`,
    ``,
    `Thanks for your purchase.`,
    ``,
  ].join("\r\n");

  return { fileName: `${event.id}.eml`, contents };
}

export async function writeEmailFile(mailDir: string, event: DomainEventEnvelope): Promise<string> {
  await mkdir(mailDir, { recursive: true });
  const { fileName, contents } = composeEmail(event);
  const filePath = path.join(mailDir, fileName);
  await writeFile(filePath, contents, "utf8");
  return filePath;
}
