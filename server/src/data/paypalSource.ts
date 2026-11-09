import { config } from "../config.js";
import { paypal } from "../paypal/client.js";
import { addToLedger, readLedger } from "./ledger.js";
import type { DataSource, Dispute, Invoice, InvoiceStatus, NewInvoiceInput, Transaction, TxnKind } from "./types.js";
import { daysBetween, round2, todayISO } from "./util.js";

/**
 * Reads and acts on a real PayPal (sandbox) account through the REST APIs:
 *  - Transaction Search  GET  /v1/reporting/transactions
 *  - Orders v2           GET  /v2/checkout/orders/{id}   (orders this shop created; see ledger.ts)
 *  - Invoicing v2        GET  /v2/invoicing/invoices, POST .../remind, .../send
 *  - Disputes            GET  /v1/customer/disputes
 *  - Payments v2         POST /v2/payments/captures/{id}/refund
 */
export class PayPalSource implements DataSource {
  readonly mode = "live" as const;

  private orderCache = new Map<string, { at: number; txns: Transaction[] }>();

  /**
   * Sales come from two places, merged by transaction id:
   *  1. Transaction Search, PayPal's full history. It needs the "Transaction search" app feature and lists
   *     new sandbox payments only after a delay of up to a few hours.
   *  2. The orders this shop created, read live from the Orders API. Works immediately.
   */
  async listTransactions(range: { start: string; end: string }): Promise<Transaction[]> {
    const [search, orders] = await Promise.allSettled([this.searchTransactions(range), this.ledgerTransactions(range)]);
    const fromOrders = orders.status === "fulfilled" ? orders.value : [];
    if (search.status === "rejected" && fromOrders.length === 0) throw search.reason;
    const byId = new Map<string, Transaction>();
    for (const t of fromOrders) byId.set(t.id, t);
    // Transaction Search has richer data (payer emails, exact fees), so it wins when both have a transaction.
    if (search.status === "fulfilled") for (const t of search.value) byId.set(t.id, { ...byId.get(t.id), ...t, product: t.product !== "—" ? t.product : byId.get(t.id)?.product ?? t.product, customer: t.customer !== "Unknown" ? t.customer : byId.get(t.id)?.customer ?? t.customer });
    return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
  }

