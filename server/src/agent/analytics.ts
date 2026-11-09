import type { Dispute, Invoice, Transaction } from "../data/types.js";
import { round2 } from "../data/util.js";

export type GroupBy = "day" | "week" | "month" | "weekday" | "customer" | "product" | "kind";

export interface SummaryRow {
  group: string;
  orders: number;
  gross_sales: number;
  refunds: number;
  refund_rate_pct: number;
  fees: number;
  net: number;
}

function baseProduct(p: string) {
  return p.replace(/ ×\d+$/, "");
}

function groupKey(t: Transaction, by: GroupBy): string {
  const d = t.date.slice(0, 10);
  switch (by) {
    case "day":
      return d;
    case "week": {
      // ISO week starting Monday, labelled by its Monday date
      const dt = new Date(d + "T00:00:00Z");
      const dow = (dt.getUTCDay() + 6) % 7;
      return new Date(dt.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
    }
    case "month":
      return d.slice(0, 7);
    case "weekday":
      return ["0 Sun", "1 Mon", "2 Tue", "3 Wed", "4 Thu", "5 Fri", "6 Sat"][new Date(t.date).getUTCDay()];
    case "customer":
      return t.customer;
    case "product":
      return baseProduct(t.product);
    case "kind":
      return t.kind;
  }
}

/** Sales, refunds, refund rate, fees and net grouped by a dimension. Payouts are excluded. */
export function summarize(txns: Transaction[], by: GroupBy): SummaryRow[] {
  const map = new Map<string, SummaryRow>();
  const get = (k: string) => {
    let row = map.get(k);
    if (!row) {
      row = { group: k, orders: 0, gross_sales: 0, refunds: 0, refund_rate_pct: 0, fees: 0, net: 0 };
      map.set(k, row);
    }
    return row;
  };
  for (const t of txns) {
    if (t.status !== "completed") continue;
    if (t.kind === "payment") {
      const r = get(groupKey(t, by));
      r.orders += 1;
      r.gross_sales += t.amount;
      r.fees += t.fee;
      r.net += t.net;
    } else if (t.kind === "refund") {
      const r = get(groupKey(t, by));
      r.refunds += -t.amount;
      r.net += t.amount;
    }
  }
  const rows = [...map.values()].map((r) => ({
    ...r,
    gross_sales: round2(r.gross_sales),
    refunds: round2(r.refunds),
    fees: round2(r.fees),
    net: round2(r.net),
    refund_rate_pct: r.gross_sales ? round2((r.refunds / r.gross_sales) * 100) : 0,
  }));
  const timeBased = by === "day" || by === "week" || by === "month" || by === "weekday";
  return rows.sort((a, b) => (timeBased ? a.group.localeCompare(b.group) : b.gross_sales - a.gross_sales));
}

export interface DuplicateRow {
  customer: string;
  product: string;
  amount: number;
  first_charge_id: string;
  first_charge_time: string;
  duplicate_charge_id: string;
  duplicate_charge_time: string;
  minutes_apart: number;
  already_refunded: boolean;
}

/** Payments from the same buyer for the same amount within a short window. */
export function findDuplicates(txns: Transaction[], windowMinutes = 30): DuplicateRow[] {
  const refunded = new Set(txns.filter((t) => t.kind === "refund" && t.refundOf).map((t) => t.refundOf!));
  const pays = txns
    .filter((t) => t.kind === "payment" && t.status === "completed")
    .sort((a, b) => a.date.localeCompare(b.date));
  const out: DuplicateRow[] = [];
  for (let i = 0; i < pays.length; i++) {
    for (let j = i + 1; j < pays.length; j++) {
      const a = pays[i];
      const b = pays[j];
      const mins = (Date.parse(b.date) - Date.parse(a.date)) / 60_000;
      if (mins > windowMinutes) break;
      const sameBuyer = (a.customerEmail && a.customerEmail === b.customerEmail) || a.customer === b.customer;
      if (sameBuyer && a.amount === b.amount && baseProduct(a.product) === baseProduct(b.product)) {
        out.push({
          customer: a.customer,
          product: a.product,
          amount: a.amount,
          first_charge_id: a.id,
          first_charge_time: a.date,
          duplicate_charge_id: b.id,
          duplicate_charge_time: b.date,
          minutes_apart: Math.round(mins),
          already_refunded: refunded.has(b.id) || refunded.has(a.id),
        });
      }
    }
  }
  return out;
}

export function invoiceFilter(invoices: Invoice[], status: string) {
  const open = (i: Invoice) => ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED"].includes(i.status);
  switch (status) {
    case "open":
      return invoices.filter(open);
    case "overdue":
      return invoices.filter((i) => open(i) && i.daysOverdue > 0);
    case "paid":
      return invoices.filter((i) => ["PAID", "MARKED_AS_PAID"].includes(i.status));
    case "draft":
      return invoices.filter((i) => i.status === "DRAFT");
    default:
      return invoices;
  }
}

export function isOpenDispute(d: Dispute) {
  return !["RESOLVED", "CLOSED"].includes(d.status);
}

/** Facts for the morning brief, computed without AI so the numbers are always exact. */
export function briefFacts(input: { txns: Transaction[]; invoices: Invoice[]; disputes: Dispute[]; now?: Date }) {
  const now = input.now ?? new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  // Same calendar days of the previous month (e.g. Oct 1–9 when today is Nov 9).
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString();
  const prevEnd = new Date(Math.min(Date.parse(monthStart), Date.parse(prevStart) + (now.getTime() - Date.parse(monthStart)))).toISOString();

  const window = (s: string, e: string) => input.txns.filter((t) => t.date >= s && t.date < e);
  const thisPeriod = summarize(window(monthStart, now.toISOString()), "kind");
  const prevPeriod = summarize(window(prevStart, prevEnd), "kind");
  const total = (rows: SummaryRow[]) => rows.reduce((s, r) => s + r.gross_sales, 0);
  const salesNow = round2(total(thisPeriod));
  const salesPrev = round2(total(prevPeriod));

  const urgentDisputes = input.disputes
    .filter((d) => isOpenDispute(d) && d.daysLeftToRespond !== undefined && d.daysLeftToRespond <= 5)
    .sort((a, b) => (a.daysLeftToRespond ?? 99) - (b.daysLeftToRespond ?? 99));
  const overdue = invoiceFilter(input.invoices, "overdue");
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const dupes = findDuplicates(input.txns.filter((t) => t.date >= twoWeeksAgo)).filter((d) => !d.already_refunded);
  const byProduct = summarize(input.txns.filter((t) => t.date >= new Date(now.getTime() - 60 * 86_400_000).toISOString()), "product");
  const worstRefund = byProduct.filter((p) => p.orders >= 5).sort((a, b) => b.refund_rate_pct - a.refund_rate_pct)[0];

  return {
    month_to_date_sales: salesNow,
    same_period_last_month_sales: salesPrev,
    change_pct: salesPrev ? round2(((salesNow - salesPrev) / salesPrev) * 100) : null,
    urgent_disputes: urgentDisputes.map((d) => ({
      id: d.id,
      customer: d.customer,
      amount: d.amount,
      reason: d.reason,
      days_left: d.daysLeftToRespond,
    })),
    overdue_invoices: {
      count: overdue.length,
      total_due: round2(overdue.reduce((s, i) => s + i.amountDue, 0)),
      oldest_days_overdue: overdue.reduce((m, i) => Math.max(m, i.daysOverdue), 0),
    },
    possible_duplicate_charges: dupes.map((d) => ({
      customer: d.customer,
      amount: d.amount,
      duplicate_charge_id: d.duplicate_charge_id,
      minutes_apart: d.minutes_apart,
    })),
    highest_refund_rate_product:
      worstRefund && worstRefund.refund_rate_pct >= 10
        ? { product: worstRefund.group, refund_rate_pct: worstRefund.refund_rate_pct, orders: worstRefund.orders }
        : null,
    currency: input.txns[0]?.currency ?? "USD",
  };
}

export type BriefFacts = ReturnType<typeof briefFacts>;
