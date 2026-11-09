import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

process.env.DATA_MODE = "demo";
process.env.ANTHROPIC_API_KEY = "test-key";

const { createApp } = await import("../src/app.js");
const { setLLM } = await import("../src/agent/agent.js");
const { buildDemoData } = await import("../src/data/demoSource.js");
const { summarize, findDuplicates, briefFacts } = await import("../src/agent/analytics.js");
const { toolDefinitions } = await import("../src/agent/tools.js");

let server: Server;
let base = "";

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (p: string, body?: unknown) =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

/** A fake Claude that plays back a fixed list of tool calls, then lets us inspect what it saw. */
function scripted(steps: { name: string; input: (seen: any[]) => unknown }[]) {
  const seen: any[] = [];
  let i = 0;
  setLLM({
    async create(params) {
      const last = params.messages[params.messages.length - 1];
      if (Array.isArray(last.content)) {
        for (const b of last.content as any[]) if (b.type === "tool_result") seen.push(JSON.parse(String(b.content).replace(/^Error: (.*)$/s, '{"error":"$1"}')));
      }
      const step = steps[i++];
      if (!step) return { content: [{ type: "text", text: "done", citations: null }] as any, stop_reason: "end_turn" };
      return {
        content: [{ type: "tool_use", id: `tu_${i}`, name: step.name, input: step.input(seen), caller: { type: "direct" } }] as any,
        stop_reason: "tool_use",
      };
    },
  });
  return seen;
}

test("demo data is realistic and includes the planted problems", () => {
  const { txns, invoices, disputes } = buildDemoData();
  assert.ok(txns.length > 300, "enough transactions");
  assert.ok(findDuplicates(txns).length >= 2, "duplicate charges are detectable");
  const byProduct = summarize(txns, "product");
  const indigo = byProduct.find((r) => r.group === "Indigo cushion cover set")!;
  const others = byProduct.filter((r) => r.group !== indigo.group);
  assert.ok(others.every((o) => indigo.refund_rate_pct > o.refund_rate_pct), "indigo set has the worst refund rate");
  assert.ok(invoices.some((i) => i.daysOverdue > 0), "some invoices are overdue");
  assert.ok(disputes.some((d) => d.daysLeftToRespond === 2), "an urgent dispute exists");
});

test("summarize totals match the raw transactions", () => {
  const { txns } = buildDemoData();
  const rows = summarize(txns, "month");
  const gross = rows.reduce((s, r) => s + r.gross_sales, 0);
  const raw = txns.filter((t) => t.kind === "payment").reduce((s, t) => s + t.amount, 0);
  assert.ok(Math.abs(gross - raw) < 0.01);
});

test("brief facts flag disputes, duplicates and overdue invoices", () => {
  const facts = briefFacts(buildDemoData());
  assert.equal(facts.urgent_disputes[0].days_left, 2);
  assert.equal(facts.possible_duplicate_charges.length, 2);
  assert.ok(facts.overdue_invoices.count >= 3);
  assert.equal(facts.highest_refund_rate_product?.product, "Indigo cushion cover set");
});

test("every tool has a valid JSON schema", () => {
  for (const t of toolDefinitions) {
    assert.equal((t.input_schema as any).type, "object", t.name);
  }
  const s = toolDefinitions.find((t) => t.name === "summarize_transactions")!.input_schema as any;
  assert.deepEqual(s.required.sort(), ["end_date", "group_by", "start_date"]);
});

test("ask: grid shows the real dataset the model referenced", async () => {
  const today = new Date().toISOString().slice(0, 10);
  scripted([
    { name: "summarize_transactions", input: () => ({ start_date: "2020-01-01", end_date: today, group_by: "product" }) },
    {
      name: "present_answer",
      input: (seen) => ({
        summary: "Indigo cushion covers are refunded most.",
        dataset_id: seen[0].dataset_id,
        columns: [
          { field: "group", header: "Product" },
          { field: "refund_rate_pct", header: "Refund rate %" },
          { field: "made_up_field", header: "Nope" },
        ],
        chart: { type: "bar", x: "group", y: ["refund_rate_pct"], title: "Refund rate by product" },
      }),
    },
  ]);
  const res = await post("/api/ask", { question: "Which product gets refunded most?" });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.summary, "Indigo cushion covers are refunded most.");
  assert.equal(body.table.rows.length, 6);
  assert.deepEqual(body.table.columns.map((c: any) => c.field), ["group", "refund_rate_pct"], "unknown columns dropped");
  assert.equal(body.chart.type, "bar");
});

