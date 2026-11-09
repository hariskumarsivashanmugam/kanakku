import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Action, type ProposeTool, type Status } from "./api";

export const LANGS = [
  { code: "English", label: "English", locale: "en-IN" },
  { code: "Tamil", label: "தமிழ்", locale: "ta-IN" },
  { code: "Hindi", label: "हिन्दी", locale: "hi-IN" },
];

export interface Toast {
  id: number;
  text: string;
  tone: "ok" | "error";
}

interface AppState {
  status: Status | null;
  lang: string;
  setLang: (l: string) => void;
  actions: Record<string, Action>;
  pending: Action[];
  upsertActions: (a: Action[]) => void;
  /** Ask the server to prepare an action from a button; opens the confirmation dialog. */
  propose: (tool: ProposeTool, input: unknown, source: string) => Promise<Action | null>;
  decide: (id: string, approve: boolean) => Promise<Action | null>;
  confirming: Action | null;
  setConfirming: (a: Action | null) => void;
  /** Incremented after an action runs so screens reload their data. */
  dataVersion: number;
  reload: () => void;
  assistant: { open: boolean; prompt: string | null; nonce: number };
  openAssistant: (prompt?: string) => void;
  closeAssistant: () => void;
  toasts: Toast[];
  toast: (text: string, tone?: Toast["tone"]) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
}

let toastId = 1;

const doneText: Record<Action["type"], string> = {
  refund: "Refund sent",
  invoice_reminder: "Reminders sent",
  create_invoice: "Invoice sent",
  dispute_reply: "Reply sent to the buyer",
  artisan_payout: "Payout sent through PayPal",
  add_tracking: "Tracking added to PayPal",
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [lang, setLangState] = useState(() => {
    try {
      return localStorage.getItem("kanakku.lang") ?? "English";
    } catch {
      return "English";
    }
  });
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [assistant, setAssistant] = useState({ open: false, prompt: null as string | null, nonce: 0 });
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    api.status().then(setStatus, () => setStatus(null));
    api.actions().then((list) => setActions(Object.fromEntries(list.map((a) => [a.id, a]))), () => {});
  }, []);

  const setLang = useCallback((l: string) => {
    setLangState(l);
    try {
      localStorage.setItem("kanakku.lang", l);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = toastId++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const upsertActions = useCallback((list: Action[]) => {
    if (list.length) setActions((a) => ({ ...a, ...Object.fromEntries(list.map((x) => [x.id, x])) }));
  }, []);

  const propose = useCallback(
    async (tool: ProposeTool, input: unknown, source: string) => {
      try {
        const action = await api.propose(tool, input, source);
        upsertActions([action]);
        setConfirming(action);
        return action;
      } catch (e) {
        toast((e as Error).message, "error");
        return null;
      }
    },
    [toast, upsertActions],
  );

  const decide = useCallback(
    async (id: string, approve: boolean) => {
      setActions((a) => (a[id] ? { ...a, [id]: { ...a[id], status: "running" } } : a));
      try {
        const updated = approve ? await api.approve(id) : await api.reject(id);
        upsertActions([updated]);
        if (approve) {
          setDataVersion((v) => v + 1);
          if (updated.status === "done") toast(doneText[updated.type]);
          else toast(updated.steps.find((s) => s.status === "failed")?.result ?? "Some steps didn't go through", "error");
        }
        return updated;
      } catch (e) {
        toast((e as Error).message, "error");
        setActions((a) => (a[id] ? { ...a, [id]: { ...a[id], status: "pending" } } : a));
        return null;
      }
    },
    [toast, upsertActions],
  );

  const value = useMemo<AppState>(
    () => ({
      status,
      lang,
      setLang,
      actions,
      pending: Object.values(actions)
        .filter((a) => a.status === "pending")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      upsertActions,
      propose,
      decide,
      confirming,
      setConfirming,
      dataVersion,
      reload: () => setDataVersion((v) => v + 1),
      assistant,
      openAssistant: (prompt?: string) => setAssistant((s) => ({ open: true, prompt: prompt ?? null, nonce: s.nonce + 1 })),
      closeAssistant: () => setAssistant((s) => ({ ...s, open: false, prompt: null })),
      toasts,
      toast,
    }),
    [status, lang, setLang, actions, upsertActions, propose, decide, confirming, dataVersion, assistant, toasts, toast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Fetches data for a screen and refetches whenever an action changes the account. */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const { dataVersion } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    load().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError("");
        setLoading(false);
      },
      (e: Error) => {
        if (!live) return;
        setError(e.message);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion, ...deps]);
  return { data, error, loading };
}

export const money = (n: number, c = "USD", digits = 2) =>
  `${c} ${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const shortDate = (iso: string) =>
  new Date(iso.length === 10 ? iso + "T00:00:00Z" : iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export const humanReason = (r: string) =>
  ({
    MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
    MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
    UNAUTHORISED: "Unauthorised payment",
    DUPLICATE_TRANSACTION: "Duplicate charge",
    INCORRECT_AMOUNT: "Incorrect amount",
    PAYMENT_BY_OTHER_MEANS: "Paid another way",
    CREDIT_NOT_PROCESSED: "Refund not received",
    CANCELED_RECURRING_BILLING: "Cancelled subscription",
    PROBLEM_WITH_REMITTANCE: "Payment problem",
    OTHER: "Other",
  })[r] ?? r.replace(/_/g, " ").toLowerCase();
