import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import { z } from "zod";
import { config } from "../config.js";
import type { Dispute } from "../data/types.js";
import { getLLM } from "./agent.js";

/** One-shot AI helpers used by buttons in the UI. Claude fills a form; the seller checks it before anything is sent. */

const invoiceDraft = z.object({
  customer_name: z.string().default(""),
  customer_email: z.string().default(""),
  currency: z.string().default("USD"),
  items: z
    .array(z.object({ name: z.string(), quantity: z.number().positive().default(1), unit_amount: z.number().nonnegative().default(0) }))
    .default([]),
  due_in_days: z.number().int().positive().default(14),
  note: z.string().default(""),
  missing: z.array(z.string()).default([]),
});

export type InvoiceDraft = z.infer<typeof invoiceDraft>;

async function forcedTool(name: string, description: string, schema: Record<string, unknown>, system: string, user: string) {
  const res = await getLLM().create({
    model: config.model,
    max_tokens: 1200,
    system,
    tools: [{ name, description, input_schema: schema as any }],
    tool_choice: { type: "tool", name },
    messages: [{ role: "user", content: user }],
  });
  const use = res.content.find((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
  if (!use) throw new Error("The assistant didn't return a draft. Try again.");
  return use.input;
}

export async function draftInvoiceFromText(text: string): Promise<InvoiceDraft> {
  const input = await forcedTool(
    "fill_invoice",
    "Fill in an invoice from the seller's pasted message.",
    {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Business or person to bill" },
        customer_email: { type: "string", description: "Their email, only if it appears in the text, else empty" },
        currency: { type: "string", description: "ISO code; USD if not stated" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, quantity: { type: "number" }, unit_amount: { type: "number", description: "Price per unit" } },
            required: ["name", "quantity", "unit_amount"],
          },
        },
        due_in_days: { type: "number", description: "Payment terms in days; 14 if not stated" },
        note: { type: "string", description: "A short friendly note to the customer, in English" },
        missing: { type: "array", items: { type: "string" }, description: "Fields the seller still needs to fill in, e.g. 'customer email'" },
      },
      required: ["customer_name", "customer_email", "currency", "items", "due_in_days", "note", "missing"],
    },
    "You turn a small seller's message (often a WhatsApp chat or email with a buyer, in any language) into an invoice. Only use facts in the text. If a unit price is given as a total for several items, divide it. Never invent an email address; leave it empty and list it in missing.",
    text.slice(0, 6000),
  );
  return invoiceDraft.parse(input);
}

export async function draftDisputeReply(d: Dispute, sellerNote?: string): Promise<string> {
  const input = (await forcedTool(
    "write_reply",
    "Write the seller's reply to the buyer on this PayPal dispute.",
    { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    "You help a small seller reply to a PayPal dispute. Write in English, 80-140 words, warm and professional. Acknowledge the buyer's problem, state the facts you have, and offer a concrete resolution that fits the reason (for an item not received: offer to share tracking and a replacement or refund if it hasn't arrived within a few days; for not as described: apologise and offer a return for a full refund or a partial refund). Do not invent tracking numbers, dates or policies. Use [placeholders] for anything the seller must fill in. Sign off as the shop, without a name.",
    JSON.stringify({
      dispute_reason: d.reason,
      amount: `${d.currency} ${d.amount}`,
      product: d.product,
      order_date: d.orderDate?.slice(0, 10),
      buyer: d.customer,
      buyer_messages: d.messages?.filter((m) => m.from === "buyer").map((m) => m.text),
      days_left_to_respond: d.daysLeftToRespond,
      seller_note: sellerNote,
    }),
  )) as { message?: string };
  if (!input.message) throw new Error("The assistant didn't return a reply. Try again.");
  return input.message.trim();
}
