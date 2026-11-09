/**
 * Fills your PayPal SANDBOX account with realistic data for "Meena Prints", so every Kanakku screen
 * has something real to show:
 *
 *   1. Card payments across six products from repeat and one-time customers (PayPal's published test cards)
 *   2. Two accidental duplicate charges
 *   3. Refunds: a cluster on the Indigo cushion covers (the "colour runs" story) plus one partial refund
 *   4. Wholesale invoices to boutiques: sent, overdue, paid and a draft
 *   5. Optional: one PayPal-wallet checkout that you approve as your sandbox buyer, so you can open a
 *      real dispute against it (PayPal only lets buyers open disputes)
 *
 * Run from the repo root:
 *   npm run seed                         everything except the buyer checkout
 *   npm run seed -- --payments=40        fewer card payments (default 60)
 *   npm run seed -- --only=invoices      just invoices (or: payments)
 *   npm run seed -- --buyer-checkout     the dispute walkthrough
 *
 * Sandbox only: the script refuses to run against api-m.paypal.com.
 */
import { randomUUID } from "node:crypto";
import { config, hasPayPalKeys } from "../src/config.js";
import { paypal, PayPalError } from "../src/paypal/client.js";

// ---------------- options ----------------

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"] as const;
  }),
);
const PAYMENTS = Math.max(0, Math.min(200, Number(args.get("payments") ?? 60)));
const ONLY = args.get("only"); // "payments" | "invoices"
const BUYER_CHECKOUT = args.has("buyer-checkout");

// PayPal's published sandbox test card (developer.paypal.com → Card testing). Override in .env if you like.
const CARD = config.seedCard.number || "4012000033330026";
const EXPIRY = config.seedCard.expiry || "2030-12";

// ---------------- shop data ----------------

const PRODUCTS = [
  { name: "Handloom cotton saree", price: 85, weight: 3 },
  { name: "Ajrakh stole", price: 46, weight: 3 },
  { name: "Indigo cushion cover set", price: 40, weight: 3 },
  { name: "Kalamkari silk scarf", price: 28, weight: 2 },
  { name: "Block-print table runner", price: 34, weight: 2 },
  { name: "Block-print tote bag", price: 18, weight: 2 },
];

const LOYAL = ["Emma Schultz", "Sofia Rossi", "Aiko Tanaka", "Lucas Martin"];
const FIRST = ["Olivia", "James", "Amelia", "Henry", "Lily", "Thomas", "Ruby", "Felix", "Ines", "Pablo", "Yuki", "Anna", "Jonas", "Clara", "Maya", "Rahul", "Kavya", "Laura", "Marco", "Nina"];
const LAST = ["Taylor", "Moreau", "Schneider", "Hughes", "Bianchi", "Walsh", "Sato", "Andersen", "Ferreira", "Jansen", "Murphy", "Iyer", "Clarke", "Weber", "Laurent", "Romano", "Park", "Silva", "Novak", "Berg"];

const ADDRESSES = [
  { address_line_1: "12 Harbour Street", admin_area_2: "Sydney", admin_area_1: "NSW", postal_code: "2000", country_code: "AU" },
  { address_line_1: "48 Elm Road", admin_area_2: "Portland", admin_area_1: "OR", postal_code: "97205", country_code: "US" },
  { address_line_1: "7 Kings Lane", admin_area_2: "London", postal_code: "N1 9GU", country_code: "GB" },
  { address_line_1: "21 Maple Avenue", admin_area_2: "Toronto", admin_area_1: "ON", postal_code: "M5V 2T6", country_code: "CA" },
  { address_line_1: "5 Rue des Fleurs", admin_area_2: "Lyon", postal_code: "69002", country_code: "FR" },
];

const BOUTIQUES = [
  { given: "Juniper", surname: "& Thread", email: "orders@juniperthread.example.com" },
  { given: "Casa", surname: "Lino", email: "hola@casalino.example.com" },
  { given: "Nordic Loom", surname: "Co.", email: "buying@nordicloom.example.com" },
  { given: "The Indigo", surname: "Room", email: "hello@indigoroom.example.com" },
  { given: "Maple Street", surname: "Living", email: "shop@maplestreet.example.com" },
];

