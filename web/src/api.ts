export interface ActionStep {
  label: string;
  status?: "done" | "failed";
  result?: string;
}

export type ActionType = "refund" | "invoice_reminder" | "create_invoice" | "dispute_reply";

export interface Action {
  id: string;
  type: ActionType;
  title: string;
  reason: string;
  moneyOut?: { amount: number; currency: string };
  steps: ActionStep[];
  status: "pending" | "running" | "done" | "partly_done" | "failed" | "rejected";
  requestedBy: string;
  createdAt: string;
  decidedAt?: string;
}

export interface Answer {
  summary: string;
  table?: { title: string; columns: { field: string; header: string }[]; rows: Record<string, unknown>[] };
  chart?: { type: "bar" | "line" | "pie"; x: string; y: string[]; title: string };
  actions: Action[];
  trace: { tool: string; ok: boolean; note?: string }[];
  dataMode: "live" | "demo";
}

export interface Status {
  dataMode: "live" | "demo";
  aiReady: boolean;
  model: string;
}

export interface AttentionFacts {
  urgent_disputes: { id: string; customer: string; amount: number; reason: string; days_left: number }[];
  overdue_invoices: { count: number; total_due: number; oldest_days_overdue: number };
  possible_duplicate_charges: { customer: string; amount: number; duplicate_charge_id: string; minutes_apart: number }[];
  highest_refund_rate_product: { product: string; refund_rate_pct: number; orders: number } | null;
  month_to_date_sales: number;
  change_pct: number | null;
  currency: string;
}

export interface Brief {
  text: string;
  warnings?: string[];
  facts: AttentionFacts;
}

export interface Insight {
  id: string;
  tone: "warn" | "good" | "info";
  title: string;
  detail: string;
  ask: string;
}

export interface Overview {
  kpis: {
    currency: string;
    salesMtd: number;
    salesPrevMtd: number;
    salesChangePct: number | null;
    ordersMtd: number;
    netMtd: number;
    feesMtd: number;
    refundRate30: number;
    refundRatePrev30: number;
    owed: number;
    overdue: number;
    overdueCount: number;
    openInvoiceCount: number;
    disputesOpen: number;
    disputesDueSoon: number;
    nextDisputeDays: number | null;
  };
  series: { date: string; sales: number; refunds: number; net: number }[];
  topProducts: { product: string; orders: number; sales: number; refund_rate_pct: number; change_pct: number | null }[];
  insights: Insight[];
  attention: AttentionFacts;
  unavailable: string[];
  warnings: string[];
}

export interface Txn {
  date: string;
  id: string;
  kind: "payment" | "refund" | "payout" | "fee" | "other";
  customer: string;
  email: string;
  product: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  status: string;
  refundOf?: string;
  refunded: boolean;
}

export interface Invoice {
  id: string;
  number: string;
  status: string;
  customer: string;
  customerEmail: string;
  amount: number;
  amountDue: number;
  currency: string;
  issueDate: string;
  dueDate: string;
  daysOverdue: number;
  lastReminder?: string;
}

export interface Dispute {
  id: string;
  createdAt: string;
  status: string;
  reason: string;
  amount: number;
  currency: string;
  customer: string;
  transactionId?: string;
  responseDueDate?: string;
  daysLeftToRespond?: number;
  product?: string;
  orderDate?: string;
  messages?: { from: "buyer" | "seller"; text: string; at: string }[];
}

export interface InvoiceDraft {
  customer_name: string;
  customer_email: string;
  currency: string;
  items: { name: string; quantity: number; unit_amount: number }[];
  due_in_days: number;
  note: string;
  missing: string[];
}

export type ProposeTool = "propose_refunds" | "propose_invoice_reminders" | "propose_new_invoice" | "propose_dispute_reply";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  status: () => call<Status>("/api/status"),
  overview: () => call<Overview>("/api/overview"),
  brief: (lang: string) => call<Brief>(`/api/brief?lang=${encodeURIComponent(lang)}`),
  transactions: (days: number) => call<Txn[]>(`/api/transactions?days=${days}`),
  invoices: () => call<Invoice[]>("/api/invoices"),
  disputes: () => call<Dispute[]>("/api/disputes"),
  ask: (question: string, history: { role: "user" | "assistant"; text: string }[]) => call<Answer>("/api/ask", post({ question, history })),
  invoiceDraft: (text: string) => call<InvoiceDraft>("/api/ai/invoice-draft", post({ text })),
  disputeReply: (disputeId: string, note?: string) => call<{ message: string }>("/api/ai/dispute-reply", post({ disputeId, note })),
  actions: () => call<Action[]>("/api/actions"),
  propose: (tool: ProposeTool, input: unknown, source: string) => call<Action>("/api/actions/propose", post({ tool, input, source })),
  approve: (id: string) => call<Action>(`/api/actions/${id}/approve`, { method: "POST" }),
  reject: (id: string) => call<Action>(`/api/actions/${id}/reject`, { method: "POST" }),
  resetDemo: () => call<{ ok: boolean }>("/api/demo/reset", { method: "POST" }),
};
