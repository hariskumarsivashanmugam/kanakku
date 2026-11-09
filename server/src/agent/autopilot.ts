import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getSource, getWorkshop } from "../data/index.js";
import { round2 } from "../data/util.js";
import { findDuplicates, invoiceFilter, isOpenDispute } from "./analytics.js";
import { getAction, listActions, type Action } from "./store.js";
import { executeAction, runTool, type ToolContext } from "./tools.js";
import { draftDisputeReply } from "./drafts.js";

/**
 * Autopilot: standing rules the seller sets once. Each run checks the account and, per rule, either
 * does the work itself (within the rule's limits) or prepares it for approval. Every step goes through
 * the same propose → approve → execute path as buttons and the assistant, so the same checks apply and
 * everything lands in Activity.
 */

export type RuleType = "remind_overdue" | "refund_duplicates" | "pay_finished_jobs" | "dispute_deadlines";
export type Mode = "auto" | "ask";

export interface Rule {
  id: RuleType;
  name: string;
  description: string;
  enabled: boolean;
  mode: Mode;
  /** Modes this rule allows. Dispute replies always wait for the seller. */
  modes: Mode[];
  params: Record<string, number>;
  paramLabels: Record<string, string>;
}

export interface RuleResult {
  ruleId: RuleType;
  ruleName: string;
  outcome: "did" | "asked" | "nothing" | "held" | "error";
  summary: string;
  actionIds: string[];
}

export interface Run {
  id: string;
  at: string;
  trigger: "manual" | "schedule" | "webhook" | "external";
  results: RuleResult[];
}

interface State {
  rules: Rule[];
  runs: Run[];
  schedule: { enabled: boolean; intervalMinutes: number };
  /** subject key (e.g. "refund:CAPTURE_ID") → action id, so a run doesn't re-propose something still waiting. */
  proposed: Record<string, string>;
}

function defaults(): State {
  return {
    rules: [
      {
        id: "remind_overdue",
        name: "Chase overdue invoices",
        description: "Send a polite PayPal reminder for invoices that are overdue, at most once a week per invoice.",
        enabled: true,
        mode: "auto",
        modes: ["auto", "ask"],
        params: { minDaysOverdue: 3, cooldownDays: 7 },
        paramLabels: { minDaysOverdue: "Days overdue before the first reminder", cooldownDays: "Days between reminders" },
      },
      {
        id: "refund_duplicates",
        name: "Refund duplicate charges",
        description: "When a customer is charged twice for the same item within 30 minutes, refund the second charge.",
        enabled: true,
        mode: "ask",
        modes: ["auto", "ask"],
        params: { maxAmount: 50 },
        paramLabels: { maxAmount: "Refund automatically up to (USD)" },
      },
      {
        id: "pay_finished_jobs",
        name: "Pay artisans for finished jobs",
        description: "When a workshop job is marked done, pay the artisan through PayPal Payouts.",
        enabled: true,
        mode: "auto",
        modes: ["auto", "ask"],
        params: { maxPerJob: 200, weeklyCap: 400 },
        paramLabels: { maxPerJob: "Pay automatically up to (USD per job)", weeklyCap: "Autopilot payouts cap (USD per 7 days)" },
      },
      {
        id: "dispute_deadlines",
        name: "Draft replies before dispute deadlines",
        description: "When a dispute is close to its deadline and has no reply yet, draft one with AI for you to check.",
        enabled: true,
        mode: "ask",
        modes: ["ask"],
        params: { daysBefore: 3 },
        paramLabels: { daysBefore: "Days before the deadline" },
      },
    ],
    runs: [],
    schedule: { enabled: false, intervalMinutes: 60 },
    proposed: {},
  };
}

const file = process.env.KANAKKU_AUTOPILOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.kanakku/autopilot.json");

let state: State | null = null;
let persist = false;

