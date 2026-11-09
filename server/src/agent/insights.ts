import type { Dispute, Invoice, Transaction } from "../data/types.js";
import { round2 } from "../data/util.js";
import { invoiceFilter, isOpenDispute, summarize } from "./analytics.js";

/** Everything the Overview screen shows. All numbers are computed here, never by the model. */

const DAY = 86_400_000;

function inRange(txns: Transaction[], start: number, end: number) {
  return txns.filter((t) => {
    const ms = Date.parse(t.date);
    return ms >= start && ms < end;
  });
}

function totals(txns: Transaction[]) {
  let sales = 0;
  let refunds = 0;
  let fees = 0;
  let orders = 0;
  for (const t of txns) {
    if (t.status !== "completed") continue;
    if (t.kind === "payment") {
      sales += t.amount;
      fees += t.fee;
      orders++;
    } else if (t.kind === "refund") refunds += -t.amount;
  }
  return {
    sales: round2(sales),
    refunds: round2(refunds),
    fees: round2(fees),
    orders,
    net: round2(sales - refunds - fees),
    refundRate: sales ? round2((refunds / sales) * 100) : 0,
  };
}

const pct = (now: number, prev: number) => (prev ? round2(((now - prev) / prev) * 100) : null);

export interface Insight {
  id: string;
  tone: "warn" | "good" | "info";
  title: string;
  detail: string;
  ask: string;
}

export function buildOverview(input: { txns: Transaction[]; invoices: Invoice[]; disputes: Dispute[]; now?: Date }) {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const currency = input.txns[0]?.currency ?? input.invoices[0]?.currency ?? "USD";

  // Month to date vs the same calendar days of last month.
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const prevStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const prevEnd = Math.min(monthStart, prevStart + (nowMs - monthStart));
  const mtd = totals(inRange(input.txns, monthStart, nowMs + 1));
  const prevMtd = totals(inRange(input.txns, prevStart, prevEnd));

  const last30 = totals(inRange(input.txns, nowMs - 30 * DAY, nowMs + 1));
  const prev30 = totals(inRange(input.txns, nowMs - 60 * DAY, nowMs - 30 * DAY));

  const open = invoiceFilter(input.invoices, "open");
  const overdue = invoiceFilter(input.invoices, "overdue");
  const openDisputes = input.disputes.filter(isOpenDispute);
  const dueSoon = openDisputes.filter((d) => d.daysLeftToRespond !== undefined && d.daysLeftToRespond <= 5);

  const kpis = {
    currency,
    salesMtd: mtd.sales,
    salesPrevMtd: prevMtd.sales,
    salesChangePct: pct(mtd.sales, prevMtd.sales),
    ordersMtd: mtd.orders,
    netMtd: mtd.net,
    feesMtd: mtd.fees,
    refundRate30: last30.refundRate,
    refundRatePrev30: prev30.refundRate,
    owed: round2(open.reduce((s, i) => s + i.amountDue, 0)),
    overdue: round2(overdue.reduce((s, i) => s + i.amountDue, 0)),
    overdueCount: overdue.length,
    openInvoiceCount: open.length,
    disputesOpen: openDisputes.length,
    disputesDueSoon: dueSoon.length,
    nextDisputeDays: dueSoon.reduce<number | null>((m, d) => (m === null || d.daysLeftToRespond! < m ? d.daysLeftToRespond! : m), null),
  };

  // Daily series for the last 60 days, with empty days filled in.
  const series: { date: string; sales: number; refunds: number; net: number }[] = [];
  const byDay = new Map(summarize(inRange(input.txns, nowMs - 60 * DAY, nowMs + 1), "day").map((r) => [r.group, r]));
  for (let d = 59; d >= 0; d--) {
    const key = new Date(nowMs - d * DAY).toISOString().slice(0, 10);
    const r = byDay.get(key);
    series.push({ date: key, sales: r?.gross_sales ?? 0, refunds: r?.refunds ?? 0, net: r ? round2(r.gross_sales - r.refunds - r.fees) : 0 });
  }

  // Products: last 30 days with growth against the 30 days before.
  const prodNow = summarize(inRange(input.txns, nowMs - 30 * DAY, nowMs + 1), "product");
  const prodPrev = new Map(summarize(inRange(input.txns, nowMs - 60 * DAY, nowMs - 30 * DAY), "product").map((r) => [r.group, r]));
  const topProducts = prodNow.map((r) => ({
    product: r.group,
    orders: r.orders,
    sales: r.gross_sales,
    refund_rate_pct: r.refund_rate_pct,
    change_pct: pct(r.gross_sales, prodPrev.get(r.group)?.gross_sales ?? 0),
  }));

  return { kpis, series, topProducts, insights: insights(input.txns, nowMs, currency, last30) };
}