// Deterministic so a re-run produces a similar mix.
let seed = 20261109;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
const weighted = () => {
  const total = PRODUCTS.reduce((s, p) => s + p.weight, 0);
  let r = rnd() * total;
  for (const p of PRODUCTS) if ((r -= p.weight) < 0) return p;
  return PRODUCTS[0];
};
const customer = () => (rnd() < 0.3 ? pick(LOYAL) : `${pick(FIRST)} ${pick(LAST)}`);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const usd = (n: number) => ({ currency_code: "USD", value: n.toFixed(2) });

// ---------------- card payments ----------------

interface Paid {
  captureId: string;
  product: string;
  amount: number;
  customer: string;
}

async function cardPayment(product: (typeof PRODUCTS)[number], buyer: string, qty = 1): Promise<Paid> {
  const amount = product.price * qty;
  const address = pick(ADDRESSES);
  const order = await paypal<any>({
    method: "POST",
    path: "/v2/checkout/orders",
    headers: { "PayPal-Request-Id": randomUUID(), Prefer: "return=representation" },
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: product.name,
          amount: { ...usd(amount), breakdown: { item_total: usd(amount) } },
          items: [{ name: product.name, quantity: String(qty), unit_amount: usd(product.price), category: "PHYSICAL_GOODS" }],
          shipping: { name: { full_name: buyer }, address },
        },
      ],
      payment_source: {
        card: {
          number: CARD,
          expiry: EXPIRY,
          security_code: "123",
          name: buyer,
          billing_address: address,
        },
      },
    },
  });
  let capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture && order.status !== "COMPLETED") {
    const cap = await paypal<any>({ method: "POST", path: `/v2/checkout/orders/${order.id}/capture`, body: {}, idempotent: true });
    capture = cap.purchase_units?.[0]?.payments?.captures?.[0];
  }
  if (!capture?.id) throw new Error(`Order ${order.id} was not captured (status ${order.status}).`);
  return { captureId: capture.id, product: product.name, amount, customer: buyer };
}

async function refund(p: Paid, amount?: number, note?: string) {
  await paypal({
    method: "POST",
    path: `/v2/payments/captures/${p.captureId}/refund`,
    idempotent: true,
    body: { ...(amount ? { amount: usd(amount) } : {}), note_to_payer: note },
  });
}

async function inPool<T, R>(items: T[], size: number, fn: (t: T, i: number) => Promise<R>) {
  const out: (R | Error)[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i], i);
        } catch (e) {
          out[i] = e as Error;
        }
      }
    }),
  );
  return out;
}

function explainCardError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING|NOT_ENABLED|card/i.test(msg)) {
    return `${msg}
    Your sandbox business account can't take card payments. Fix: developer.paypal.com → Sandbox accounts →
    Create account → Business, country "United States". Then Apps & Credentials → Create app linked to that
    account, make sure "Advanced Credit and Debit Card Payments" is on under Features, and use that app's keys.`;
  }
  return msg;
}

async function seedPayments() {
  console.log(`\nCard payments (${PAYMENTS}) using test card ending ${CARD.slice(-4)}…`);
  const plan = Array.from({ length: PAYMENTS }, () => ({ product: weighted(), buyer: customer(), qty: rnd() < 0.15 ? 2 : 1 }));

  // Fail fast with a clear message if cards aren't enabled.
  let first: Paid;
  try {
    first = await cardPayment(plan[0].product, plan[0].buyer, plan[0].qty);
  } catch (e) {
    console.error("  ✗ First card payment failed:\n    " + explainCardError(e));
    return [];
  }
  const rest = await inPool(plan.slice(1), 4, (p) => cardPayment(p.product, p.buyer, p.qty));
  const paid = [first, ...rest.filter((r): r is Paid => !(r instanceof Error))];
  const failed = rest.filter((r) => r instanceof Error) as Error[];
  console.log(`  ✓ ${paid.length} payments captured${failed.length ? `, ${failed.length} failed (first error: ${failed[0].message})` : ""}`);

  // Duplicate charges: the same buyer charged twice for the same item a moment apart.
  for (const [buyer, productName] of [
    ["Mia Johansson", "Ajrakh stole"],
    ["Daniel Kim", "Handloom cotton saree"],
  ] as const) {
    const product = PRODUCTS.find((p) => p.name === productName)!;
    try {
      paid.push(await cardPayment(product, buyer));
      paid.push(await cardPayment(product, buyer));
      console.log(`  ✓ duplicate charge: ${buyer} × 2 for ${productName}`);
    } catch (e) {
      console.warn(`  ✗ duplicate for ${buyer}: ${(e as Error).message}`);
    }
  }

  // Refunds: Indigo cushion covers come back far more often ("the colour ran"), plus one partial refund.
  const indigo = paid.filter((p) => p.product === "Indigo cushion cover set");
  const toRefund = indigo.filter((_, i) => i % 3 === 0);
  let refunded = 0;
  for (const p of toRefund) {
    try {
      await refund(p, undefined, "Sorry the colour ran. Full refund issued.");
      refunded++;
    } catch (e) {
      console.warn(`  ✗ refund ${p.captureId}: ${(e as Error).message}`);
    }
  }
  const saree = paid.find((p) => p.product === "Handloom cotton saree" && !LOYAL.includes(p.customer));
  if (saree) {
    try {
      await refund(saree, 20, "Partial refund for the delayed delivery.");
      refunded++;
    } catch (e) {
      console.warn(`  ✗ partial refund: ${(e as Error).message}`);
    }
  }
  console.log(`  ✓ ${refunded} refunds (${toRefund.length} on Indigo cushion covers, 1 partial)`);
  return paid;
}

