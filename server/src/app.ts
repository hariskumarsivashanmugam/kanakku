import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getSource, getWorkshop } from "./data/index.js";
import { DemoSource } from "./data/demoSource.js";
import type { Transaction } from "./data/types.js";
import { PayPalError } from "./paypal/client.js";
import { handleWebhook, recentEvents, subscribe } from "./events.js";
import { ask, writeBrief, type ChatTurn } from "./agent/agent.js";
import { briefFacts } from "./agent/analytics.js";
import { buildOverview } from "./agent/insights.js";
import { priceCheck, unitPrice } from "./agent/pricecheck.js";
import { draftDisputeReply, draftInvoiceFromText } from "./agent/drafts.js";
import { clearActions, getAction, listActions } from "./agent/store.js";
import { getAutopilot, resetAutopilot, runAutopilot, updateRule, updateSchedule } from "./agent/autopilot.js";
import { executeAction, PROPOSE_TOOLS, runTool, type ToolContext } from "./agent/tools.js";

const DAY = 86_400_000;

/** Loads sales, invoices and disputes separately so one missing PayPal permission doesn't hide the rest. */
async function loadAll(days: number) {
  const src = getSource();
  const now = new Date();
  const [txns, invoices, disputes] = await Promise.allSettled([
    src.listTransactions({ start: new Date(now.getTime() - days * DAY).toISOString(), end: now.toISOString() }),
    src.listInvoices(),
    src.listDisputes(),
  ]);
  const parts = [
    { name: "sales", r: txns },
    { name: "invoices", r: invoices },
    { name: "disputes", r: disputes },
  ];
  const value = <T,>(r: PromiseSettledResult<T[]>) => (r.status === "fulfilled" ? r.value : []);
  return {
    now,
    txns: value(txns),
    invoices: value(invoices),
    disputes: value(disputes),
    unavailable: parts.filter((p) => p.r.status === "rejected").map((p) => p.name),
    warnings: [...new Set(parts.flatMap((p) => (p.r.status === "rejected" ? [(p.r.reason as Error).message] : [])))],
  };
}

