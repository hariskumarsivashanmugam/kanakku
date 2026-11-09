// Normalized shapes the agent works with, whether data comes from PayPal or the demo store.

export type TxnKind = "payment" | "refund" | "payout" | "fee" | "other";

export interface Transaction {
  id: string; // for payments this is the PayPal capture id (used for refunds)
  date: string; // ISO timestamp
  kind: TxnKind;
  status: "completed" | "pending" | "reversed" | "denied";
  amount: number; // signed: refunds and payouts are negative
  fee: number; // PayPal fee (positive number)
  net: number;
  currency: string;
  customer: string;
  customerEmail: string;
  product: string;
  invoiceId?: string;
  refundOf?: string; // for refunds: the payment id that was refunded
}

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PAYMENT_PENDING";

export interface Invoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  customer: string;
  customerEmail: string;
  amount: number;
  amountDue: number;
  currency: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  daysOverdue: number; // 0 if not overdue
  lastReminder?: string;
}

export interface Dispute {
  id: string;
  createdAt: string;
  status: string; // e.g. WAITING_FOR_SELLER_RESPONSE, UNDER_REVIEW, RESOLVED
  reason: string; // e.g. MERCHANDISE_OR_SERVICE_NOT_RECEIVED
  amount: number;
  currency: string;
  customer: string;
  transactionId?: string;
  responseDueDate?: string; // ISO
  daysLeftToRespond?: number;
  product?: string;
  orderDate?: string;
  messages?: { from: "buyer" | "seller"; text: string; at: string }[];
}

export interface RefundResult {
  refundId: string;
  status: string;
  amount: number;
  currency: string;
}

export interface NewInvoiceInput {
  customerName: string;
  customerEmail: string;
  currency: string;
  items: { name: string; quantity: number; unitAmount: number }[];
  note?: string;
  dueInDays?: number;
}

/** Everything the agent can read from or do to a seller's account. */
export interface DataSource {
  readonly mode: "live" | "demo";
  listTransactions(range: { start: string; end: string }): Promise<Transaction[]>;
  listInvoices(): Promise<Invoice[]>;
  listDisputes(): Promise<Dispute[]>;
  refundPayment(input: {
    transactionId: string;
    amount?: number;
    currency?: string;
    note?: string;
  }): Promise<RefundResult>;
  remindInvoice(input: { invoiceId: string; subject?: string; note?: string }): Promise<{ invoiceId: string; status: string }>;
  createAndSendInvoice(input: NewInvoiceInput): Promise<{ invoiceId: string; number: string; status: string; link?: string }>;
  sendDisputeMessage(input: { disputeId: string; message: string }): Promise<{ disputeId: string; status: string }>;
}
