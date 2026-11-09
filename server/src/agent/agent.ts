import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ToolResultBlockParam, ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { config } from "../config.js";
import { getSource } from "../data/index.js";
import { getDataset, type Action } from "./store.js";
import { runTool, toolDefinitions, type ToolContext } from "./tools.js";
import type { BriefFacts } from "./analytics.js";

/** The slice of the Anthropic client we use, so tests can swap in a scripted fake. */
export interface LLM {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<{ content: ContentBlock[]; stop_reason: string | null }>;
}

let llm: LLM | null = null;

export function getLLM(): LLM {
  if (!llm) {
    if (!config.anthropicKey) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env and restart the server.");
    const client = new Anthropic({ apiKey: config.anthropicKey });
    llm = { create: (p) => client.messages.create(p) as any };
  }
  return llm;
}

export function setLLM(fake: LLM | null) {
  llm = fake;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AgentAnswer {
  summary: string;
  table?: { title: string; columns: { field: string; header: string }[]; rows: Record<string, unknown>[] };
  chart?: { type: "bar" | "line" | "pie"; x: string; y: string[]; title: string };
  actions: Action[];
  trace: { tool: string; input: unknown; ok: boolean; note?: string }[];
  dataMode: "live" | "demo";
  scheduleChanged?: boolean;
}

function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Kanakku, an assistant that helps a small online seller understand and manage their PayPal account.
Today is ${today}. Data source: ${getSource().mode === "demo" ? "demo store (Meena Prints, a hand-block-printing studio in Coimbatore selling internationally)" : "the seller's PayPal sandbox account"}.

How to work:
- Use the tools to get facts. Never invent ids, names or numbers. For any total, average, comparison or refund rate, use summarize_transactions rather than doing arithmetic yourself.
- Pick sensible date ranges: "this month" = 1st of this month to today; "last month" = the whole previous calendar month; if no period is given, use the last 30 days.
- The workshop: artisans make the goods; jobs are scheduled with them and each has a fixed pay. You can create, move or reassign jobs with schedule_job. Artisans are paid through PayPal Payouts, only for finished jobs.
- You may suggest actions (refunds, payment reminders, new invoices, dispute replies, tracking numbers, artisan payouts) only through the propose_* tools. They do NOT happen until the seller presses Approve on a card. Never say money was refunded or a reminder was sent — say it is ready for their approval.
- Only propose an action when the seller asks for it, or when it is clearly what they want (e.g. "fix the duplicate charges"). Otherwise, mention it as a suggestion in the summary.
- Finish by calling present_answer exactly once. Choose the dataset that best answers the question, pick only the useful columns (5-8), and add a chart when it helps (line for time series, bar for comparisons).

Language:
- Reply in the same language and script the seller used: Tamil, Hindi, Tanglish/Hinglish, English or anything else. Translate column headers and the chart title too. Keep ids, amounts and product names as they are.
- Be brief, warm and concrete. Lead with the answer and the number that matters. Use the currency code with amounts (e.g. USD 1,240).`;
}

const MAX_STEPS = 10;

export async function ask(question: string, history: ChatTurn[] = []): Promise<AgentAnswer> {
  const model = getLLM();
  const ctx: ToolContext = { question, proposed: [] };
  const trace: AgentAnswer["trace"] = [];

  const messages: MessageParam[] = [
    ...history.slice(-8).map((t) => ({ role: t.role, content: t.text }) as MessageParam),
    { role: "user", content: question },
  ];

  let finalText = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await model.create({
      model: config.model,
      max_tokens: 2048,
      system: systemPrompt(),
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: "assistant", content: res.content as any });
    const toolUses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const text = res.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) finalText = text;

    if (toolUses.length === 0 || res.stop_reason !== "tool_use") break;

    const results: ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      try {
        const out = await runTool(use.name, use.input, ctx);
        trace.push({ tool: use.name, input: use.input, ok: true });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(out) });
      } catch (e) {
        const msg = (e as Error).message;
        trace.push({ tool: use.name, input: use.input, ok: false, note: msg });
        results.push({ type: "tool_result", tool_use_id: use.id, content: `Error: ${msg}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
    if (ctx.presented) break;
  }

  const answer: AgentAnswer = {
    summary: ctx.presented?.summary ?? (finalText || "Sorry, I couldn't put an answer together. Please try asking another way."),
    actions: ctx.proposed,
    trace,
    dataMode: getSource().mode,
    scheduleChanged: ctx.changedSchedule,
  };

  const p = ctx.presented;
  const ds = p?.dataset_id ? getDataset(p.dataset_id) : undefined;
  if (ds && ds.rows.length) {
    const fields = Object.keys(ds.rows[0]);
    const cols = (p!.columns ?? fields.map((f) => ({ field: f, header: f.replace(/_/g, " ") }))).filter((c) => fields.includes(c.field));
    answer.table = { title: ds.title, columns: cols.length ? cols : fields.map((f) => ({ field: f, header: f })), rows: ds.rows };
    if (p!.chart && fields.includes(p!.chart.x) && p!.chart.y.every((y) => fields.includes(y))) {
      answer.chart = p!.chart;
    }
  }
  return answer;
}

/** Turns the exact brief facts into a few friendly sentences in the seller's language. */
export async function writeBrief(facts: BriefFacts & { unavailable?: string[] }, language: string): Promise<string> {
  let model: LLM;
  try {
    model = getLLM();
  } catch {
    return templateBrief(facts);
  }
  const res = await model.create({
    model: config.model,
    max_tokens: 400,
    system:
      "You write a 2-4 sentence morning brief for a small online seller. Use ONLY the facts given, keep every number exact, put the most urgent item first (disputes close to their deadline, then duplicate charges, then overdue invoices), then one line on sales. No greeting fluff, no markdown headings. Bold at most two key numbers. Anything listed in \"unavailable\" could not be loaded: do not mention it or treat it as zero.",
    messages: [{ role: "user", content: `Language: ${language}\nFacts (JSON):\n${JSON.stringify(facts)}` }],
  });
  const text = res.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || templateBrief(facts);
}

export function templateBrief(f: BriefFacts & { unavailable?: string[] }): string {
  const parts: string[] = [];
  const missing = new Set(f.unavailable ?? []);
  const c = f.currency;
  if (f.urgent_disputes.length) {
    const d = f.urgent_disputes[0];
    parts.push(`**${f.urgent_disputes.length} dispute${f.urgent_disputes.length > 1 ? "s" : ""}** need a reply soon — ${d.customer}'s (${c} ${d.amount}) is due in ${d.days_left} day${d.days_left === 1 ? "" : "s"}.`);
  }
  if (f.possible_duplicate_charges.length) {
    parts.push(`${f.possible_duplicate_charges.length} possible duplicate charge${f.possible_duplicate_charges.length > 1 ? "s" : ""} found in the last two weeks.`);
  }
  if (f.overdue_invoices.count) {
    parts.push(`**${c} ${f.overdue_invoices.total_due.toLocaleString("en-US")}** is overdue across ${f.overdue_invoices.count} invoices.`);
  }
  if (f.change_pct !== null && !missing.has("sales")) {
    parts.push(`Sales this month: ${c} ${f.month_to_date_sales.toLocaleString("en-US")} (${f.change_pct >= 0 ? "+" : ""}${f.change_pct}% vs the same days last month).`);
  }
  if (parts.length === 0 && missing.size) return "";
  return parts.join(" ") || "All clear today: no urgent disputes, duplicate charges or overdue invoices.";
}
