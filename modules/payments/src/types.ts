export type PaymentStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED";

export interface Payment {
  id: string;
  reservationId: string;
  status: PaymentStatus;
  amountCents: number;
  providerRef: string;
  confirmedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
