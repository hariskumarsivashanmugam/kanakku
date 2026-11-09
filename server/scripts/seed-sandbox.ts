/**
 * Fills a fresh PayPal sandbox account with realistic data so Kanakku has something to analyse:
 *   1. Wholesale invoices to boutiques (created and sent; some with past due dates so they show as overdue)
 *   2. Captured card payments, including one deliberate duplicate charge (needs SEED_TEST_CARD_NUMBER)
 *
 * Run from the repo root:  npm run seed
 * Note: new sandbox transactions can take a few hours to appear in PayPal's Transaction Search API.
 */
import { config, hasPayPalKeys } from "../src/config.js";
import { paypal, PayPalError } from "../src/paypal/client.js";

const BOUTIQUES = [
  { given: "Juniper", surname: "Thread", email: "orders@juniperthread.example.com" },
  { given: "Casa", surname: "Lino", email: "hola@casalino.example.com" },
  { given: "Nordic", surname: "Loom", email: "buying@nordicloom.example.com" },
  { given: "Indigo", surname: "Room", email: "hello@indigoroom.example.com" },
];

const PRODUCTS = [
  { name: "Kalamkari silk scarf", price: 28 },
  { name: "Block-print tote bag", price: 18 },
  { name: "Handloom cotton saree", price: 85 },
  { name: "Indigo cushion cover set", price: 40 },
  { name: "Ajrakh stole", price: 46 },
];

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function createInvoice(b: (typeof BOUTIQUES)[number], items: { name: string; qty: number; price: number }[], invoiceDaysAgo: number, termDays: number) {
  const body = (invoiceDate: string, dueDate: string) => ({
    detail: {
      currency_code: "USD",
      invoice_date: invoiceDate,
      note: "Thank you for stocking Meena Prints.",
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: dueDate },
    },
    primary_recipients: [{ billing_info: { name: { given_name: b.given, surname: b.surname }, email_address: b.email } }],
    items: items.map((i) => ({ name: i.name, quantity: String(i.qty), unit_amount: { currency_code: "USD", value: i.price.toFixed(2) } })),
  });
  let draft: any;
  try {
    draft = await paypal({ method: "POST", path: "/v2/invoicing/invoices", body: body(day(-invoiceDaysAgo), day(-invoiceDaysAgo + termDays)), headers: { Prefer: "return=representation" }, idempotent: true });
  } catch (e) {
    // Some sandbox setups reject back-dated invoices; fall back to today's date.
    console.warn(`  back-dated invoice rejected (${(e as Error).message}); using today's date instead`);
    draft = await paypal({ method: "POST", path: "/v2/invoicing/invoices", body: body(day(0), day(termDays)), headers: { Prefer: "return=representation" }, idempotent: true });
  }
  const id = draft.id ?? String(draft.href).split("/").pop();
  await paypal({ method: "POST", path: `/v2/invoicing/invoices/${id}/send`, body: { send_to_invoicer: false }, idempotent: true });
  return id as string;
}

async function cardPayment(product: (typeof PRODUCTS)[number], buyer: { given: string; surname: string; email: string }) {
  const order = await paypal({
    method: "POST",
    path: "/v2/checkout/orders",
    idempotent: true,
    headers: { Prefer: "return=representation" },
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: product.price.toFixed(2), breakdown: { item_total: { currency_code: "USD", value: product.price.toFixed(2) } } },
          items: [{ name: product.name, quantity: "1", unit_amount: { currency_code: "USD", value: product.price.toFixed(2) } }],
        },
      ],
      payment_source: {
        card: {
          number: config.seedCard.number,
          expiry: config.seedCard.expiry,
          name: `${buyer.given} ${buyer.surname}`,
        },
      },
    },
  });
  // Card orders with intent CAPTURE usually complete immediately; otherwise capture explicitly.
  if (order.status !== "COMPLETED") {
    const cap = await paypal({ method: "POST", path: `/v2/checkout/orders/${order.id}/capture`, body: {}, idempotent: true });
    return cap.purchase_units?.[0]?.payments?.captures?.[0]?.id as string;
  }
  return order.purchase_units?.[0]?.payments?.captures?.[0]?.id as string;
}

async function main() {
  if (!hasPayPalKeys()) {
    console.error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env first.");
    process.exit(1);
  }
  if (!config.paypal.baseUrl.includes("sandbox")) {
    console.error(`Refusing to seed a non-sandbox account (${config.paypal.baseUrl}).`);
    process.exit(1);
  }

  console.log("Creating and sending invoices…");
  const specs: [number, { name: string; qty: number; price: number }[], number, number][] = [
    [0, [{ name: "Kalamkari silk scarf (wholesale)", qty: 20, price: 19 }], 40, 14],
    [1, [{ name: "Block-print tote bag (wholesale)", qty: 30, price: 11 }], 31, 14],
    [2, [{ name: "Handloom cotton saree (wholesale)", qty: 12, price: 62 }], 19, 14],
    [3, [{ name: "Ajrakh stole (wholesale)", qty: 15, price: 32 }], 6, 14],
  ];
  for (const [b, items, ago, term] of specs) {
    try {
      const id = await createInvoice(BOUTIQUES[b], items, ago, term);
      console.log(`  ✓ invoice ${id} → ${BOUTIQUES[b].given} ${BOUTIQUES[b].surname}`);
    } catch (e) {
      console.warn(`  ✗ invoice for ${BOUTIQUES[b].given}: ${(e as Error).message}`);
    }
  }

  if (!config.seedCard.number) {
    console.log("\nSkipping card payments: set SEED_TEST_CARD_NUMBER in .env to a sandbox test card");
    console.log("(generate one at https://developer.paypal.com/tools/sandbox/card-testing/).");
  } else {
    console.log("\nCreating captured card payments…");
    const buyers = [
      { given: "Emma", surname: "Schultz", email: "emma.schultz@example.com" },
      { given: "Aiko", surname: "Tanaka", email: "aiko.tanaka@example.com" },
      { given: "Lucas", surname: "Martin", email: "lucas.martin@example.com" },
    ];
    let made = 0;
    for (let i = 0; i < 9; i++) {
      const p = PRODUCTS[i % PRODUCTS.length];
      const b = buyers[i % buyers.length];
      try {
        const cap = await cardPayment(p, b);
        console.log(`  ✓ ${p.name} – ${b.given} (capture ${cap})`);
        made++;
        if (i === 2) {
          const dup = await cardPayment(p, b);
          console.log(`  ✓ duplicate charge for ${b.given} (capture ${dup})`);
        }
      } catch (e) {
        const msg = e instanceof PayPalError ? e.message : String(e);
        console.warn(`  ✗ card payment failed: ${msg}`);
        if (made === 0) {
          console.warn("    Card payments may need Advanced Credit and Debit Card payments enabled on your sandbox app.");
          break;
        }
      }
    }
  }

  console.log("\nDone. Invoices show up right away; new payments can take a few hours to appear in Transaction Search.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
