import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// .env lives at the repo root, one level above /server
loadEnv({ path: path.resolve(here, "../../.env") });
loadEnv(); // also allow a server-local .env

export type DataMode = "auto" | "live" | "demo";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    baseUrl: process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com",
  },
  dataMode: (process.env.DATA_MODE as DataMode) || "auto",
  channel3: {
    key: process.env.CHANNEL3_API_KEY ?? "",
    baseUrl: process.env.CHANNEL3_BASE_URL || "https://api.trychannel3.com",
  },
  seedCard: {
    number: process.env.SEED_TEST_CARD_NUMBER ?? "",
    expiry: process.env.SEED_TEST_CARD_EXPIRY || "2030-12",
  },
};

export function hasPayPalKeys() {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}

export function resolvedMode(): "live" | "demo" {
  if (config.dataMode === "live") return "live";
  if (config.dataMode === "demo") return "demo";
  return hasPayPalKeys() ? "live" : "demo";
}
