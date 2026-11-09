import { z } from "zod";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { getSource } from "../data/index.js";
import type { Transaction } from "../data/types.js";
import { round2 } from "../data/util.js";
import { findDuplicates, invoiceFilter, isOpenDispute, summarize, type GroupBy } from "./analytics.js";
import { addAction, saveDataset, type Action } from "./store.js";

/**
 * Tools Claude can call. Read tools fetch real data and save it as a dataset the UI can show.
 * "propose_*" tools never move money: they create a pending action the seller must approve.
 */

const dateRange = {
  start_date: z.string().describe("Start date, YYYY-MM-DD (inclusive)"),
  end_date: z.string().describe("End date, YYYY-MM-DD (inclusive)"),
};

const schemas = {
  search_transactions: z.object({
    ...dateRange,
    kind: z.enum(["payment", "refund", "payout", "all"]).default("all"),
    customer: z.string().optional().describe("Case-insensitive match on customer name or email"),
    product: z.string().optional().describe("Case-insensitive match on product name"),
    min_amount: z.number().optional(),
  }),
  summarize_transactions: z.object({
    ...dateRange,
    group_by: z.enum(["day", "week", "month", "weekday", "customer", "product", "kind"]),
  }),
  find_duplicate_charges: z.object({
    ...dateRange,
    window_minutes: z.number().default(30),
  }),
  list_invoices: z.object({
    status: z.enum(["open", "overdue", "paid", "draft", "all"]).default("all"),
    customer: z.string().optional(),
  }),
  list_disputes: z.object({
    open_only: z.boolean().default(true),
  }),
  propose_refunds: z.object({
    refunds: z
      .array(
        z.object({
          transaction_id: z.string().describe("Id of the PAYMENT to refund (from a tool result, never invented)"),
          amount: z.number().optional().describe("Partial refund amount; omit for a full refund"),
        }),
      )
      .min(1),
    reason: z.string().describe("Why, in the seller's language; shown on the approval card"),
    note_to_buyer: z.string().optional(),
  }),
  propose_invoice_reminders: z.object({
    invoice_ids: z.array(z.string()).min(1),
    reason: z.string(),
    note: z.string().optional().describe("Polite note to the customer, in English unless the seller asks otherwise"),
  }),
  propose_new_invoice: z.object({
    customer_name: z.string(),
    customer_email: z.string().email(),
    currency: z.string().length(3).default("USD"),
    items: z.array(z.object({ name: z.string(), quantity: z.number().positive(), unit_amount: z.number().positive() })).min(1),
    note: z.string().optional(),
    due_in_days: z.number().int().positive().default(14),
    reason: z.string(),
  }),
  propose_dispute_reply: z.object({
    dispute_id: z.string(),
    message: z.string().min(10).max(2000).describe("The reply to the buyer, in English, polite and specific"),
    reason: z.string(),
  }),
  present_answer: z.object({
    summary: z.string().describe("Short answer for the seller in THEIR language, 1-4 sentences, markdown allowed"),
    dataset_id: z.string().optional().describe("Dataset to show in the grid"),
    columns: z
      .array(z.object({ field: z.string(), header: z.string() }))
      .optional()
      .describe("Which dataset fields to show and their headers (translated if the seller wrote in another language)"),
    chart: z
      .object({
        type: z.enum(["bar", "line", "pie"]),
        x: z.string().describe("Dataset field for categories / time"),
        y: z.array(z.string()).min(1).max(3).describe("Numeric dataset fields"),
        title: z.string(),
      })
      .optional(),
  }),
};

export type ToolName = keyof typeof schemas;

const descriptions: Record<ToolName, string> = {
  search_transactions:
    "List individual transactions (payments, refunds, bank payouts) in a date range, with optional filters. Returns a dataset_id and a preview.",
  summarize_transactions:
    "Exact totals grouped by day, week, month, weekday, customer, product or kind: orders, gross_sales, refunds, refund_rate_pct, fees, net. Use this for any totals or comparisons instead of adding numbers yourself.",
  find_duplicate_charges: "Find likely accidental duplicate charges: same buyer, same amount and product, minutes apart.",
  list_invoices: "List invoices. status 'overdue' = sent but unpaid past the due date.",
  list_disputes: "List PayPal disputes/claims with reason, amount and days left to respond.",
  propose_refunds:
    "Prepare refunds for the seller to approve. Does NOT refund anything by itself; the seller sees a confirmation card.",
  propose_invoice_reminders:
    "Prepare payment reminders for open invoices, for the seller to approve. Does NOT send anything by itself.",
  propose_new_invoice: "Prepare a new invoice to create and send, for the seller to approve. Does NOT send anything by itself.",
  propose_dispute_reply:
    "Prepare a reply to the buyer on a dispute, for the seller to approve. Does NOT send anything by itself.",
  present_answer:
    "ALWAYS call this last, exactly once, to show the answer: a short summary plus optionally a dataset in the grid and a chart.",
};

