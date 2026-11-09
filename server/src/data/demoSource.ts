import type { DataSource, Dispute, Invoice, NewInvoiceInput, Transaction } from "./types.js";
import { addDays, daysBetween, round2, todayISO } from "./util.js";

/**
 * A realistic, deterministic demo store for "Meena Prints", a small hand-block-printing
 * studio in Coimbatore that sells internationally through PayPal. Used when no PayPal
 * keys are set, so anyone can run the app. Actions (refunds, reminders, invoices)
 * really change this store, so the demo behaves end to end.
 */

const PRODUCTS = [
  { name: "Kalamkari silk scarf", price: 28 },
  { name: "Block-print tote bag", price: 18 },
  { name: "Handloom cotton saree", price: 85 },
  { name: "Indigo cushion cover set", price: 40 },
  { name: "Block-print table runner", price: 34 },
  { name: "Ajrakh stole", price: 46 },
];

const CUSTOMERS = [
  "Emma Schultz", "Liam O'Brien", "Sofia Rossi", "Noah Williams", "Aiko Tanaka", "Lucas Martin",
  "Chloe Dubois", "Mateo García", "Hannah Becker", "Oliver Smith", "Priya Raman", "Isabella Costa",
  "Ethan Brown", "Mia Johansson", "Daniel Kim", "Zara Ahmed", "Grace Lee", "Leo Fischer",
  "Ava Thompson", "Arjun Mehta", "Nora Lindqvist", "Samuel Okafor", "Ella Novak", "Jack Wilson",
];

// Most buyers order once or twice; a handful of loyal customers come back often.
const FIRST = ["Olivia", "James", "Amelia", "Henry", "Lily", "Thomas", "Ruby", "Max", "Freya", "Felix", "Ines", "Pablo",
  "Yuki", "Kenji", "Anna", "Jonas", "Clara", "Elias", "Maya", "Rahul", "Ananya", "Kavya", "Sara", "David", "Laura",
  "Marco", "Giulia", "Nina", "Tom", "Alice"];
const LAST = ["Taylor", "Moreau", "Schneider", "Hughes", "Bianchi", "Walsh", "Sato", "Andersen", "Ferreira", "Jansen",
  "Kowalski", "Murphy", "Iyer", "Nair", "Varga", "Clarke", "Weber", "Laurent", "Romano", "Evans", "Park", "Silva",
  "Patel", "Novak", "Berg", "Russo", "Hall", "Kaur", "Dubois", "Lopez"];
const LOYAL = CUSTOMERS.slice(0, 6);

const BOUTIQUES = [
  { name: "Juniper & Thread", email: "orders@juniperthread.example.com" },
  { name: "Casa Lino", email: "hola@casalino.example.com" },
  { name: "Nordic Loom Co.", email: "buying@nordicloom.example.com" },
  { name: "The Indigo Room", email: "hello@indigoroom.example.com" },
  { name: "Maple Street Living", email: "shop@maplestreet.example.com" },
];

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const emailOf = (name: string) =>
  name.toLowerCase().replace(/[^a-z ]/g, "").replace(/ /g, ".") + "@example.com";

const fee = (amount: number) => round2(amount * 0.044 + 0.3);

let idCounter = 1000;
const ID_CHARS = "0123456789ABCDEFGHJKLMNPRSTUVWXY";
/** 17-character ids shaped like PayPal transaction ids, unique via a counter in the tail. */
const newId = (prefix: string, r: () => number) => {
  let body = prefix;
  while (body.length < 13) body += ID_CHARS[Math.floor(r() * ID_CHARS.length)];
  return body + (idCounter++).toString(32).toUpperCase().padStart(4, "0");
};

