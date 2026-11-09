export interface ActionStep {
  label: string;
  status?: "done" | "failed";
  result?: string;
}

export interface Action {
  id: string;
  type: "refund" | "invoice_reminder" | "create_invoice";
  title: string;
  reason: string;
  moneyOut?: { amount: number; currency: string };
  steps: ActionStep[];
  status: "pending" | "running" | "done" | "partly_done" | "failed" | "rejected";
  requestedBy: string;
  createdAt: string;
  decidedAt?: string;
}

export interface Answer {
  summary: string;
  table?: { title: string; columns: { field: string; header: string }[]; rows: Record<string, unknown>[] };
  chart?: { type: "bar" | "line" | "pie"; x: string; y: string[]; title: string };
  actions: Action[];
  trace: { tool: string; ok: boolean; note?: string }[];
  dataMode: "live" | "demo";
}

export interface Status {
  dataMode: "live" | "demo";
  aiReady: boolean;
  model: string;
}

export interface Brief {
  text: string;
  facts: {
    urgent_disputes: { id: string; customer: string; amount: number; days_left: number }[];
    overdue_invoices: { count: number; total_due: number };
    possible_duplicate_charges: unknown[];
    month_to_date_sales: number;
    change_pct: number | null;
    currency: string;
  };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  status: () => call<Status>("/api/status"),
  brief: (lang: string) => call<Brief>(`/api/brief?lang=${encodeURIComponent(lang)}`),
  ask: (question: string, history: { role: "user" | "assistant"; text: string }[]) =>
    call<Answer>("/api/ask", { method: "POST", body: JSON.stringify({ question, history }) }),
  actions: () => call<Action[]>("/api/actions"),
  approve: (id: string) => call<Action>(`/api/actions/${id}/approve`, { method: "POST" }),
  reject: (id: string) => call<Action>(`/api/actions/${id}/reject`, { method: "POST" }),
  resetDemo: () => call<{ ok: boolean }>("/api/demo/reset", { method: "POST" }),
};