export const toolDefinitions: Tool[] = (Object.keys(schemas) as ToolName[]).map((name) => ({
  name,
  description: descriptions[name],
  input_schema: zodToJsonSchema(schemas[name]) as Tool["input_schema"],
}));

// zod v3 has no built-in JSON Schema export, so convert the small subset we use.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;
  const withDesc = (o: Record<string, unknown>) => (schema.description ? { ...o, description: schema.description } : o);
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as z.ZodObject<any>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape) as [string, z.ZodTypeAny][]) {
        properties[k] = zodToJsonSchema(v);
        if (!v.isOptional() && v._def.typeName !== "ZodDefault") required.push(k);
      }
      return withDesc({ type: "object", properties, required });
    }
    case "ZodString":
      return withDesc({ type: "string" });
    case "ZodNumber":
      return withDesc({ type: "number" });
    case "ZodBoolean":
      return withDesc({ type: "boolean" });
    case "ZodEnum":
      return withDesc({ type: "string", enum: def.values });
    case "ZodArray":
      return withDesc({ type: "array", items: zodToJsonSchema(def.type) });
    case "ZodOptional":
      return { ...zodToJsonSchema(def.innerType), ...(schema.description ? { description: schema.description } : {}) };
    case "ZodDefault":
      return { ...zodToJsonSchema(def.innerType), default: def.defaultValue(), ...(schema.description ? { description: schema.description } : {}) };
    default:
      return {};
  }
}

// ---------------- execution ----------------

export interface ToolContext {
  question: string;
  proposed: Action[];
  presented?: z.infer<typeof schemas.present_answer>;
}

const endOfDay = (d: string) => (d.length === 10 ? `${d}T23:59:59Z` : d);
const startOfDay = (d: string) => (d.length === 10 ? `${d}T00:00:00Z` : d);

function txnRow(t: Transaction) {
  return {
    date: t.date.slice(0, 16).replace("T", " "),
    id: t.id,
    kind: t.kind,
    customer: t.customer,
    product: t.product,
    amount: t.amount,
    fee: t.fee,
    net: t.net,
    currency: t.currency,
    status: t.status,
  };
}

function preview<T>(rows: T[], n = 25) {
  return { count: rows.length, rows: rows.slice(0, n), truncated: rows.length > n };
}