export function buildDemoData(now = new Date()) {
  const r = rng(20261109);
  idCounter = 1000;
  const txns: Transaction[] = [];
  const DAYS = 120;

  for (let d = DAYS; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86_400_000);
    // Business is growing: more orders in recent weeks, a festive bump around Diwali (late Oct).
    const growth = 1 + (DAYS - d) / DAYS;
    const festive = d >= 10 && d <= 22 ? 1.8 : 1;
    const orders = Math.round((1 + r() * 3) * growth * festive);
    for (let i = 0; i < orders; i++) {
      const p = PRODUCTS[Math.floor(r() * PRODUCTS.length)];
      const qty = r() < 0.8 ? 1 : 2;
      const customer =
        r() < 0.14
          ? LOYAL[Math.floor(r() * LOYAL.length)]
          : `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
      const ts = new Date(day);
      ts.setUTCHours(Math.floor(r() * 24), Math.floor(r() * 60), Math.floor(r() * 60));
      if (ts > now) continue;
      const amount = p.price * qty;
      const t: Transaction = {
        id: newId("4", r),
        date: ts.toISOString(),
        kind: "payment",
        status: "completed",
        amount,
        fee: fee(amount),
        net: round2(amount - fee(amount)),
        currency: "USD",
        customer,
        customerEmail: emailOf(customer),
        product: qty > 1 ? `${p.name} ×${qty}` : p.name,
      };
      txns.push(t);

      // Refunds: the indigo cushion covers get refunded far more often (a "colour bleeds" problem).
      const refundChance = p.name.startsWith("Indigo") ? 0.28 : 0.03;
      if (r() < refundChance) {
        const rts = new Date(ts.getTime() + (2 + r() * 8) * 86_400_000);
        if (rts < now) {
          txns.push({
            ...t,
            id: newId("9", r),
            date: rts.toISOString(),
            kind: "refund",
            amount: -amount,
            fee: 0,
            net: -amount,
            refundOf: t.id,
          });
        }
      }
    }
  }

  // Two accidental duplicate charges in the last two weeks (same buyer, same amount, minutes apart).
  for (const [daysAgo, ci, pi] of [
    [3, 4, 2],
    [9, 13, 5],
  ] as const) {
    const base = new Date(now.getTime() - daysAgo * 86_400_000);
    base.setUTCHours(6, 12, 0);
    const p = PRODUCTS[pi];
    const c = CUSTOMERS[ci];
    for (const offsetMin of [0, 2]) {
      txns.push({
        id: newId("4", r),
        date: new Date(base.getTime() + offsetMin * 60_000).toISOString(),
        kind: "payment",
        status: "completed",
        amount: p.price,
        fee: fee(p.price),
        net: round2(p.price - fee(p.price)),
        currency: "USD",
        customer: c,
        customerEmail: emailOf(c),
        product: p.name,
      });
    }
  }

  // Monthly withdrawals to the seller's Indian bank account.
  for (const daysAgo of [95, 65, 35, 5]) {
    const amt = -round2(1200 + r() * 900);
    txns.push({
      id: newId("7", r),
      date: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
      kind: "payout",
      status: "completed",
      amount: amt,
      fee: 0,
      net: amt,
      currency: "USD",
      customer: "Bank withdrawal",
      customerEmail: "",
      product: "Transfer to bank",
    });
  }

  txns.sort((a, b) => b.date.localeCompare(a.date));

  // Wholesale invoices to boutiques.
  const today = todayISO();
  const invoiceSpecs: [number, number, number, Invoice["status"]][] = [
    // [boutique, amount, issued days ago, status]
    [0, 640, 52, "PAID"],
    [1, 420, 45, "PAID"],
    [2, 1180, 40, "SENT"], // overdue
    [3, 560, 33, "PAID"],
    [4, 310, 31, "SENT"], // overdue
    [0, 720, 24, "PARTIALLY_PAID"], // overdue
    [1, 890, 19, "SENT"], // overdue
    [2, 450, 12, "PAID"],
    [3, 980, 8, "SENT"],
    [4, 275, 4, "SENT"],
    [0, 520, 2, "DRAFT"],
  ];
  const invoices: Invoice[] = invoiceSpecs.map(([b, amount, ago, status], i) => {
    const issue = addDays(now.toISOString(), -ago).slice(0, 10);
    const due = addDays(issue, 14).slice(0, 10);
    const open = ["SENT", "PARTIALLY_PAID"].includes(status);
    const amountDue = status === "PAID" ? 0 : status === "PARTIALLY_PAID" ? round2(amount / 2) : amount;
    return {
      id: `INV2-DEMO-${(4211 + i).toString()}-${["K7Q", "M2Z", "P9X", "T4L", "W8C", "B3N", "D6R", "F1V", "H5J", "J2S", "L8G"][i]}`,
      number: `MP-${(1041 + i).toString()}`,
      status,
      customer: BOUTIQUES[b].name,
      customerEmail: BOUTIQUES[b].email,
      amount,
      amountDue,
      currency: "USD",
      issueDate: issue,
      dueDate: due,
      daysOverdue: open ? Math.max(0, daysBetween(due, today)) : 0,
    };
  });

  const payments = txns.filter((t) => t.kind === "payment");
  // Each dispute is about an order placed 10–20 days before the case was opened, from a different customer.
  const used = new Set<string>();
  const pick = (openedDaysAgo: number, product?: string) => {
    const from = now.getTime() - (openedDaysAgo + 20) * 86_400_000;
    const to = now.getTime() - (openedDaysAgo + 10) * 86_400_000;
    const t =
      payments.find((x) => {
        const ms = Date.parse(x.date);
        return ms >= from && ms <= to && !used.has(x.customer) && !LOYAL.includes(x.customer) && (!product || x.product.startsWith(product));
      }) ?? payments[used.size * 7 + 6];
    used.add(t.customer);
    return t;
  };
  const disputes: Dispute[] = [
    {
      tx: pick(8, "Handloom"),
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      created: 8,
      dueIn: 2 as number | undefined,
      message: "It has been over two weeks and my order still hasn't arrived. The tracking page hasn't updated since it left India. I'd like a refund please.",
    },
    {
      tx: pick(5, "Indigo cushion"),
      reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      created: 5,
      dueIn: 9,
      message: "The colour ran the first time I washed it and stained my other clothes. The listing said colourfast natural dyes.",
    },
    { tx: pick(30, "Ajrakh"), reason: "UNAUTHORISED", status: "RESOLVED", created: 30, dueIn: undefined, message: "I don't recognise this charge." },
  ].map((d, i) => {
    const due = d.dueIn === undefined ? undefined : addDays(now.toISOString(), d.dueIn);
    return {
      id: `PP-D-${(70421 + i * 37).toString()}`,
      createdAt: addDays(now.toISOString(), -d.created),
      status: d.status,
      reason: d.reason,
      amount: d.tx.amount,
      currency: "USD",
      customer: d.tx.customer,
      transactionId: d.tx.id,
      responseDueDate: due,
      daysLeftToRespond: d.dueIn,
      product: d.tx.product,
      orderDate: d.tx.date,
      messages: [{ from: "buyer" as const, text: d.message, at: addDays(now.toISOString(), -d.created) }],
    };
  });

  return { txns, invoices, disputes };
}

export class DemoSource implements DataSource {
  readonly mode = "demo" as const;
  private data = buildDemoData();

  reset() {
    this.data = buildDemoData();
  }

  async listTransactions(range: { start: string; end: string }) {
    return this.data.txns.filter((t) => t.date >= range.start && t.date <= range.end);
  }

  async listInvoices() {
    return this.data.invoices.map((i) => ({ ...i }));
  }

  async listDisputes() {
    return this.data.disputes.map((d) => ({ ...d, messages: [...(d.messages ?? [])] }));
  }

  async sendPayout(input: { email: string; name: string; amount: number; currency: string; note: string; reference: string }) {
    if (!(input.amount > 0)) throw new Error("Payout amount must be more than zero.");
    const batchId = `DEMO${Date.now().toString(36).toUpperCase()}`;
    this.data.txns.unshift({
      id: `7P${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`,
      date: new Date().toISOString(),
      kind: "payout",
      status: "completed",
      amount: -input.amount,
      fee: 0,
      net: -input.amount,
      currency: input.currency,
      customer: input.name,
      customerEmail: input.email,
      product: `Payout: ${input.note}`,
    });
    return { batchId, status: "SUCCESS" };
  }

  async getPayoutStatus() {
    return "SUCCESS";
  }

  async addTracking(input: { transactionId: string; trackingNumber: string; carrier: string }) {
    const d = this.data.disputes.find((x) => x.transactionId === input.transactionId);
    if (d) {
      d.messages = [...(d.messages ?? []), { from: "seller", text: `Tracking added: ${input.carrier} ${input.trackingNumber}`, at: new Date().toISOString() }];
      d.tracking = { carrier: input.carrier, number: input.trackingNumber };
    }
    return { status: "SHIPPED" };
  }

  async sendDisputeMessage(input: { disputeId: string; message: string }) {
    const d = this.data.disputes.find((x) => x.id === input.disputeId);
    if (!d) throw new Error(`No dispute found with id ${input.disputeId}`);
    d.messages = [...(d.messages ?? []), { from: "seller", text: input.message, at: new Date().toISOString() }];
    d.status = "UNDER_REVIEW";
    return { disputeId: d.id, status: "MESSAGE_SENT" };
  }

  async refundPayment(input: { transactionId: string; amount?: number; currency?: string; note?: string }) {
    const t = this.data.txns.find((x) => x.id === input.transactionId && x.kind === "payment");
    if (!t) throw new Error(`No payment found with id ${input.transactionId}`);
    const alreadyRefunded = this.data.txns
      .filter((x) => x.kind === "refund" && x.refundOf === t.id)
      .reduce((s, x) => s - x.amount, 0);
    const amount = round2(input.amount ?? t.amount - alreadyRefunded);
    if (amount <= 0 || amount + alreadyRefunded > t.amount + 0.001) {
      throw new Error(`Refund of ${amount} exceeds what is left on payment ${t.id}`);
    }
    const refundId = `9R${Date.now().toString(36).toUpperCase()}`;
    this.data.txns.unshift({
      ...t,
      id: refundId,
      date: new Date().toISOString(),
      kind: "refund",
      amount: -amount,
      fee: 0,
      net: -amount,
      refundOf: t.id,
    });
    return { refundId, status: "COMPLETED", amount, currency: t.currency };
  }

  async remindInvoice(input: { invoiceId: string }) {
    const inv = this.data.invoices.find((i) => i.id === input.invoiceId);
    if (!inv) throw new Error(`No invoice found with id ${input.invoiceId}`);
    if (!["SENT", "PARTIALLY_PAID", "UNPAID"].includes(inv.status)) {
      throw new Error(`Invoice ${inv.number} is ${inv.status}, so a reminder can't be sent`);
    }
    inv.lastReminder = new Date().toISOString();
    return { invoiceId: inv.id, status: "REMINDER_SENT" };
  }

  async createAndSendInvoice(input: NewInvoiceInput) {
    const amount = round2(input.items.reduce((s, it) => s + it.quantity * it.unitAmount, 0));
    const issue = todayISO();
    const number = `MP-${1041 + this.data.invoices.length}`;
    const inv: Invoice = {
      id: `INV2-DEMO-${Date.now().toString(36).toUpperCase()}`,
      number,
      status: "SENT",
      customer: input.customerName,
      customerEmail: input.customerEmail,
      amount,
      amountDue: amount,
      currency: input.currency,
      issueDate: issue,
      dueDate: addDays(issue, input.dueInDays ?? 14).slice(0, 10),
      daysOverdue: 0,
    };
    this.data.invoices.push(inv);
    return { invoiceId: inv.id, number, status: "SENT" };
  }
}
