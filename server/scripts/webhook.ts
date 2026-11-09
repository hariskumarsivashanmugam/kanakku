/**
 * Registers Kanakku's webhook with your PayPal app, so PayPal tells Kanakku the moment something happens.
 *
 *   npm run webhook -- --url=https://your-app.onrender.com      register (prints the PAYPAL_WEBHOOK_ID to set)
 *   npm run webhook -- --list                                   show registered webhooks
 *
 * Then set PAYPAL_WEBHOOK_ID on the server. Without it, incoming events are rejected.
 */
import { hasPayPalKeys } from "../src/config.js";
import { paypal } from "../src/paypal/client.js";

const EVENTS = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
  "INVOICING.INVOICE.PAID",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
];

const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=") as [string, string]));

async function main() {
  if (!hasPayPalKeys()) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");
  if (args.has("list")) {
    const r = await paypal<any>({ path: "/v1/notifications/webhooks" });
    for (const w of r.webhooks ?? []) console.log(`${w.id}  ${w.url}  (${w.event_types?.length ?? 0} events)`);
    if (!r.webhooks?.length) console.log("No webhooks registered yet.");
    return;
  }
  const site = args.get("url");
  if (!site || !/^https:\/\//.test(site)) throw new Error("Pass your public https URL, e.g. --url=https://kanakku.onrender.com");
  const url = site.replace(/\/$/, "").replace(/\/api\/paypal\/webhook$/, "") + "/api/paypal/webhook";
  const r = await paypal<any>({ method: "POST", path: "/v1/notifications/webhooks", body: { url, event_types: EVENTS.map((name) => ({ name })) } });
  console.log(`Registered ${url}
Set this on your server (Render → Environment):

  PAYPAL_WEBHOOK_ID=${r.id}
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