test("refunds wait for approval, then really happen once", async () => {
  const { txns } = buildDemoData();
  const dupe = findDuplicates(txns)[0];
  const seen = scripted([
    { name: "propose_refunds", input: () => ({ refunds: [{ transaction_id: dupe.duplicate_charge_id }], reason: "Duplicate charge" }) },
    { name: "present_answer", input: () => ({ summary: "Ready for your approval." }) },
  ]);
  const body = await (await post("/api/ask", { question: "Refund the duplicate charge" })).json();
  assert.equal(seen[0].status, "waiting_for_seller_approval");
  assert.equal(body.actions.length, 1);
  const action = body.actions[0];
  assert.equal(action.status, "pending");
  assert.equal(action.moneyOut.amount, dupe.amount);

  const approved = await (await post(`/api/actions/${action.id}/approve`)).json();
  assert.equal(approved.status, "done");
  assert.match(approved.steps[0].result, /COMPLETED/);

  const again = await post(`/api/actions/${action.id}/approve`);
  assert.equal(again.status, 409, "cannot approve twice");

  // A second proposal for the same payment is refused because it is already refunded.
  const seen2 = scripted([
    { name: "propose_refunds", input: () => ({ refunds: [{ transaction_id: dupe.duplicate_charge_id }], reason: "again" }) },
    { name: "present_answer", input: () => ({ summary: "x" }) },
  ]);
  await post("/api/ask", { question: "refund it again" });
  assert.match(seen2[0].error, /already been refunded/);
});

test("invented ids are rejected instead of creating an action", async () => {
  const seen = scripted([
    { name: "propose_refunds", input: () => ({ refunds: [{ transaction_id: "FAKE123" }], reason: "x" }) },
    { name: "present_answer", input: () => ({ summary: "Couldn't find it." }) },
  ]);
  const body = await (await post("/api/ask", { question: "refund FAKE123" })).json();
  assert.match(seen[0].error, /not a payment I can find/);
  assert.equal(body.actions.length, 0);
});

test("reminders: rejected actions are not executed", async () => {
  const { invoices } = buildDemoData();
  const overdue = invoices.filter((i) => i.daysOverdue > 0 && i.status === "SENT");
  scripted([
    { name: "propose_invoice_reminders", input: () => ({ invoice_ids: overdue.map((i) => i.id), reason: "Overdue" }) },
    { name: "present_answer", input: () => ({ summary: "Ready." }) },
  ]);
  const body = await (await post("/api/ask", { question: "remind everyone overdue" })).json();
  const id = body.actions[0].id;
  assert.equal(body.actions[0].steps.length, overdue.length);
  const rejected = await (await post(`/api/actions/${id}/reject`)).json();
  assert.equal(rejected.status, "rejected");
  assert.equal((await post(`/api/actions/${id}/approve`)).status, 409);
});

test("brief endpoint returns exact facts and text", async () => {
  setLLM({
    async create() {
      return { content: [{ type: "text", text: "Brief text", citations: null }] as any, stop_reason: "end_turn" };
    },
  });
  const body = await (await fetch(`${base}/api/brief?lang=Tamil`)).json();
  assert.equal(body.text, "Brief text");
  assert.ok(body.facts.overdue_invoices.count >= 3);
});

test("brief still loads when one PayPal permission is missing", async () => {
  const { setSource, getSource } = await import("../src/data/index.js");
  const { DemoSource } = await import("../src/data/demoSource.js");
  const { PayPalError, featureFor } = await import("../src/paypal/client.js");
  assert.equal(featureFor("/v1/reporting/transactions"), "Transaction search");
  const original = getSource();
  const partial = new DemoSource();
  partial.listTransactions = async () => {
    throw new PayPalError("Your PayPal app doesn't have Transaction search permission.", 403);
  };
  setSource(partial);
  try {
    setLLM({ async create() { return { content: [{ type: "text", text: "Invoices brief", citations: null }] as any, stop_reason: "end_turn" }; } });
    const res = await fetch(`${base}/api/brief`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.facts.unavailable, ["sales"]);
    assert.match(body.warnings[0], /Transaction search/);
    assert.ok(body.facts.overdue_invoices.count >= 3, "invoices still counted");
    assert.equal(body.text, "Invoices brief");
  } finally {
    setSource(original);
  }
});

const forced = (input: unknown) =>
  setLLM({
    async create(params: any) {
      assert.equal(params.tool_choice, undefined, "no forced tool_choice: some models reject it");
      return { content: [{ type: "tool_use", id: "f", name: params.tools[0].name, input, caller: { type: "direct" } }] as any, stop_reason: "tool_use" };
    },
  });

test("overview: exact KPIs, insights and attention items", async () => {
  const body = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(body.series.length, 60);
  assert.ok(body.kpis.owed > 0 && body.kpis.overdueCount >= 3);
  assert.equal(body.kpis.disputesDueSoon, 1);
  assert.ok(body.insights.some((i: any) => i.id === "refund-outlier" && i.title.startsWith("Indigo cushion cover set")));
  assert.ok(body.topProducts.length === 6);
  assert.deepEqual(body.unavailable, []);
});