// ---------------- invoices ----------------

async function createInvoice(b: (typeof BOUTIQUES)[number], items: { name: string; qty: number; price: number }[], daysAgo: number, termDays: number) {
  const body = (invoiceDate: string, dueDate: string) => ({
    detail: {
      currency_code: "USD",
      invoice_date: invoiceDate,
      note: "Thank you for stocking Meena Prints.",
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: dueDate },
    },
    primary_recipients: [{ billing_info: { name: { given_name: b.given, surname: b.surname }, email_address: b.email } }],
    items: items.map((i) => ({ name: i.name, quantity: String(i.qty), unit_amount: usd(i.price) })),
  });
  let draft: any;
  let backdated = true;
  try {
    draft = await paypal({ method: "POST", path: "/v2/invoicing/invoices", body: body(day(-daysAgo), day(-daysAgo + termDays)), headers: { Prefer: "return=representation" }, idempotent: true });
  } catch {
    backdated = false;
    draft = await paypal({ method: "POST", path: "/v2/invoicing/invoices", body: body(day(0), day(termDays)), headers: { Prefer: "return=representation" }, idempotent: true });
  }
  const id: string = draft.id ?? String(draft.href).split("/").pop();
  const total = items.reduce((s, i) => s + i.qty * i.price, 0);
  return { id, total, backdated };
}

async function seedInvoices() {
  console.log("\nWholesale invoices…");
  const specs: { b: number; items: { name: string; qty: number; price: number }[]; ago: number; outcome: "paid" | "part" | "sent" | "draft" }[] = [
    { b: 0, items: [{ name: "Kalamkari silk scarf (wholesale)", qty: 20, price: 19 }], ago: 45, outcome: "paid" },
    { b: 2, items: [{ name: "Handloom cotton saree (wholesale)", qty: 12, price: 62 }], ago: 40, outcome: "sent" },
    { b: 4, items: [{ name: "Block-print tote bag (wholesale)", qty: 30, price: 11 }], ago: 31, outcome: "sent" },
    { b: 0, items: [{ name: "Ajrakh stole (wholesale)", qty: 15, price: 32 }, { name: "Block-print table runner (wholesale)", qty: 10, price: 24 }], ago: 24, outcome: "part" },
    { b: 1, items: [{ name: "Indigo cushion cover set (wholesale)", qty: 25, price: 28 }], ago: 19, outcome: "sent" },
    { b: 3, items: [{ name: "Ajrakh stole (wholesale)", qty: 12, price: 32 }], ago: 12, outcome: "paid" },
    { b: 3, items: [{ name: "Handloom cotton saree (wholesale)", qty: 8, price: 62 }], ago: 6, outcome: "sent" },
    { b: 1, items: [{ name: "Block-print table runner (wholesale)", qty: 18, price: 24 }], ago: 0, outcome: "draft" },
  ];
  let backdatedAll = true;
  for (const s of specs) {
    const b = BOUTIQUES[s.b];
    const who = `${b.given} ${b.surname}`;
    try {
      const inv = await createInvoice(b, s.items, s.ago, 14);
      backdatedAll &&= inv.backdated;
      if (s.outcome !== "draft") {
        await paypal({ method: "POST", path: `/v2/invoicing/invoices/${inv.id}/send`, body: { send_to_invoicer: false, send_to_recipient: true }, idempotent: true });
      }
      if (s.outcome === "paid" || s.outcome === "part") {
        // Record a bank transfer from the boutique.
        const amount = s.outcome === "paid" ? inv.total : Math.round(inv.total / 2);
        await paypal({
          method: "POST",
          path: `/v2/invoicing/invoices/${inv.id}/payments`,
          body: { method: "BANK_TRANSFER", payment_date: day(-Math.max(0, s.ago - 10)), amount: usd(amount), note: "Received by bank transfer" },
          idempotent: true,
        });
      }
      console.log(`  ✓ ${s.outcome.padEnd(5)} USD ${inv.total.toFixed(2).padStart(8)}  ${who}`);
    } catch (e) {
      console.warn(`  ✗ invoice for ${who}: ${(e as Error).message}`);
    }
  }
  if (!backdatedAll) console.log("  Note: PayPal refused back-dated invoices, so they are dated today and none will be overdue yet.");
}

