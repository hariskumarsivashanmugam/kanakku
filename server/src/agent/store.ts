import { randomUUID } from "node:crypto";

/** A table of real rows produced by a tool. The model refers to it by id, so the grid never shows invented numbers. */
export interface Dataset {
  id: string;
  title: string;
  rows: Record<string, unknown>[];
  createdAt: number;
}

const datasets = new Map<string, Dataset>();

export function saveDataset(title: string, rows: Record<string, unknown>[]): Dataset {
  // Keep memory bounded: drop datasets older than an hour.
  const cutoff = Date.now() - 3_600_000;
  for (const [k, v] of datasets) if (v.createdAt < cutoff) datasets.delete(k);
  const ds = { id: "ds_" + randomUUID().slice(0, 8), title, rows, createdAt: Date.now() };
  datasets.set(ds.id, ds);
  return ds;
}

export function getDataset(id: string) {
  return datasets.get(id);
}

// ---------------- Actions that need the seller's approval ----------------

export type ActionType = "refund" | "invoice_reminder" | "create_invoice";
export type ActionStatus = "pending" | "running" | "done" | "partly_done" | "failed" | "rejected";

export interface ActionStep {
  label: string;
  payload: Record<string, unknown>;
  status?: "done" | "failed";
  result?: string;
}

export interface Action {
  id: string;
  type: ActionType;
  title: string;
  reason: string;
  /** Total money that leaves the account if approved (refunds), for the confirmation card. */
  moneyOut?: { amount: number; currency: string };
  steps: ActionStep[];
  status: ActionStatus;
  requestedBy: string; // the question that led to it
  createdAt: string;
  decidedAt?: string;
}

const actions = new Map<string, Action>();

export function addAction(a: Omit<Action, "id" | "status" | "createdAt">): Action {
  const action: Action = { ...a, id: "act_" + randomUUID().slice(0, 8), status: "pending", createdAt: new Date().toISOString() };
  actions.set(action.id, action);
  return action;
}

export function getAction(id: string) {
  return actions.get(id);
}

export function listActions() {
  return [...actions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function clearActions() {
  actions.clear();
}
