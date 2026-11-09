import { config } from "../config.js";
import type { Transaction } from "../data/types.js";
import { round2 } from "../data/util.js";

/**
 * Price check with Channel3: search 100M+ products from 25,000+ retailers for items like one of
 * Meena's products, and compare her price with what similar items sell for.
 */

export interface Comparable {
  title: string;
  merchant: string;
  price: number;
  currency: string;
  url?: string;
  image?: string;
}

export interface PriceCheck {
  product: string;
  yourPrice: number;
  currency: string;
  comparables: Comparable[];
  median: number | null;
  low: number | null;
  high: number | null;
  verdict: "below" | "in_line" | "above" | "unknown";
  summary: string;
  checkedAt: string;
}

const cache = new Map<string, { at: number; value: PriceCheck }>();

/** Typical unit price from recent sales ("Ajrakh stole ×2" at 92 → 46). */
export function unitPrice(txns: Transaction[], product: string): number | null {
  const prices = txns
    .filter((t) => t.kind === "payment" && t.product.replace(/ ×\d+$/, "") === product)
    .map((t) => {
      const qty = Number(t.product.match(/ ×(\d+)$/)?.[1] ?? 1);
      return t.amount / qty;
    })
    .sort((a, b) => a - b);
  return prices.length ? round2(prices[Math.floor(prices.length / 2)]) : null;
}

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return round2(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

export async function priceCheck(product: string, yourPrice: number, currency = "USD"): Promise<PriceCheck> {
  if (!config.channel3.key) throw new Error("Add CHANNEL3_API_KEY to .env to compare prices with other retailers.");
  const key = `${product}|${yourPrice}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.value;

  const res = await fetch(`${config.channel3.baseUrl}/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.channel3.key },
    body: JSON.stringify({ query: `handmade ${product}`, limit: 20 }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`Channel3 ${res.status}: ${body?.detail ?? body?.message ?? res.statusText}`);

  const comparables: Comparable[] = [];
  for (const p of body.products ?? []) {
    const offers: any[] = p.offers ?? [];
    const offer = offers.find((o) => (o.price?.currency ?? "USD") === currency && o.availability !== "OutOfStock") ?? offers[0];
    const price = Number(offer?.price?.price ?? p.price?.price ?? NaN);
    if (!Number.isFinite(price) || price <= 0) continue;
    if ((offer?.price?.currency ?? p.price?.currency ?? currency) !== currency) continue;
    comparables.push({
      title: String(p.title ?? "Untitled"),
      merchant: String(offer?.domain ?? p.brand_name ?? p.brand ?? ""),
      price: round2(price),
      currency,
      url: offer?.url ?? p.url,
      image: p.images?.[0]?.url ?? p.image_url ?? p.images?.[0],
    });
  }

  // Trim extreme outliers (bundles, mislabelled items) before comparing.
  const prices = comparables.map((c) => c.price).sort((a, b) => a - b);
  const trimmed = prices.length >= 6 ? prices.slice(Math.floor(prices.length * 0.1), Math.ceil(prices.length * 0.9)) : prices;
  const med = median(trimmed);
  let verdict: PriceCheck["verdict"] = "unknown";
  let summary = "Not enough similar products found to compare.";
  if (med !== null && trimmed.length >= 3) {
    const diff = (yourPrice - med) / med;
    const pct = Math.round(Math.abs(diff) * 100);
    if (diff <= -0.15) {
      verdict = "below";
      summary = `You charge ${currency} ${yourPrice}, ${pct}% below the ${currency} ${med} typical for similar items. There may be room to raise the price.`;
    } else if (diff >= 0.15) {
      verdict = "above";
      summary = `You charge ${currency} ${yourPrice}, ${pct}% above the ${currency} ${med} typical for similar items. Make sure the listing explains what makes yours worth more.`;
    } else {
      verdict = "in_line";
      summary = `You charge ${currency} ${yourPrice}, in line with the ${currency} ${med} typical for similar items.`;
    }
  }
  const value: PriceCheck = {
    product,
    yourPrice,
    currency,
    comparables: comparables.sort((a, b) => a.price - b.price).slice(0, 12),
    median: med,
    low: trimmed[0] ?? null,
    high: trimmed[trimmed.length - 1] ?? null,
    verdict,
    summary,
    checkedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
