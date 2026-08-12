export class PaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`payment ${paymentId} not found`);
    this.name = "PaymentNotFoundError";
  }
}
