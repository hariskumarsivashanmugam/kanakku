import { randomUUID } from "node:crypto";
import { config } from "../config.js";

export class PayPalError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.value;
  const { clientId, clientSecret, baseUrl } = config.paypal;
  if (!clientId || !clientSecret) {
    throw new PayPalError("PayPal keys are missing. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.", 401);
  }
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new PayPalError(`PayPal sign-in failed: ${body.error_description ?? res.statusText}`, res.status, body);
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3000) * 1000 };
  return cachedToken.value;
}

export interface PayPalRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Adds a PayPal-Request-Id header so retries are idempotent. */
  idempotent?: boolean;
  headers?: Record<string, string>;
}

export async function paypal<T = any>(req: PayPalRequest): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(config.paypal.baseUrl + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...req.headers,
  };
  if (req.idempotent) headers["PayPal-Request-Id"] = randomUUID();

  const res = await fetch(url, {
    method: req.method ?? "GET",
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : {};
  if (!res.ok) {
    const d = data as { message?: string; details?: { issue?: string; description?: string }[] };
    const detail = d.details?.map((x) => x.description || x.issue).filter(Boolean).join("; ");
    throw new PayPalError(`PayPal ${res.status}: ${d.message ?? res.statusText}${detail ? ` (${detail})` : ""}`, res.status, data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