// ---------------- buyer checkout for a real dispute ----------------

async function buyerCheckout() {
  const product = PRODUCTS[0];
  console.log("\nBuyer checkout (for a real dispute)…");
  const order = await paypal<any>({
    method: "POST",
    path: "/v2/checkout/orders",
    idempotent: true,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          description: product.name,
          amount: { ...usd(product.price), breakdown: { item_total: usd(product.price) } },
          items: [{ name: product.name, quantity: "1", unit_amount: usd(product.price), category: "PHYSICAL_GOODS" }],
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Meena Prints",
            user_action: "PAY_NOW",
            shipping_preference: "GET_FROM_FILE",
            return_url: "https://example.com/kanakku/approved",
            cancel_url: "https://example.com/kanakku/cancelled",
          },
        },
      },
    },
  });
  const link = order.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve")?.href;
  console.log(`
  1. Open this link and log in with your sandbox PERSONAL (buyer) account
     (developer.paypal.com → Sandbox accounts → the "personal" account → View/Edit for its email and password):

     ${link}

  2. Click "Pay Now". You'll land on an example.com page that doesn't load. That's expected.

  Waiting for approval (up to 10 minutes)…`);

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const o = await paypal<any>({ path: `/v2/checkout/orders/${order.id}` });
    if (o.status === "APPROVED") {
      const cap = await paypal<any>({ method: "POST", path: `/v2/checkout/orders/${order.id}/capture`, body: {}, idempotent: true });
      const capture = cap.purchase_units?.[0]?.payments?.captures?.[0];
      console.log(`  ✓ Paid by your sandbox buyer (capture ${capture?.id}).

  3. Now open the dispute, as the buyer:
     sandbox.paypal.com → log in as the PERSONAL account → find the Meena Prints payment in Activity →
     "Report a problem" (or Help → Resolution Center) → "I didn't receive an item I bought" → describe it,
     e.g. "It's been two weeks and the saree hasn't arrived."

  The dispute shows up on Kanakku's Disputes screen within a few minutes, with its deadline and the buyer's message.`);
      return;
    }
    if (o.status === "VOIDED") break;
  }
  console.log("  Not approved in time. Run `npm run seed -- --buyer-checkout` again when you're ready.");
}

// ---------------- main ----------------

async function main() {
  if (!hasPayPalKeys()) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");
    process.exit(1);
  }
  if (!config.paypal.baseUrl.includes("sandbox")) {
    console.error(`Refusing to seed a non-sandbox account (${config.paypal.baseUrl}).`);
    process.exit(1);
  }

  try {
    await paypal({ path: "/v2/invoicing/invoices", query: { page_size: 1 } });
  } catch (e) {
    if (e instanceof PayPalError && e.status === 401) {
      console.error(`PayPal rejected your keys: ${e.message}`);
      process.exit(1);
    }
  }

  if (BUYER_CHECKOUT) return buyerCheckout();
  if (ONLY !== "invoices") await seedPayments();
  if (ONLY !== "payments") await seedInvoices();

  console.log(`
Done. In Kanakku (DATA_MODE=auto or live):
  • Invoices appear right away on the Invoices screen.
  • Payments, refunds and duplicate charges appear on Overview and Sales once Transaction search is enabled
    on your app. PayPal can take a few hours to list new sandbox payments.
  • For a real dispute, run: npm run seed -- --buyer-checkout`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
