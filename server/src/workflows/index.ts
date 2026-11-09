/**
 * Kanakku on Render Workflows.
 *
 * The "autopilot" task asks the Kanakku web service which Autopilot rules are on, then runs each rule as
 * its own task in parallel, each on its own compute with retries. A slow PayPal API call or a crash in
 * one rule doesn't hold up or lose the others.
 *
 * Started by: the hourly cron job, and the web service after PayPal webhooks (see trigger.ts).
 * Needs: KANAKKU_URL (the web service's URL) and AUTOPILOT_SECRET (same value as on the web service).
 */
import { task, type TaskContext } from "@renderinc/sdk/workflows";

const base = () => {
  const url = process.env.KANAKKU_URL;
  if (!url) throw new Error("Set KANAKKU_URL to the Kanakku web service URL.");
  return (/^https?:\/\//.test(url) ? url : `https://${url}`).replace(/\/$/, "");
};

const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${process.env.AUTOPILOT_SECRET ?? ""}`,
});

const runRule = task(
  { name: "runRule", retry: { maxRetries: 3, waitDurationMs: 2000, backoffScaling: 2 }, timeoutSeconds: 300, plan: "starter" },
  async function runRule(_ctx: TaskContext, ruleId: string) {
    const res = await fetch(`${base()}/api/autopilot/run`, { method: "POST", headers: headers(), body: JSON.stringify({ trigger: "external", ruleIds: [ruleId] }) });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`Rule ${ruleId} failed: ${body.error ?? res.status}`);
    return body.results?.[0] ?? { ruleId, outcome: "nothing" };
  },
);

task(
  { name: "autopilot", timeoutSeconds: 900, plan: "starter" },
  async function autopilot(ctx: TaskContext) {
    const res = await fetch(`${base()}/api/autopilot`, { headers: headers() });
    if (!res.ok) throw new Error(`Couldn't read Autopilot rules (${res.status}).`);
    const { rules } = (await res.json()) as { rules: { id: string; enabled: boolean }[] };
    const enabled = rules.filter((r) => r.enabled).map((r) => r.id);
    const results = await Promise.all(enabled.map((id) => ctx.run(runRule, id)));
    return { ranRules: enabled.length, results };
  },
);
