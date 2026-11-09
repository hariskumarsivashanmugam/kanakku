import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The PayPal order ids this shop has created (by the seed script, or by a checkout you add later).
 * Kanakku reads each order live from PayPal's Orders API, so sales, fees and refunds show up immediately,
 * without waiting for Transaction Search. Only ids are stored here; the data always comes from PayPal.
 */

const file = process.env.KANAKKU_LEDGER || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.kanakku/sandbox-orders.json");

interface Ledger {
  baseUrl: string;
  clientId: string;
  orders: { id: string; addedAt: string }[];
}

export function readLedger(baseUrl: string, clientId: string): string[] {
  try {
    const l = JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
    // Ignore orders that belong to a different PayPal app or environment.
    if (l.baseUrl !== baseUrl || l.clientId !== clientId) return [];
    return l.orders.map((o) => o.id);
  } catch {
    return [];
  }
}

export function addToLedger(baseUrl: string, clientId: string, orderIds: string[]) {
  if (!orderIds.length) return;
  let l: Ledger = { baseUrl, clientId, orders: [] };
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as Ledger;
    if (existing.baseUrl === baseUrl && existing.clientId === clientId) l = existing;
  } catch {
    /* new ledger */
  }
  const known = new Set(l.orders.map((o) => o.id));
  const now = new Date().toISOString();
  for (const id of orderIds) if (!known.has(id)) l.orders.push({ id, addedAt: now });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(l, null, 2));
}

export const ledgerPath = file;