test("buttons go through the same checks and approval as the assistant", async () => {
  assert.equal((await post("/api/actions/propose", { tool: "delete_everything", input: {} })).status, 400);
  const bad = await post("/api/actions/propose", { tool: "propose_refunds", input: { refunds: [{ transaction_id: "NOPE" }], reason: "x" } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not a payment/);

  const inv = (await (await fetch(`${base}/api/invoices`)).json()).find((i: any) => i.status === "SENT");
  const res = await post("/api/actions/propose", { tool: "propose_invoice_reminders", input: { invoice_ids: [inv.id], reason: "Due" }, source: "Invoices page" });
  const action = await res.json();
  assert.equal(action.status, "pending");
  assert.equal(action.requestedBy, "Invoices page");
  const done = await (await post(`/api/actions/${action.id}/approve`)).json();
  assert.equal(done.status, "done");
  const after = (await (await fetch(`${base}/api/invoices`)).json()).find((i: any) => i.id === inv.id);
  assert.ok(after.lastReminder, "reminder recorded on the invoice");
});

test("AI invoice draft from a pasted message", async () => {
  forced({ customer_name: "Casa Lino", customer_email: "", currency: "USD", items: [{ name: "Ajrakh stole", quantity: 12, unit_amount: 32 }], due_in_days: 14, note: "", missing: ["customer email"] });
  const draft = await (await post("/api/ai/invoice-draft", { text: "Please send 12 Ajrakh stoles at $32 to Casa Lino" })).json();
  assert.equal(draft.items[0].quantity, 12);
  assert.deepEqual(draft.missing, ["customer email"]);
  assert.equal((await post("/api/ai/invoice-draft", { text: "hi" })).status, 400);
});

test("dispute reply: AI draft, approval, then the message is on the case", async () => {
  const dispute = (await (await fetch(`${base}/api/disputes`)).json())[0];
  forced({ message: "Hello, I'm sorry your order hasn't arrived. Tracking: [tracking number]." });
  const { message } = await (await post("/api/ai/dispute-reply", { disputeId: dispute.id })).json();
  assert.match(message, /tracking/);
  const action = await (await post("/api/actions/propose", { tool: "propose_dispute_reply", input: { dispute_id: dispute.id, message, reason: "Reply" } })).json();
  assert.equal(action.type, "dispute_reply");
  assert.equal((await (await post(`/api/actions/${action.id}/approve`)).json()).status, "done");
  const after = (await (await fetch(`${base}/api/disputes`)).json()).find((d: any) => d.id === dispute.id);
  assert.equal(after.status, "UNDER_REVIEW");
  assert.equal(after.messages.at(-1).from, "seller");
});

test("transactions endpoint marks refunded payments", async () => {
  const rows = await (await fetch(`${base}/api/transactions?days=30`)).json();
  assert.ok(rows.some((r: any) => r.kind === "payment" && r.refunded));
  assert.ok(rows.every((r: any) => r.kind !== "refund" || !r.refunded));
});

test("drafts still work when the model answers in plain text", async () => {
  setLLM({
    async create() {
      return { content: [{ type: "text", text: 'Here you go: {"customer_name":"Casa Lino","customer_email":"","currency":"USD","items":[{"name":"Tote","quantity":3,"unit_amount":11}],"due_in_days":14,"note":"","missing":["customer email"]}', citations: null }] as any, stop_reason: "end_turn" };
    },
  });
  const draft = await (await post("/api/ai/invoice-draft", { text: "3 totes at $11 for Casa Lino" })).json();
  assert.equal(draft.items[0].quantity, 3);
  const dispute = (await (await fetch(`${base}/api/disputes`)).json()).find((d: any) => d.status === "WAITING_FOR_SELLER_RESPONSE");
  setLLM({ async create() { return { content: [{ type: "text", text: "Hello, I'm sorry for the trouble.", citations: null }] as any, stop_reason: "end_turn" }; } });
  const { message } = await (await post("/api/ai/dispute-reply", { disputeId: dispute.id })).json();
  assert.equal(message, "Hello, I'm sorry for the trouble.");
});

test("workshop: pay a finished job once, and paid jobs are locked", async () => {
  const w = await (await fetch(`${base}/api/workshop`)).json();
  const job = w.jobs.find((j: any) => j.status === "done");
  const planned = w.jobs.find((j: any) => j.status === "planned");
  // Not finished yet → refused
  const early = await post("/api/actions/propose", { tool: "propose_artisan_payouts", input: { job_ids: [planned.id], reason: "x" } });
  assert.equal(early.status, 400);
  const a1 = await (await post("/api/actions/propose", { tool: "propose_artisan_payouts", input: { job_ids: [job.id], reason: "done" } })).json();
  const a2 = await (await post("/api/actions/propose", { tool: "propose_artisan_payouts", input: { job_ids: [job.id], reason: "again" } })).json();
  assert.equal(a1.moneyOut.amount, job.pay);
  assert.equal((await (await post(`/api/actions/${a1.id}/approve`)).json()).status, "done");
  const second = await (await post(`/api/actions/${a2.id}/approve`)).json();
  assert.equal(second.status, "failed", "the second approval must not pay again");
  assert.match(second.steps[0].result, /Already paid/);
  const after = (await (await fetch(`${base}/api/workshop`)).json()).jobs.find((j: any) => j.id === job.id);
  assert.equal(after.status, "paid");
  const move = await fetch(`${base}/api/workshop/jobs/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ start: "2030-01-01", end: "2030-01-05" }) });
  assert.equal(move.status, 400);
  // Dragging a planned job to another artisan works
  const moved = await (await fetch(`${base}/api/workshop/jobs/${planned.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ artisanId: "a1" }) })).json();
  assert.equal(moved.artisanId, "a1");
});

