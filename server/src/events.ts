import type { Request, Response } from "express";
import { config } from "./config.js";
import { getSource } from "./data/index.js";
import { addToLedger } from "./data/ledger.js";
import { PayPalSource } from "./data/paypalSource.js";
import { paypal } from "./paypal/client.js";
import { runAutopilot } from "./agent/autopilot.js";
import { startWorkflowRun } from "./workflows/trigger.js";

/**
 * PayPal webhooks → live updates. PayPal calls /api/paypal/webhook when something happens on the account;
 * Kanakku verifies the signature with PayPal, records new orders, tells open browsers (server-sent events),
 * and lets Autopilot react (through a Render Workflow when configured, otherwise in-process).
 */

export interface LiveEvent {
  id: string;
  at: string;
  type: string;
  title: string;
  detail: string;
  page?: string;
}

const clients = new Set<Response>();
const recent: LiveEvent[] = [];

export function subscribe(req: Request, res: Response) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": connected\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function broadcast(e: Omit<LiveEvent, "at">) {
  const event = { ...e, at: new Date().toISOString() };
  recent.unshift(event);
  recent.splice(30);
  for (const c of clients) c.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function recentEvents() {
  return recent;
}

async function verify(req: Request): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const h = (k: string) => String(req.headers[k] ?? "");
  try {
    const r = await paypal<{ verification_status: string }>({
      method: "POST",
      path: "/v1/notifications/verify-webhook-signature",
      body: {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: req.body,
      },
    });
    return r.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}

let autopilotTimer: NodeJS.Timeout | null = null;

/** Several events often arrive together; run Autopilot once, shortly after the last one. */
function reactWithAutopilot() {
  if (autopilotTimer) clearTimeout(autopilotTimer);
  autopilotTimer = setTimeout(async () => {
    autopilotTimer = null;
    try {
      if (await startWorkflowRun()) return; // Render Workflow calls back into /api/autopilot/run
      await runAutopilot("webhook");
    } catch {
      /* a failed reaction is visible in Autopilot's run history */
    }
  }, 5_000);
  autopilotTimer.unref();
}

const money = (amount?: { value?: string; currency_code?: string }) => (amount?.value ? `${amount.currency_code ?? "USD"} ${amount.value}` : "");

export function describe(event: any): Omit<LiveEvent, "at"> | null {
  const r = event.resource ?? {};
  const id = String(event.id ?? Date.now());
  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED":
      return { id, type: event.event_type, title: `New payment ${money(r.amount)}`, detail: "A customer just paid.", page: "sales" };
    case "PAYMENT.CAPTURE.REFUNDED":
      return { id, type: event.event_type, title: `Refund completed ${money(r.amount)}`, detail: "PayPal confirmed a refund.", page: "sales" };
    case "CUSTOMER.DISPUTE.CREATED":
      return { id, type: event.event_type, title: `New dispute ${money(r.dispute_amount)}`, detail: "A buyer opened a case. Kanakku will draft a reply if the deadline is close.", page: "disputes" };
    case "CUSTOMER.DISPUTE.UPDATED":
      return { id, type: event.event_type, title: "A dispute was updated", detail: `Case ${r.dispute_id ?? ""} changed.`, page: "disputes" };
    case "CUSTOMER.DISPUTE.RESOLVED":
      return { id, type: event.event_type, title: "A dispute was resolved", detail: `Case ${r.dispute_id ?? ""} is closed.`, page: "disputes" };
    case "INVOICING.INVOICE.PAID":
      return { id, type: event.event_type, title: `Invoice paid ${money(r.invoice?.amount ?? r.amount)}`, detail: `${r.invoice?.detail?.invoice_number ? `Invoice ${r.invoice.detail.invoice_number}` : "An invoice"} was paid.`, page: "invoices" };
    case "PAYMENT.PAYOUTS-ITEM.SUCCEEDED":
      return { id, type: event.event_type, title: `Payout received ${money(r.payout_item?.amount)}`, detail: "An artisan received their payment.", page: "workshop" };
    case "PAYMENT.PAYOUTS-ITEM.UNCLAIMED":
      return { id, type: event.event_type, title: "Payout waiting to be claimed", detail: "The artisan needs to accept the payment in PayPal.", page: "workshop" };
    default:
      return null;
  }
}

export async function handleWebhook(req: Request, res: Response) {
  if (!(await verify(req))) return void res.status(400).json({ error: "Webhook signature could not be verified." });
  const event = req.body ?? {};
  // Acknowledge quickly; PayPal retries slow endpoints.
  res.json({ ok: true });

  const r = event.resource ?? {};
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const orderId = r.supplementary_data?.related_ids?.order_id;
    if (orderId) addToLedger(config.paypal.baseUrl, config.paypal.clientId, [orderId]);
  }
  const src = getSource();
  if (src instanceof PayPalSource) src.clearCache();

  const d = describe(event);
  if (d) broadcast(d);
  if (["CUSTOMER.DISPUTE.CREATED", "PAYMENT.CAPTURE.COMPLETED", "INVOICING.INVOICE.PAID"].includes(event.event_type)) reactWithAutopilot();
}
