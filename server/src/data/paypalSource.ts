import { paypal } from "../paypal/client.js";
import type { DataSource, Dispute, Invoice, InvoiceStatus, NewInvoiceInput, Transaction, TxnKind } from "./types.js";
import { daysBetween, round2, todayISO } from "./util.js";

/**
 * Reads and acts on a real PayPal (sandbox) account through the REST APIs:
 *  - Transaction Search  GET  /v1/reporting/transactions
 *  - Invoicing v2        GET  /v2/invoicing/invoices, POST .../remind, .../send
 *  - Disputes            GET  /v1/customer/disputes
 *  - Payments v2         POST /v2/payments/captures/{id}/refund
 */
export class PayPalSource implements DataSource {
  readonly mode = "live" as const;

  async listTransactions(range: { start: string; end: string }): Promise<Transaction[]> {
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
            fields: "transaction_info,payer_info,cart_info",
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

  async refundPayment(input: { transactionId: string; amount?: number; currency?: string; note?: string }) {
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

function mapTransaction(d: any): Transaction {
  const ti = d.transaction_info ?? {};
  const pi = d.payer_info ?? {};
  const amount = Number(ti.transaction_amount?.value ?? 0);
  const fee = Math.abs(Number(ti.fee_amount?.value ?? 0));
  const code: string = ti.transaction_event_code ?? "";
  const name =
    pi.payer_name?.alternate_full_name ||
    [pi.payer_name?.given_name, pi.payer_name?.surname].filter(Boolean).join(" ") ||
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