test("autopilot respects limits and never repeats itself", async () => {
  await post("/api/demo/reset");
  // Payouts up to USD 100 per job: Kamala's USD 90 is paid, Fatima's USD 180 waits for approval.
  await fetch(`${base}/api/autopilot/rules/pay_finished_jobs`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "auto", params: { maxPerJob: 100 } }) });
  const run = await (await post("/api/autopilot/run", { trigger: "manual" })).json();
  const pay = run.results.find((r: any) => r.ruleId === "pay_finished_jobs");
  assert.equal(pay.outcome, "did");
  assert.match(pay.summary, /Kamala Devi USD 90/);
  assert.match(pay.summary, /1 payout waiting for your approval/);
  const remind = run.results.find((r: any) => r.ruleId === "remind_overdue");
  assert.equal(remind.outcome, "did");
  const again = await (await post("/api/autopilot/run", { trigger: "manual" })).json();
  assert.ok(again.results.every((r: any) => r.outcome === "nothing" || /still waiting/.test(r.summary)), "second run proposes nothing new");
  const actions = await (await fetch(`${base}/api/actions`)).json();
  assert.equal(actions.filter((a: any) => a.type === "artisan_payout").length, 2);
  // "Ask me first" can't be turned into auto for dispute replies
  const bad = await fetch(`${base}/api/autopilot/rules/dispute_deadlines`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "auto" }) });
  assert.equal(bad.status, 400);
});

test("price check compares with Channel3 results", async () => {
  const http = await import("node:http");
  const c3 = http.createServer((req, res) => {
    res.writeHead(req.headers["x-api-key"] === "k" ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ products: [30, 40, 50, 60, 70, 80].map((p, i) => ({ title: `Stole ${i}`, offers: [{ domain: "shop.example", price: { price: p, currency: "USD" } }] })) }));
  });
  await new Promise<void>((r) => c3.listen(0, r));
  const { config } = await import("../src/config.js");
  config.channel3.key = "k";
  config.channel3.baseUrl = `http://127.0.0.1:${(c3.address() as AddressInfo).port}`;
  try {
    const pc = await (await fetch(`${base}/api/price-check?product=${encodeURIComponent("Ajrakh stole")}`)).json();
    assert.equal(pc.yourPrice, 46);
    assert.equal(pc.median, 55);
    assert.equal(pc.verdict, "below", "46 is 16% under the 55 median");
    assert.equal(pc.comparables.length, 6);
  } finally {
    c3.close();
    config.channel3.key = "";
  }
});

test("app password protects everything except the PayPal webhook", async () => {
  process.env.APP_PASSWORD = "s3cret";
  process.env.AUTOPILOT_SECRET = "auto";
  try {
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    const ok = await fetch(`${base}/api/overview`, { headers: { Authorization: "Basic " + Buffer.from("me:s3cret").toString("base64") } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${base}/api/autopilot`, { headers: { Authorization: "Bearer auto" } })).status, 200);
    assert.equal((await fetch(`${base}/api/actions`, { headers: { Authorization: "Bearer auto" } })).status, 401, "the workflow secret only opens Autopilot");
    // Webhooks get through the password but must carry a valid PayPal signature.
    assert.equal((await post("/api/paypal/webhook", { event_type: "CUSTOMER.DISPUTE.CREATED" })).status, 400);
  } finally {
    delete process.env.APP_PASSWORD;
    delete process.env.AUTOPILOT_SECRET;
  }
});

test("PayPal webhook events become readable notifications", async () => {
  const { describe } = await import("../src/events.js");
  const d = describe({ id: "WH-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_amount: { value: "85.00", currency_code: "USD" } } });
  assert.equal(d?.title, "New dispute USD 85.00");
  assert.equal(d?.page, "disputes");
  assert.equal(describe({ event_type: "SOMETHING.ELSE" }), null);
});
