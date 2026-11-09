import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getSource } from "./data/index.js";
import { DemoSource } from "./data/demoSource.js";
import { ask, writeBrief, type ChatTurn } from "./agent/agent.js";
import { briefFacts } from "./agent/analytics.js";
import { clearActions, getAction, listActions } from "./agent/store.js";
import { executeAction } from "./agent/tools.js";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "200kb" }));

  app.get("/api/status", (_req, res) => {
    res.json({ dataMode: getSource().mode, aiReady: Boolean(config.anthropicKey), model: config.model });
  });

  app.get("/api/brief", async (req, res) => {
    const lang = String(req.query.lang ?? "English").slice(0, 40);
    const src = getSource();
    const now = new Date();
    // Load each part separately so one missing PayPal permission doesn't hide everything else.
    const [txns, invoices, disputes] = await Promise.allSettled([
      src.listTransactions({ start: new Date(now.getTime() - 75 * 86_400_000).toISOString(), end: now.toISOString() }),
      src.listInvoices(),
      src.listDisputes(),
    ]);
    const parts = [
      { name: "sales", r: txns },
      { name: "invoices", r: invoices },
      { name: "disputes", r: disputes },
    ];
    const unavailable = parts.filter((p) => p.r.status === "rejected").map((p) => p.name);
    const warnings = [
      ...new Set(parts.flatMap((p) => (p.r.status === "rejected" ? [(p.r.reason as Error).message] : []))),
    ];
    const value = <T,>(r: PromiseSettledResult<T[]>) => (r.status === "fulfilled" ? r.value : []);
    const facts = { ...briefFacts({ txns: value(txns), invoices: value(invoices), disputes: value(disputes), now }), unavailable };
    const text = unavailable.length === parts.length ? "" : await writeBrief(facts, lang);
    res.json({ facts, text, warnings });
  });

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

  app.get("/api/actions", (_req, res) => {
    res.json(listActions());
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
    console.error(err);
    res.status(500).json({ error: err.message || "Something went wrong." });
  });

  return app;
}
