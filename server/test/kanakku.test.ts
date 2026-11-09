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