  private async ledgerTransactions(range: { start: string; end: string }): Promise<Transaction[]> {
    const ids = readLedger(config.paypal.baseUrl, config.paypal.clientId);
    const out: Transaction[] = [];
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        const cached = this.orderCache.get(id);
        if (cached && Date.now() - cached.at < 60_000) {
          out.push(...cached.txns);
          continue;
        }
        try {
          const order = await paypal<any>({ path: `/v2/checkout/orders/${encodeURIComponent(id)}` });
          const txns = mapOrder(order);
          this.orderCache.set(id, { at: Date.now(), txns });
          out.push(...txns);
        } catch {
          /* an order we can't read is skipped */
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
    return out.filter((t) => t.date >= range.start && t.date <= range.end);
  }

  /** Forget cached orders, e.g. after a webhook says something changed. */
  clearCache() {
    this.orderCache.clear();
  }

  /** Remembers orders created outside Transaction Search's reach (e.g. by the seed script). */
  rememberOrders(orderIds: string[]) {
    addToLedger(config.paypal.baseUrl, config.paypal.clientId, orderIds);
  }

  private async searchTransactions(range: { start: string; end: string }): Promise<Transaction[]> {
    const out: Transaction[] = [];
    // Transaction Search allows at most 31 days per request.
    for (const [start, end] of splitRange(range.start, range.end, 30)) {
      let page = 1;
      let totalPages = 1;
      do {
        const res = await paypal<any>({
          path: "/v1/reporting/transactions",
          query: {
            start_date: start,
            end_date: end,
            fields: "transaction_info,payer_info,cart_info,shipping_info",
            page_size: 500,
            page,
          },
        });
        totalPages = res.total_pages ?? 1;
        for (const d of res.transaction_details ?? []) out.push(mapTransaction(d));
        page++;
      } while (page <= totalPages && page <= 20);
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  async listInvoices(): Promise<Invoice[]> {
    const out: Invoice[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const res = await paypal<any>({
        path: "/v2/invoicing/invoices",
        query: { page, page_size: 100, total_required: "true" },
      });
      totalPages = res.total_pages ?? 1;
      for (const inv of res.items ?? []) out.push(mapInvoice(inv));
      page++;
    } while (page <= totalPages && page <= 10);
    return out;
  }

  async listDisputes(): Promise<Dispute[]> {
    const res = await paypal<any>({ path: "/v1/customer/disputes", query: { page_size: 50 } });
    const items: any[] = res.items ?? [];
    // The list endpoint has no buyer details, so fetch details for the first few open ones.
    const detailed = await Promise.all(
      items.slice(0, 15).map((d) =>
        paypal<any>({ path: `/v1/customer/disputes/${d.dispute_id}` }).catch(() => d),
      ),
    );
    return detailed.concat(items.slice(15)).map(mapDispute);
  }

  async sendPayout(input: { email: string; name: string; amount: number; currency: string; note: string; reference: string }) {
    const res = await paypal<any>({
      method: "POST",
      path: "/v1/payments/payouts",
      idempotent: true,
      body: {
        sender_batch_header: {
          sender_batch_id: `${input.reference}-${Date.now()}`.slice(0, 127),
          email_subject: "You have a payment from Meena Prints",
          email_message: input.note.slice(0, 1000),
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: input.email,
            amount: { value: input.amount.toFixed(2), currency: input.currency },
            note: input.note.slice(0, 4000),
            sender_item_id: input.reference.slice(0, 63),
          },
        ],
      },
    });
    return { batchId: res.batch_header?.payout_batch_id, status: res.batch_header?.batch_status ?? "PENDING" };
  }

  /** Item status when there is one (SUCCESS, UNCLAIMED, PENDING, FAILED…), else the batch status. */
  async getPayoutStatus(batchId: string) {
    const res = await paypal<any>({ path: `/v1/payments/payouts/${encodeURIComponent(batchId)}` });
    return res.items?.[0]?.transaction_status ?? res.batch_header?.batch_status ?? "PENDING";
  }

  async addTracking(input: { transactionId: string; trackingNumber: string; carrier: string }) {
    const known = ["DHL", "FEDEX", "UPS", "USPS", "INDIA_POST", "BLUEDART", "DTDC", "ARAMEX", "ROYAL_MAIL"];
    const carrier = input.carrier.toUpperCase().replace(/[\s-]+/g, "_");
    const res = await paypal<any>({
      method: "POST",
      path: "/v1/shipping/trackers-batch",
      body: {
        trackers: [
          {
            transaction_id: input.transactionId,
            tracking_number: input.trackingNumber,
            status: "SHIPPED",
            carrier: known.includes(carrier) ? carrier : "OTHER",
            ...(known.includes(carrier) ? {} : { carrier_name_other: input.carrier }),
          },
        ],
      },
    });
    const err = res.errors?.[0];
    if (err) throw new Error(`PayPal didn't accept the tracking number: ${err.message ?? err.name}`);
    return { status: "SHIPPED" };
  }

  async sendDisputeMessage(input: { disputeId: string; message: string }) {
    await paypal({
      method: "POST",
      path: `/v1/customer/disputes/${encodeURIComponent(input.disputeId)}/send-message`,
      body: { message: input.message.slice(0, 2000) },
      idempotent: true,
    });
    return { disputeId: input.disputeId, status: "MESSAGE_SENT" };
  }

  async refundPayment(input: { transactionId: string; amount?: number; currency?: string; note?: string }) {
    this.orderCache.clear();
    const body: Record<string, unknown> = {};
    if (input.amount !== undefined) {
      body.amount = { value: input.amount.toFixed(2), currency_code: input.currency ?? "USD" };
    }
    if (input.note) body.note_to_payer = input.note.slice(0, 255);
    const res = await paypal<any>({
      method: "POST",
      path: `/v2/payments/captures/${encodeURIComponent(input.transactionId)}/refund`,
      body,
      idempotent: true,
      headers: { Prefer: "return=representation" },
    });
    return {
      refundId: res.id,
      status: res.status,
      amount: Number(res.amount?.value ?? input.amount ?? 0),
      currency: res.amount?.currency_code ?? input.currency ?? "USD",
    };
  }

  async remindInvoice(input: { invoiceId: string; subject?: string; note?: string }) {
    await paypal({
      method: "POST",
      path: `/v2/invoicing/invoices/${encodeURIComponent(input.invoiceId)}/remind`,
      body: {
        subject: input.subject ?? "Friendly payment reminder",
        note: input.note ?? "Just a reminder that this invoice is due. Thank you!",
        send_to_invoicer: false,
        send_to_recipient: true,
      },
      idempotent: true,
    });
    return { invoiceId: input.invoiceId, status: "REMINDER_SENT" };
  }

  async createAndSendInvoice(input: NewInvoiceInput) {
    const [given, ...rest] = input.customerName.trim().split(/\s+/);
    const due = new Date(Date.now() + (input.dueInDays ?? 14) * 86_400_000).toISOString().slice(0, 10);
    const draft = await paypal<any>({
      method: "POST",
      path: "/v2/invoicing/invoices",
      headers: { Prefer: "return=representation" },
      idempotent: true,
      body: {
        detail: {
          currency_code: input.currency,
          note: input.note,
          payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: due },
        },
        primary_recipients: [
          {
            billing_info: {
              name: { given_name: given, surname: rest.join(" ") || undefined },
              email_address: input.customerEmail,
            },
          },
        ],
        items: input.items.map((it) => ({
          name: it.name,
          quantity: String(it.quantity),
          unit_amount: { currency_code: input.currency, value: it.unitAmount.toFixed(2) },
        })),
      },
    });
    const id: string = draft.id ?? String(draft.href ?? "").split("/").pop();
    const sent = await paypal<any>({
      method: "POST",
      path: `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
      body: { send_to_invoicer: false, send_to_recipient: true },
      idempotent: true,
    });
    return {
      invoiceId: id,
      number: draft.detail?.invoice_number ?? id,
      status: "SENT",
      link: sent?.href,
    };
  }
}

// ---------- mapping helpers ----------

/** One Orders API order → its payment plus any refunds against it. */
function mapOrder(o: any): Transaction[] {
  const pu = o.purchase_units?.[0] ?? {};
  const cap = pu.payments?.captures?.[0];
  if (!cap) return [];
  const items: any[] = pu.items ?? [];
  const product =
    items.map((i) => (Number(i.quantity) > 1 ? `${i.name} ×${i.quantity}` : i.name)).join(", ") || pu.description || "—";
  const ps = o.payment_source ?? {};
  const customer =
    pu.shipping?.name?.full_name ||
    [o.payer?.name?.given_name, o.payer?.name?.surname].filter(Boolean).join(" ") ||
    ps.card?.name ||
    [ps.paypal?.name?.given_name, ps.paypal?.name?.surname].filter(Boolean).join(" ") ||
    "Unknown";
  const email = o.payer?.email_address || ps.paypal?.email_address || "";
  const amount = Number(cap.amount?.value ?? 0);
  const fee = Number(cap.seller_receivable_breakdown?.paypal_fee?.value ?? 0);
  const currency = cap.amount?.currency_code ?? "USD";
  const status: Transaction["status"] = ["COMPLETED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(cap.status)
    ? "completed"
    : cap.status === "PENDING"
      ? "pending"
      : "denied";
  const out: Transaction[] = [
    {
      id: cap.id,
      date: cap.create_time ?? o.create_time,
      kind: "payment",
      status,
      amount,
      fee,
      net: round2(amount - fee),
      currency,
      customer,
      customerEmail: email,
      product,
    },
  ];
  for (const r of pu.payments?.refunds ?? []) {
    if (r.status !== "COMPLETED") continue;
    const v = Number(r.amount?.value ?? 0);
    out.push({
      id: r.id,
      date: r.create_time ?? cap.create_time,
      kind: "refund",
      status: "completed",
      amount: -v,
      fee: 0,
      net: -v,
      currency: r.amount?.currency_code ?? currency,
      customer,
      customerEmail: email,
      product,
      refundOf: cap.id,
    });
  }
  return out;
}

function mapTransaction(d: any): Transaction {
  const ti = d.transaction_info ?? {};
  const pi = d.payer_info ?? {};
  const amount = Number(ti.transaction_amount?.value ?? 0);
  const fee = Math.abs(Number(ti.fee_amount?.value ?? 0));
  const code: string = ti.transaction_event_code ?? "";
  // Card payments often have no payer account, so fall back to the shipping name.
  const name =
    pi.payer_name?.alternate_full_name ||
    [pi.payer_name?.given_name, pi.payer_name?.surname].filter(Boolean).join(" ") ||
    d.shipping_info?.name ||
    pi.email_address ||
    "Unknown";
  const items: any[] = d.cart_info?.item_details ?? [];
  return {
    id: ti.transaction_id,
    date: ti.transaction_initiation_date,
    kind: kindFromCode(code, amount),
    status: ({ S: "completed", P: "pending", V: "reversed", D: "denied" } as const)[ti.transaction_status as "S"] ?? "completed",
    amount,
    fee,
    net: round2(amount - fee),
    currency: ti.transaction_amount?.currency_code ?? "USD",
    customer: name,
    customerEmail: pi.email_address ?? "",
    product: items.map((i) => i.item_name).filter(Boolean).join(", ") || ti.transaction_subject || ti.transaction_note || "—",
    invoiceId: ti.invoice_id,
    refundOf: code.startsWith("T11") ? ti.paypal_reference_id : undefined,
  };
}

/** PayPal transaction event codes: T11xx are reversals/refunds, T00xx–T03xx are payments. */
function kindFromCode(code: string, amount: number): TxnKind {
  if (code.startsWith("T11")) return "refund";
  if (code.startsWith("T01")) return "fee";
  if (/^T0[0-3]/.test(code)) return amount < 0 ? "payout" : "payment";
  return amount < 0 ? "payout" : "other";
}

function mapInvoice(inv: any): Invoice {
  const r = inv.primary_recipients?.[0]?.billing_info ?? {};
  const name = r.name?.full_name || [r.name?.given_name, r.name?.surname].filter(Boolean).join(" ") || r.email_address || "Unknown";
  const due = inv.detail?.payment_term?.due_date ?? inv.detail?.invoice_date ?? todayISO();
  const status = inv.status as InvoiceStatus;
  const open = ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED"].includes(status);
  const overdue = open ? Math.max(0, daysBetween(due, todayISO())) : 0;
  return {
    id: inv.id,
    number: inv.detail?.invoice_number ?? inv.id,
    status,
    customer: name,
    customerEmail: r.email_address ?? "",
    amount: Number(inv.amount?.value ?? 0),
    amountDue: Number(inv.due_amount?.value ?? (open ? inv.amount?.value : 0) ?? 0),
    currency: inv.amount?.currency_code ?? inv.detail?.currency_code ?? "USD",
    issueDate: inv.detail?.invoice_date ?? "",
    dueDate: due,
    daysOverdue: overdue,
  };
}

function mapDispute(d: any): Dispute {
  const tx = d.disputed_transactions?.[0];
  const due: string | undefined = d.seller_response_due_date;
  return {
    id: d.dispute_id,
    createdAt: d.create_time,
    status: d.status,
    reason: d.reason,
    amount: Number(d.dispute_amount?.value ?? 0),
    currency: d.dispute_amount?.currency_code ?? "USD",
    customer: tx?.buyer?.name ?? tx?.buyer?.email ?? "Unknown",
    transactionId: tx?.seller_transaction_id,
    responseDueDate: due,
    daysLeftToRespond: due ? daysBetween(todayISO(), due.slice(0, 10)) : undefined,
    product: tx?.items?.map((i: any) => i.item_name).filter(Boolean).join(", ") || undefined,
    orderDate: tx?.seller_transaction_id ? tx?.create_time : undefined,
    messages: (d.messages ?? []).map((m: any) => ({
      from: m.posted_by === "SELLER" ? ("seller" as const) : ("buyer" as const),
      text: m.content ?? "",
      at: m.time_posted ?? "",
    })),
  };
}

function splitRange(start: string, end: string, maxDays: number): [string, string][] {
  const out: [string, string][] = [];
  let s = new Date(start).getTime();
  const e = new Date(end).getTime();
  while (s < e) {
    const chunkEnd = Math.min(e, s + maxDays * 86_400_000);
    out.push([toPayPalDate(s), toPayPalDate(chunkEnd)]);
    s = chunkEnd;
  }
  return out;
}

function toPayPalDate(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