function insights(txns: Transaction[], nowMs: number, c: string, last30: ReturnType<typeof totals>): Insight[] {
  const out: Insight[] = [];
  const money = (n: number) => `${c} ${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

  // 1. A product refunded far more often than the rest.
  const p60 = summarize(inRange(txns, nowMs - 60 * DAY, nowMs + 1), "product").filter((r) => r.orders >= 5);
  const worst = [...p60].sort((a, b) => b.refund_rate_pct - a.refund_rate_pct)[0];
  if (worst) {
    const rest = p60.filter((r) => r !== worst);
    const restSales = rest.reduce((s, r) => s + r.gross_sales, 0);
    const restRate = restSales ? round2((rest.reduce((s, r) => s + r.refunds, 0) / restSales) * 100) : 0;
    if (worst.refund_rate_pct >= 10 && worst.refund_rate_pct >= restRate * 2) {
      out.push({
        id: "refund-outlier",
        tone: "warn",
        title: `${worst.group} is refunded ${Math.round(worst.refund_rate_pct)}% of the time`,
        detail: `Other products average ${Math.round(restRate)}%. That's ${money(worst.refunds)} refunded in the last 60 days.`,
        ask: `Why is the ${worst.group} refunded so often, and what should I do about it?`,
      });
    }
  }

  // 2. Fastest-growing product.
  const now30 = summarize(inRange(txns, nowMs - 30 * DAY, nowMs + 1), "product");
  const prev30 = new Map(summarize(inRange(txns, nowMs - 60 * DAY, nowMs - 30 * DAY), "product").map((r) => [r.group, r.gross_sales]));
  const growth = now30
    .filter((r) => (prev30.get(r.group) ?? 0) > 0 && r.orders >= 5)
    .map((r) => ({ r, g: pct(r.gross_sales, prev30.get(r.group)!)! }))
    .sort((a, b) => b.g - a.g)[0];
  if (growth && growth.g >= 15) {
    out.push({
      id: "growth",
      tone: "good",
      title: `${growth.r.group} sales are up ${Math.round(growth.g)}%`,
      detail: `${money(growth.r.gross_sales)} in the last 30 days from ${growth.r.orders} orders.`,
      ask: `How have ${growth.r.group} sales grown week by week?`,
    });
  }

  // 3. Best repeat customer.
  const cust = summarize(inRange(txns, nowMs - 90 * DAY, nowMs + 1), "customer").filter((r) => r.orders >= 3);
  const best = cust[0];
  if (best) {
    out.push({
      id: "repeat",
      tone: "info",
      title: `${best.group} has ordered ${best.orders} times`,
      detail: `${money(best.gross_sales)} in the last 90 days, your top repeat customer. ${cust.length} customers have ordered 3 or more times.`,
      ask: "Who are my best repeat customers in the last 90 days?",
    });
  }

  // 4. Fees.
  if (last30.sales > 0) {
    out.push({
      id: "fees",
      tone: "info",
      title: `PayPal fees were ${money(last30.fees)} in the last 30 days`,
      detail: `That's ${round2((last30.fees / last30.sales) * 100)}% of ${money(last30.sales)} in sales.`,
      ask: "How much have I paid in PayPal fees each month?",
    });
  }

  // 5. Busiest weekday.
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const counts = new Array(7).fill(0);
  for (const t of inRange(txns, nowMs - 60 * DAY, nowMs + 1)) if (t.kind === "payment") counts[new Date(t.date).getUTCDay()]++;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total >= 20) {
    const top = counts.indexOf(Math.max(...counts));
    out.push({
      id: "weekday",
      tone: "info",
      title: `${days[top]} is your busiest day`,
      detail: `${Math.round((counts[top] / total) * 100)}% of the last 60 days' orders came in on a ${days[top]}.`,
      ask: "Which days of the week do I get the most orders?",
    });
  }
  return out;
}