function load(): State {
  if (state) return state;
  persist = getSource().mode === "live" && !process.env.KANAKKU_NO_PERSIST;
  if (persist) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as State;
      // Keep the saved settings but pick up rule definitions added since.
      const d = defaults();
      saved.rules = d.rules.map((r) => {
        const s = saved.rules.find((x) => x.id === r.id);
        return s ? { ...r, enabled: s.enabled, mode: r.modes.includes(s.mode) ? s.mode : r.mode, params: { ...r.params, ...s.params } } : r;
      });
      state = saved;
      return state;
    } catch {
      /* first run */
    }
  }
  state = defaults();
  return state;
}

function save() {
  if (!persist || !state) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

export function getAutopilot() {
  const s = load();
  return { rules: s.rules, runs: s.runs.slice(0, 20), schedule: s.schedule, running };
}

export function resetAutopilot() {
  state = defaults();
  save();
}

export function updateRule(id: string, patch: { enabled?: boolean; mode?: Mode; params?: Record<string, number> }) {
  const s = load();
  const r = s.rules.find((x) => x.id === id);
  if (!r) throw new Error(`No rule ${id}`);
  if (patch.mode && !r.modes.includes(patch.mode)) throw new Error(`“${r.name}” always asks you first.`);
  if (typeof patch.enabled === "boolean") r.enabled = patch.enabled;
  if (patch.mode) r.mode = patch.mode;
  if (patch.params) {
    for (const [k, v] of Object.entries(patch.params)) {
      if (!(k in r.params)) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${r.paramLabels[k] ?? k} must be a number of 0 or more.`);
      r.params[k] = v;
    }
  }
  save();
  return r;
}

export function updateSchedule(patch: { enabled?: boolean; intervalMinutes?: number }) {
  const s = load();
  if (typeof patch.enabled === "boolean") s.schedule.enabled = patch.enabled;
  if (typeof patch.intervalMinutes === "number") s.schedule.intervalMinutes = Math.max(5, Math.min(24 * 60, Math.round(patch.intervalMinutes)));
  save();
  restartTimer();
  return s.schedule;
}

/** Is there already a proposal for this subject that hasn't been decided? */
function stillWaiting(key: string) {
  const id = load().proposed[key];
  return Boolean(id && getAction(id)?.status === "pending");
}

function remember(keys: string[], action: Action) {
  const s = load();
  for (const k of keys) s.proposed[k] = action.id;
}

async function propose(tool: string, input: unknown, rule: Rule): Promise<Action> {
  const ctx: ToolContext = { question: `Autopilot: ${rule.name}`, proposed: [] };
  await runTool(tool, input, ctx);
  return ctx.proposed[0];
}

/** Payouts Autopilot made itself in the last 7 days, for the weekly cap. */
function autopilotPayoutsLastWeek() {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  return listActions()
    .filter((a) => a.type === "artisan_payout" && a.requestedBy.startsWith("Autopilot") && a.status === "done" && (a.decidedAt ?? "") >= since)
    .reduce((s, a) => s + (a.moneyOut?.amount ?? 0), 0);
}

/** "Nothing new", but say so if earlier proposals are still waiting for the seller. */
function nothingOr(base: Omit<RuleResult, "outcome" | "summary">, waiting: number, noun: string, none: string): RuleResult {
  if (!waiting) return { ...base, outcome: "nothing", summary: none };
  return { ...base, outcome: "asked", summary: `Nothing new. ${waiting} ${waiting > 1 ? (noun === "dispute reply" ? "dispute replies" : noun + "s") : noun} from an earlier run ${waiting > 1 ? "are" : "is"} still waiting for your approval.` };
}

async function runRule(rule: Rule): Promise<RuleResult> {
  const base = { ruleId: rule.id, ruleName: rule.name, actionIds: [] as string[] };
  const src = getSource();
  const now = Date.now();

  switch (rule.id) {
    case "remind_overdue": {
      const cooldown = rule.params.cooldownDays * 86_400_000;
      const candidates = invoiceFilter(await src.listInvoices(), "overdue").filter(
        (i) => i.daysOverdue >= rule.params.minDaysOverdue && (!i.lastReminder || now - Date.parse(i.lastReminder) >= cooldown),
      );
      const due = candidates.filter((i) => !stillWaiting(`remind:${i.id}`));
      if (!due.length) return nothingOr(base, candidates.length, "reminder", "No overdue invoices need a reminder right now.");
      const action = await propose(
        "propose_invoice_reminders",
        {
          invoice_ids: due.map((i) => i.id),
          reason: `${due.length} invoice${due.length > 1 ? "s are" : " is"} at least ${rule.params.minDaysOverdue} days overdue.`,
          note: "A gentle reminder that this invoice is now overdue. You can pay securely through the PayPal link. Thank you!",
        },
        rule,
      );
      remember(due.map((i) => `remind:${i.id}`), action);
      if (rule.mode === "auto") {
        await executeAction(action);
        const total = round2(due.reduce((s, i) => s + i.amountDue, 0));
        return { ...base, outcome: "did", actionIds: [action.id], summary: `Sent ${due.length} reminder${due.length > 1 ? "s" : ""} for USD ${total.toLocaleString("en-US")} overdue.` };
      }
      return { ...base, outcome: "asked", actionIds: [action.id], summary: `${due.length} reminder${due.length > 1 ? "s are" : " is"} waiting for your approval.` };
    }

    case "refund_duplicates": {
      const txns = await src.listTransactions({ start: new Date(now - 14 * 86_400_000).toISOString(), end: new Date(now).toISOString() });
      const all = findDuplicates(txns).filter((d) => !d.already_refunded);
      const dupes = all.filter((d) => !stillWaiting(`refund:${d.duplicate_charge_id}`));
      if (!dupes.length) return nothingOr(base, all.length, "refund", "No duplicate charges in the last two weeks.");
      const small = rule.mode === "auto" ? dupes.filter((d) => d.amount <= rule.params.maxAmount) : [];
      const large = dupes.filter((d) => !small.includes(d));
      const parts: string[] = [];
      const ids: string[] = [];
      let outcome: RuleResult["outcome"] = "asked";
      if (small.length) {
        const a = await propose(
          "propose_refunds",
          { refunds: small.map((d) => ({ transaction_id: d.duplicate_charge_id })), reason: "Charged twice for the same item within minutes.", note_to_buyer: "Sorry, you were charged twice. We've refunded the extra charge." },
          rule,
        );
        remember(small.map((d) => `refund:${d.duplicate_charge_id}`), a);
        await executeAction(a);
        ids.push(a.id);
        outcome = "did";
        parts.push(`Refunded ${small.length} duplicate charge${small.length > 1 ? "s" : ""} (${small.map((d) => `${d.customer}, USD ${d.amount}`).join("; ")}).`);
      }
      if (large.length) {
        const a = await propose(
          "propose_refunds",
          { refunds: large.map((d) => ({ transaction_id: d.duplicate_charge_id })), reason: rule.mode === "auto" ? `Above your USD ${rule.params.maxAmount} automatic limit.` : "Charged twice for the same item within minutes.", note_to_buyer: "Sorry, you were charged twice. We've refunded the extra charge." },
          rule,
        );
        remember(large.map((d) => `refund:${d.duplicate_charge_id}`), a);
        ids.push(a.id);
        parts.push(`${large.length} refund${large.length > 1 ? "s" : ""} waiting for your approval${rule.mode === "auto" ? ` (over USD ${rule.params.maxAmount})` : ""}.`);
      }
      return { ...base, outcome, actionIds: ids, summary: parts.join(" ") };
    }

    case "pay_finished_jobs": {
      const ws = getWorkshop();
      const w = ws.get();
      const finished = w.jobs.filter((j) => j.status === "done" && !j.payout);
      const done = finished.filter((j) => !stillWaiting(`payout:${j.id}`));
      if (!done.length) return nothingOr(base, finished.length, "payout", "No finished jobs waiting to be paid.");
      let room = rule.mode === "auto" ? Math.max(0, rule.params.weeklyCap - autopilotPayoutsLastWeek()) : 0;
      const auto = [];
      const held = [];
      for (const j of done) {
        if (rule.mode === "auto" && j.pay <= rule.params.maxPerJob && j.pay <= room) {
          auto.push(j);
          room -= j.pay;
        } else held.push(j);
      }
      const ids: string[] = [];
      const parts: string[] = [];
      const name = (id: string) => w.artisans.find((a) => a.id === id)?.name ?? id;
      if (auto.length) {
        const a = await propose("propose_artisan_payouts", { job_ids: auto.map((j) => j.id), reason: "Finished jobs, within your automatic limits." }, rule);
        remember(auto.map((j) => `payout:${j.id}`), a);
        await executeAction(a);
        ids.push(a.id);
        parts.push(`Paid ${auto.map((j) => `${name(j.artisanId)} USD ${j.pay}`).join(" and ")} through PayPal.`);
      }
      if (held.length) {
        const why = rule.mode === "auto" ? ` (over USD ${rule.params.maxPerJob} per job or the USD ${rule.params.weeklyCap} weekly cap)` : "";
        const a = await propose("propose_artisan_payouts", { job_ids: held.map((j) => j.id), reason: `Finished jobs${why}.` }, rule);
        remember(held.map((j) => `payout:${j.id}`), a);
        ids.push(a.id);
        parts.push(`${held.length} payout${held.length > 1 ? "s" : ""} waiting for your approval${why}.`);
      }
      return { ...base, outcome: auto.length ? "did" : rule.mode === "auto" ? "held" : "asked", actionIds: ids, summary: parts.join(" ") };
    }

    case "dispute_deadlines": {
      const close = (await src.listDisputes()).filter(
        (d) =>
          isOpenDispute(d) &&
          d.status === "WAITING_FOR_SELLER_RESPONSE" &&
          d.daysLeftToRespond !== undefined &&
          d.daysLeftToRespond <= rule.params.daysBefore &&
          !d.messages?.some((m) => m.from === "seller"),
      );
      const disputes = close.filter((d) => !stillWaiting(`dispute:${d.id}`));
      if (!disputes.length) return nothingOr(base, close.length, "dispute reply", "No disputes close to their deadline without a reply.");
      const ids: string[] = [];
      for (const d of disputes) {
        let message: string;
        try {
          message = await draftDisputeReply(d);
        } catch {
          message = `Hello ${d.customer},\n\nI'm sorry to hear about the problem with your order. I'm looking into it now and will update you within 24 hours with tracking details or a resolution.\n\nWarm regards,\nMeena Prints`;
        }
        const a = await propose("propose_dispute_reply", { dispute_id: d.id, message, reason: `Deadline in ${d.daysLeftToRespond} day${d.daysLeftToRespond === 1 ? "" : "s"}. Drafted by Autopilot; check it before sending.` }, rule);
        remember([`dispute:${d.id}`], a);
        ids.push(a.id);
      }
      return { ...base, outcome: "asked", actionIds: ids, summary: `Drafted ${ids.length} dispute repl${ids.length > 1 ? "ies" : "y"} for you to check.` };
    }
  }
}

let running = false;

export async function runAutopilot(trigger: Run["trigger"]): Promise<Run> {
  if (running) throw new Error("Autopilot is already running.");
  running = true;
  try {
    const s = load();
    const results: RuleResult[] = [];
    for (const rule of s.rules.filter((r) => r.enabled)) {
      try {
        results.push(await runRule(rule));
      } catch (e) {
        results.push({ ruleId: rule.id, ruleName: rule.name, outcome: "error", summary: (e as Error).message, actionIds: [] });
      }
    }
    const run: Run = { id: "run_" + randomUUID().slice(0, 8), at: new Date().toISOString(), trigger, results };
    s.runs.unshift(run);
    s.runs = s.runs.slice(0, 50);
    save();
    return run;
  } finally {
    running = false;
  }
}

// ---------- in-process schedule ----------

let timer: NodeJS.Timeout | null = null;

export function restartTimer() {
  if (timer) clearInterval(timer);
  timer = null;
  const s = load();
  if (!s.schedule.enabled) return;
  timer = setInterval(() => {
    runAutopilot("schedule").catch(() => {});
  }, s.schedule.intervalMinutes * 60_000);
  timer.unref();
}