export const PROPOSE_TOOLS = ["propose_refunds", "propose_invoice_reminders", "propose_new_invoice", "propose_dispute_reply"] as const;

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
  if (!(name in schemas)) throw new Error(`Unknown tool ${name}`);
  const input = schemas[name as ToolName].parse(rawInput ?? {}) as any;
  const src = getSource();

  switch (name as ToolName) {
    case "search_transactions": {
      let txns = await src.listTransactions({ start: startOfDay(input.start_date), end: endOfDay(input.end_date) });
      if (input.kind !== "all") txns = txns.filter((t) => t.kind === input.kind);
      if (input.customer) {
        const q = input.customer.toLowerCase();
        txns = txns.filter((t) => t.customer.toLowerCase().includes(q) || t.customerEmail.toLowerCase().includes(q));
      }
      if (input.product) {
        const q = input.product.toLowerCase();
        txns = txns.filter((t) => t.product.toLowerCase().includes(q));
      }
      if (input.min_amount !== undefined) txns = txns.filter((t) => Math.abs(t.amount) >= input.min_amount);
      const rows = txns.map(txnRow);
      const ds = saveDataset("Transactions", rows);
      const total = round2(txns.reduce((s, t) => s + t.amount, 0));
      return { dataset_id: ds.id, total_amount: total, ...preview(rows) };
    }
    case "summarize_transactions": {
      const txns = await src.listTransactions({ start: startOfDay(input.start_date), end: endOfDay(input.end_date) });
      const rows = summarize(txns, input.group_by as GroupBy);
      const ds = saveDataset(`Summary by ${input.group_by}`, rows as any);
      const totals = rows.reduce(
        (a, r) => ({ orders: a.orders + r.orders, gross_sales: a.gross_sales + r.gross_sales, refunds: a.refunds + r.refunds, net: a.net + r.net }),
        { orders: 0, gross_sales: 0, refunds: 0, net: 0 },
      );
      return {
        dataset_id: ds.id,
        currency: txns[0]?.currency ?? "USD",
        totals: { ...totals, gross_sales: round2(totals.gross_sales), refunds: round2(totals.refunds), net: round2(totals.net) },
        ...preview(rows, 40),
      };
    }
    case "find_duplicate_charges": {
      const txns = await src.listTransactions({ start: startOfDay(input.start_date), end: endOfDay(input.end_date) });
      const rows = findDuplicates(txns, input.window_minutes);
      const ds = saveDataset("Possible duplicate charges", rows as any);
      return { dataset_id: ds.id, ...preview(rows) };
    }
    case "list_invoices": {
      let inv = invoiceFilter(await src.listInvoices(), input.status);
      if (input.customer) {
        const q = input.customer.toLowerCase();
        inv = inv.filter((i) => i.customer.toLowerCase().includes(q) || i.customerEmail.toLowerCase().includes(q));
      }
      const rows = inv.map((i) => ({
        number: i.number,
        id: i.id,
        customer: i.customer,
        status: i.status,
        amount: i.amount,
        amount_due: i.amountDue,
        currency: i.currency,
        issue_date: i.issueDate,
        due_date: i.dueDate,
        days_overdue: i.daysOverdue,
        last_reminder: i.lastReminder?.slice(0, 10) ?? "",
      }));
      const ds = saveDataset("Invoices", rows);
      return { dataset_id: ds.id, total_due: round2(inv.reduce((s, i) => s + i.amountDue, 0)), ...preview(rows) };
    }
    case "list_disputes": {
      let d = await src.listDisputes();
      if (input.open_only) d = d.filter(isOpenDispute);
      const rows = d
        .sort((a, b) => (a.daysLeftToRespond ?? 999) - (b.daysLeftToRespond ?? 999))
        .map((x) => ({
          id: x.id,
          customer: x.customer,
          reason: x.reason,
          status: x.status,
          amount: x.amount,
          currency: x.currency,
          days_left_to_respond: x.daysLeftToRespond ?? "",
          transaction_id: x.transactionId ?? "",
          product: x.product ?? "",
          opened: x.createdAt?.slice(0, 10),
          buyer_says: x.messages?.filter((m) => m.from === "buyer").at(-1)?.text ?? "",
        }));
      const ds = saveDataset("Disputes", rows);
      return { dataset_id: ds.id, ...preview(rows) };
    }
    case "propose_refunds": {
      const now = new Date();
      const all = await src.listTransactions({
        start: new Date(now.getTime() - 180 * 86_400_000).toISOString(),
        end: now.toISOString(),
      });
      const steps = input.refunds.map((r: { transaction_id: string; amount?: number }) => {
        const t = all.find((x) => x.id === r.transaction_id);
        if (!t || t.kind !== "payment") throw new Error(`Transaction ${r.transaction_id} is not a payment I can find. Look it up first.`);
        if (all.some((x) => x.kind === "refund" && x.refundOf === t.id)) {
          throw new Error(`Payment ${t.id} has already been refunded.`);
        }
        const amount = r.amount ?? t.amount;
        if (amount > t.amount) throw new Error(`Refund ${amount} is more than the payment of ${t.amount}.`);
        return {
          label: `Refund ${t.currency} ${amount.toFixed(2)} to ${t.customer} — ${t.product} (${t.date.slice(0, 10)})`,
          payload: { transactionId: t.id, amount: r.amount, currency: t.currency, note: input.note_to_buyer },
          money: amount,
          currency: t.currency,
        };
      });
      const action = addAction({
        type: "refund",
        title: steps.length === 1 ? "Issue 1 refund" : `Issue ${steps.length} refunds`,
        reason: input.reason,
        moneyOut: { amount: round2(steps.reduce((s: number, x: any) => s + x.money, 0)), currency: steps[0].currency },
        steps: steps.map(({ label, payload }: any) => ({ label, payload })),
        requestedBy: ctx.question,
      });
      ctx.proposed.push(action);
      return { action_id: action.id, status: "waiting_for_seller_approval", steps: action.steps.map((s) => s.label) };
    }
    case "propose_invoice_reminders": {
      const inv = await src.listInvoices();
      const steps = input.invoice_ids.map((id: string) => {
        const i = inv.find((x) => x.id === id || x.number === id);
        if (!i) throw new Error(`Invoice ${id} not found. Use list_invoices first.`);
        if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(i.status)) throw new Error(`Invoice ${i.number} is ${i.status}; no reminder needed.`);
        return {
          label: `Remind ${i.customer} about ${i.number} — ${i.currency} ${i.amountDue.toFixed(2)} due${i.daysOverdue ? `, ${i.daysOverdue} days overdue` : ""}`,
          payload: { invoiceId: i.id, note: input.note },
        };
      });
      const action = addAction({
        type: "invoice_reminder",
        title: steps.length === 1 ? "Send 1 payment reminder" : `Send ${steps.length} payment reminders`,
        reason: input.reason,
        steps,
        requestedBy: ctx.question,
      });
      ctx.proposed.push(action);
      return { action_id: action.id, status: "waiting_for_seller_approval", steps: steps.map((s: any) => s.label) };
    }
    case "propose_new_invoice": {
      const total = round2(input.items.reduce((s: number, i: any) => s + i.quantity * i.unit_amount, 0));
      const action = addAction({
        type: "create_invoice",
        title: `Send a new invoice to ${input.customer_name}`,
        reason: input.reason,
        steps: [
          {
            label: `Invoice ${input.customer_name} <${input.customer_email}> for ${input.currency} ${total.toFixed(2)} — ${input.items
              .map((i: any) => `${i.quantity} × ${i.name} @ ${i.unit_amount}`)
              .join(", ")}; due in ${input.due_in_days} days`,
            payload: {
              customerName: input.customer_name,
              customerEmail: input.customer_email,
              currency: input.currency,
              items: input.items.map((i: any) => ({ name: i.name, quantity: i.quantity, unitAmount: i.unit_amount })),
              note: input.note,
              dueInDays: input.due_in_days,
            },
          },
        ],
        requestedBy: ctx.question,
      });
      ctx.proposed.push(action);
      return { action_id: action.id, status: "waiting_for_seller_approval" };
    }
    case "propose_dispute_reply": {
      const d = (await src.listDisputes()).find((x) => x.id === input.dispute_id);
      if (!d) throw new Error(`Dispute ${input.dispute_id} not found. Use list_disputes first.`);
      if (!isOpenDispute(d)) throw new Error(`Dispute ${d.id} is ${d.status}; it can't take a reply.`);
      const action = addAction({
        type: "dispute_reply",
        title: `Reply to ${d.customer}'s dispute`,
        reason: input.reason,
        steps: [{ label: `Send this reply on dispute ${d.id} (${d.currency} ${d.amount.toFixed(2)}): “${input.message}”`, payload: { disputeId: d.id, message: input.message } }],
        requestedBy: ctx.question,
      });
      ctx.proposed.push(action);
      return { action_id: action.id, status: "waiting_for_seller_approval" };
    }
    case "present_answer": {
      ctx.presented = input;
      return { ok: true };
    }
  }
}

/** Runs an approved action's steps against PayPal (or the demo store). */
export async function executeAction(action: Action) {
  const src = getSource();
  action.status = "running";
  for (const step of action.steps) {
    if (step.status === "done") continue;
    try {
      const p = step.payload as any;
      if (action.type === "refund") {
        const r = await src.refundPayment(p);
        step.result = `Refund ${r.refundId} ${r.status}`;
      } else if (action.type === "invoice_reminder") {
        const r = await src.remindInvoice(p);
        step.result = `Reminder sent for ${r.invoiceId}`;
      } else if (action.type === "create_invoice") {
        const r = await src.createAndSendInvoice(p);
        step.result = `Invoice ${r.number} sent`;
      } else if (action.type === "dispute_reply") {
        const r = await src.sendDisputeMessage(p);
        step.result = `Reply sent on ${r.disputeId}`;
      }
      step.status = "done";
    } catch (e) {
      step.status = "failed";
      step.result = (e as Error).message;
    }
  }
  const done = action.steps.filter((s) => s.status === "done").length;
  action.status = done === action.steps.length ? "done" : done === 0 ? "failed" : "partly_done";
  action.decidedAt = new Date().toISOString();
  return action;
}
