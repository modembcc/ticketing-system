export type SeatStatus = "AVAILABLE" | "HELD" | "SOLD";

export interface Seat {
  id: string;
  eventId: string;
  label: string;
  status: SeatStatus;
  holdId: string | null;
  heldUntil: Date | null;
  version: number;
}