function txnRow(t: Transaction) {
  return {
    date: t.date,
    id: t.id,
    kind: t.kind,
    customer: t.customer,
    email: t.customerEmail,
    product: t.product,
    amount: t.amount,
    fee: t.fee,
    net: t.net,
    currency: t.currency,
    status: t.status,
    refundOf: t.refundOf,
  };
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * When deployed publicly, set APP_PASSWORD so only you can open Kanakku (browser sign-in prompt).
 * PayPal webhooks are checked by signature instead, and Render's Autopilot workflow uses AUTOPILOT_SECRET.
 */
function protect(req: Request, res: Response, next: NextFunction) {
  const password = process.env.APP_PASSWORD;
  if (!password) return next();
  if (req.path === "/api/paypal/webhook" || req.path === "/api/status") return next();
  const auth = req.headers.authorization ?? "";
  const secret = process.env.AUTOPILOT_SECRET;
  if (secret && req.path.startsWith("/api/autopilot") && auth.startsWith("Bearer ") && same(auth.slice(7), secret)) return next();
  if (auth.startsWith("Basic ")) {
    const pass = Buffer.from(auth.slice(6), "base64").toString().split(":").slice(1).join(":");
    if (same(pass, password)) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Kanakku", charset="UTF-8"');
  res.status(401).send("Sign in to Kanakku");
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "200kb" }));
  app.use(protect);

  // ---------- live updates from PayPal ----------

  app.post("/api/paypal/webhook", handleWebhook);
  app.get("/api/events", subscribe);
  app.get("/api/events/recent", (_req, res) => {
    res.json(recentEvents());
  });

  app.get("/api/status", (_req, res) => {
    res.json({ dataMode: getSource().mode, aiReady: Boolean(config.anthropicKey), model: config.model, priceCheckReady: Boolean(config.channel3.key) });
  });

  // ---------- screens ----------

  app.get("/api/overview", async (_req, res) => {
    const d = await loadAll(120);
    const overview = buildOverview(d);
    const attention = briefFacts(d);
    res.json({ ...overview, attention, unavailable: d.unavailable, warnings: d.warnings });
  });

  app.get("/api/brief", async (req, res) => {
    const lang = String(req.query.lang ?? "English").slice(0, 40);
    const d = await loadAll(75);
    const facts = { ...briefFacts(d), unavailable: d.unavailable };
    const text = d.unavailable.length === 3 ? "" : await writeBrief(facts, lang);
    res.json({ facts, text, warnings: d.warnings });
  });

  app.get("/api/transactions", async (req, res) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30) || 30));
    const now = Date.now();
    const txns = await getSource().listTransactions({ start: new Date(now - days * DAY).toISOString(), end: new Date(now).toISOString() });
    const refunded = new Set(txns.filter((t) => t.kind === "refund" && t.refundOf).map((t) => t.refundOf));
    res.json(txns.map((t) => ({ ...txnRow(t), refunded: t.kind === "payment" && refunded.has(t.id) })));
  });

  app.get("/api/invoices", async (_req, res) => {
    const inv = await getSource().listInvoices();
    res.json(inv.sort((a, b) => b.issueDate.localeCompare(a.issueDate)));
  });

  app.get("/api/disputes", async (_req, res) => {
    const d = await getSource().listDisputes();
    res.json(d.sort((a, b) => (a.daysLeftToRespond ?? 999) - (b.daysLeftToRespond ?? 999)));
  });

  // ---------- workshop (artisans, jobs, payouts) ----------

  app.get("/api/workshop", async (_req, res) => {
    const ws = getWorkshop();
    const src = getSource();
    // Refresh payouts that haven't settled yet (e.g. UNCLAIMED until the artisan accepts).
    const open = ws.get().jobs.filter((j) => j.payout && !["SUCCESS", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"].includes(j.payout.status));
    await Promise.all(
      open.slice(0, 10).map(async (j) => {
        try {
          ws.setPayoutStatus(j.id, await src.getPayoutStatus(j.payout!.batchId));
        } catch {
          /* keep the last known status */
        }
      }),
    );
    const w = ws.get();
    const monthStart = new Date().toISOString().slice(0, 8) + "01";
    res.json({
      ...w,
      summary: {
        owed: w.jobs.filter((j) => j.status === "done").reduce((s, j) => s + j.pay, 0),
        owedCount: w.jobs.filter((j) => j.status === "done").length,
        inProgress: w.jobs.filter((j) => j.status === "in_progress").length,
        paidThisMonth: w.jobs.filter((j) => j.payout && j.payout.paidAt >= monthStart).reduce((s, j) => s + j.pay, 0),
        currency: "USD",
      },
    });
  });

  app.post("/api/workshop/jobs", (req, res) => {
    const b = req.body ?? {};
    try {
      res.json(
        getWorkshop().createJob({
          artisanId: String(b.artisanId ?? ""),
          title: String(b.title ?? "").trim() || "New job",
          customer: b.customer ? String(b.customer) : undefined,
          start: String(b.start ?? ""),
          end: String(b.end ?? ""),
          pay: Number(b.pay ?? 0),
        }),
      );
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.patch("/api/workshop/jobs/:id", (req, res) => {
    const b = req.body ?? {};
    const patch: Record<string, unknown> = {};
    for (const k of ["start", "end", "artisanId", "status", "title"]) if (typeof b[k] === "string") patch[k] = b[k];
    if (typeof b.pay === "number") patch.pay = b.pay;
    try {
      res.json(getWorkshop().updateJob(req.params.id, patch));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ---------- price check (Channel3) ----------

  app.get("/api/price-check", async (req, res) => {
    const product = String(req.query.product ?? "").trim();
    if (!product) return void res.status(400).json({ error: "Which product?" });
    const now = Date.now();
    const txns = await getSource().listTransactions({ start: new Date(now - 90 * DAY).toISOString(), end: new Date(now).toISOString() });
    const price = unitPrice(txns, product);
    if (price === null) return void res.status(404).json({ error: `No recent sales of ${product} to compare.` });
    try {
      res.json(await priceCheck(product, price, txns[0]?.currency ?? "USD"));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ---------- autopilot ----------

  app.get("/api/autopilot", (_req, res) => {
    res.json(getAutopilot());
  });

  app.patch("/api/autopilot/rules/:id", (req, res) => {
    try {
      res.json(updateRule(req.params.id, req.body ?? {}));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.patch("/api/autopilot/schedule", (req, res) => {
    res.json(updateSchedule(req.body ?? {}));
  });

  app.post("/api/autopilot/run", async (req, res) => {
    const trigger = ["manual", "schedule", "webhook", "external"].includes(req.body?.trigger) ? req.body.trigger : "manual";
    const ruleIds = Array.isArray(req.body?.ruleIds) ? req.body.ruleIds.map(String) : undefined;
    try {
      res.json(await runAutopilot(trigger, ruleIds));
    } catch (e) {
      res.status(409).json({ error: (e as Error).message });
    }
  });

  // ---------- assistant ----------

  app.post("/api/ask", async (req, res) => {
    const question = String(req.body?.question ?? "").trim();
    if (!question) return void res.status(400).json({ error: "Ask a question first." });
    if (question.length > 2000) return void res.status(400).json({ error: "That question is too long." });
    const history: ChatTurn[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((t: any) => (t?.role === "user" || t?.role === "assistant") && typeof t.text === "string")
          .map((t: any) => ({ role: t.role, text: t.text.slice(0, 2000) }))
      : [];
    res.json(await ask(question, history));
  });

  app.post("/api/ai/invoice-draft", async (req, res) => {
    const text = String(req.body?.text ?? "").trim();
    if (text.length < 10) return void res.status(400).json({ error: "Paste the message with the order details first." });
    res.json(await draftInvoiceFromText(text));
  });

  app.post("/api/ai/dispute-reply", async (req, res) => {
    const d = (await getSource().listDisputes()).find((x) => x.id === req.body?.disputeId);
    if (!d) return void res.status(404).json({ error: "Dispute not found." });
    res.json({ message: await draftDisputeReply(d, typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : undefined) });
  });

  // ---------- actions (always need approval) ----------

  app.get("/api/actions", (_req, res) => {
    res.json(listActions());
  });

  /** Buttons in the UI create the same pending actions the assistant does, through the same checks. */
  app.post("/api/actions/propose", async (req, res) => {
    const tool = String(req.body?.tool ?? "");
    if (!(PROPOSE_TOOLS as readonly string[]).includes(tool)) return void res.status(400).json({ error: "Unknown action." });
    const ctx: ToolContext = { question: String(req.body?.source ?? "From the app").slice(0, 200), proposed: [] };
    try {
      await runTool(tool, req.body?.input, ctx);
    } catch (e) {
      return void res.status(400).json({ error: (e as Error).message });
    }
    res.json(ctx.proposed[0]);
  });

  app.post("/api/actions/:id/approve", async (req, res) => {
    const action = getAction(req.params.id);
    if (!action) return void res.status(404).json({ error: "Action not found." });
    if (action.status !== "pending") return void res.status(409).json({ error: `This action is already ${action.status}.` });
    res.json(await executeAction(action));
  });

  app.post("/api/actions/:id/reject", (req, res) => {
    const action = getAction(req.params.id);
    if (!action) return void res.status(404).json({ error: "Action not found." });
    if (action.status !== "pending") return void res.status(409).json({ error: `This action is already ${action.status}.` });
    action.status = "rejected";
    action.decidedAt = new Date().toISOString();
    res.json(action);
  });

  app.post("/api/demo/reset", (_req, res) => {
    const src = getSource();
    if (!(src instanceof DemoSource)) return void res.status(400).json({ error: "Reset only works with demo data." });
    src.reset();
    getWorkshop().reset();
    resetAutopilot();
    clearActions();
    res.json({ ok: true });
  });

  // Serve the built web app in production.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof PayPalError && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong." });
  });

  return app;
}
