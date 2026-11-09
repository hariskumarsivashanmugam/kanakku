import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Action, type Answer, type Brief, type Status } from "./api";
import { ResultView } from "./ResultView";
import { ActionCard } from "./ActionCard";
import { RichText } from "./RichText";

type Msg = { id: number; role: "user" | "assistant"; text: string; answer?: Answer; error?: boolean };

const LANGS = [
  { code: "English", label: "English" },
  { code: "Tamil", label: "தமிழ்" },
  { code: "Hindi", label: "हिन्दी" },
];

const STARTERS = [
  "How did sales this month compare with last month?",
  "Which products get refunded the most?",
  "Who still owes me money on invoices?",
  "இந்த வாரம் எவ்வளவு விற்பனை ஆனது?",
];

let nextId = 1;

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem("kanakku.lang") ?? "English";
    } catch {
      return "English";
    }
  });
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefError, setBriefError] = useState("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [logOpen, setLogOpen] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);

  const loadBrief = useCallback(() => {
    setBrief(null);
    setBriefError("");
    api.brief(lang).then(setBrief, (e: Error) => setBriefError(e.message));
  }, [lang]);

  useEffect(() => {
    api.status().then(setStatus, () => setStatus(null));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("kanakku.lang", lang);
    } catch {
      /* storage unavailable */
    }
    loadBrief();
  }, [lang, loadBrief]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = messages.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.answer?.summary ?? m.text }));
    setMessages((m) => [...m, { id: nextId++, role: "user", text: q }]);
    setDraft("");
    setBusy(true);
    try {
      const answer = await api.ask(q, history);
      const id = nextId++;
      setMessages((m) => [...m, { id, role: "assistant", text: answer.summary, answer }]);
      if (answer.table || answer.chart) setSelected(id);
      if (answer.actions.length) setActions((a) => ({ ...a, ...Object.fromEntries(answer.actions.map((x) => [x.id, x])) }));
    } catch (e) {
      setMessages((m) => [...m, { id: nextId++, role: "assistant", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, approve: boolean) {
    setActions((a) => ({ ...a, [id]: { ...a[id], status: "running" } }));
    try {
      const updated = approve ? await api.approve(id) : await api.reject(id);
      setActions((a) => ({ ...a, [id]: updated }));
      if (approve) loadBrief();
    } catch (e) {
      setActions((a) => ({ ...a, [id]: { ...a[id], status: "failed", steps: a[id].steps.map((s) => ({ ...s, result: (e as Error).message })) } }));
    }
  }

  async function resetDemo() {
    await api.resetDemo();
    setMessages([]);
    setActions({});
    setSelected(null);
    loadBrief();
  }

  const shown = useMemo(() => {
    const withData = messages.filter((m) => m.answer?.table || m.answer?.chart);
    return messages.find((m) => m.id === selected) ?? withData[withData.length - 1];
  }, [messages, selected]);

  const log = Object.values(actions)
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));

  const quick = brief ? quickAsks(brief, lang) : [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="wordmark">Kanakku</span>
          <span className="tagline">Your PayPal account, explained and handled</span>
        </div>
        <div className="topbar-tools">
          {status && (
            <span className={`source source-${status.dataMode}`} title={status.dataMode === "demo" ? "Built-in demo store for Meena Prints" : "Connected to your PayPal sandbox"}>
              {status.dataMode === "demo" ? "Demo store" : "PayPal sandbox"}
            </span>
          )}
          <label className="lang">
            <span className="sr-only">Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost" onClick={() => setLogOpen((o) => !o)} aria-expanded={logOpen}>
            Activity{log.length ? ` (${log.length})` : ""}
          </button>
        </div>
      </header>

      <section className="ledger" aria-labelledby="brief-title">
        <div className="ledger-inner">
          <h1 id="brief-title">
            Today, {new Date().toLocaleDateString(lang === "Tamil" ? "ta-IN" : lang === "Hindi" ? "hi-IN" : "en-IN", { day: "numeric", month: "long" })}
          </h1>
          {briefError ? (
            <p className="brief-text muted">Couldn't load today's summary: {briefError}</p>
          ) : brief ? (
            <p className="brief-text">
              <RichText text={brief.text} />
            </p>
          ) : (
            <p className="brief-text loading-line" aria-busy="true">
              Reading your account…
            </p>
          )}
          {quick.length > 0 && (
            <div className="chips">
              {quick.map((q) => (
                <button key={q.label} className="chip chip-urgent" onClick={() => send(q.ask)} disabled={busy}>
                  {q.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {logOpen && (
        <section className="activity" aria-label="Activity">
          <div className="activity-head">
            <h2>What Kanakku has done</h2>
            {status?.dataMode === "demo" && (
              <button className="ghost small" onClick={resetDemo}>
                Reset demo store
              </button>
            )}
          </div>
          {log.length === 0 ? (
            <p className="muted">Nothing yet. Approved and declined actions are recorded here.</p>
          ) : (
            <ol className="activity-list">
              {log.map((a) => (
                <li key={a.id}>
                  <span className={`dot dot-${a.status}`} aria-hidden />
                  <div>
                    <strong>{a.title}</strong> — {statusWord(a.status)}
                    {a.decidedAt && <span className="muted"> at {new Date(a.decidedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
                    <div className="muted small-text">Asked: “{a.requestedBy}”</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <main className="workspace">
        <section className="thread" aria-label="Conversation">
          <div className="messages">
            {messages.length === 0 && (
              <div className="empty">
                <p>Ask about sales, refunds, invoices or disputes, in any language. Kanakku will look it up in your PayPal account.</p>
                <div className="chips">
                  {STARTERS.map((s) => (
                    <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`msg msg-${m.role}${m.error ? " msg-error" : ""}${shown?.id === m.id ? " msg-shown" : ""}`}>
                {m.role === "assistant" && !m.error ? <RichText text={m.text} /> : <span>{m.text}</span>}
                {m.answer && (m.answer.table || m.answer.chart) && (
                  <button className="link small" onClick={() => setSelected(m.id)} aria-pressed={shown?.id === m.id}>
                    {shown?.id === m.id ? "Showing in the table" : "Show the table"}
                  </button>
                )}
                {m.answer?.actions.map((a) => actions[a.id] && <ActionCard key={a.id} action={actions[a.id]} onDecide={decide} />)}
              </div>
            ))}
            {busy && (
              <div className="msg msg-assistant thinking" aria-live="polite">
                Looking through your account…
              </div>
            )}
            <div ref={threadEnd} />
          </div>

          <form
            className="ask"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <label htmlFor="ask-input" className="sr-only">
              Ask Kanakku
            </label>
            <textarea
              id="ask-input"
              rows={2}
              value={draft}
              placeholder="Ask anything, e.g. “Refund the duplicate charges”"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            <button type="submit" className="primary" disabled={busy || !draft.trim()}>
              Ask
            </button>
          </form>
          {status && !status.aiReady && (
            <p className="warn">Add ANTHROPIC_API_KEY to your .env file and restart the server to ask questions.</p>
          )}
        </section>

        <section className="results" aria-label="Results">
          {shown?.answer ? (
            <ResultView answer={shown.answer} />
          ) : (
            <div className="results-empty">
              <p>Tables and charts for your answers appear here. You can sort, filter and resize every column.</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function statusWord(s: Action["status"]) {
  return { done: "done", partly_done: "partly done", failed: "failed", rejected: "declined", running: "in progress", pending: "waiting" }[s];
}

function quickAsks(b: Brief, lang: string) {
  const out: { label: string; ask: string }[] = [];
  const ta = lang === "Tamil";
  const hi = lang === "Hindi";
  if (b.facts.urgent_disputes.length) {
    out.push({
      label: ta ? "அவசர புகாரைப் பார்" : hi ? "ज़रूरी विवाद देखें" : "Look at the urgent dispute",
      ask: ta ? "பதில் அளிக்க வேண்டிய புகார்களைக் காட்டு" : hi ? "जिन विवादों का जवाब देना है, वे दिखाओ" : "Show me the disputes I need to respond to, most urgent first",
    });
  }
  if (b.facts.possible_duplicate_charges.length) {
    out.push({
      label: ta ? "இரட்டைக் கட்டணங்களைச் சரிசெய்" : hi ? "डुप्लिकेट चार्ज ठीक करें" : "Fix duplicate charges",
      ask: ta ? "கடந்த இரண்டு வாரங்களில் உள்ள இரட்டைக் கட்டணங்களைக் கண்டுபிடித்து, திருப்பிச் செலுத்தத் தயார் செய்" : hi ? "पिछले दो हफ़्तों के डुप्लिकेट चार्ज ढूँढो और उनका रिफ़ंड तैयार करो" : "Find duplicate charges from the last two weeks and prepare refunds for them",
    });
  }
  if (b.facts.overdue_invoices.count) {
    out.push({
      label: ta ? "நிலுவை இன்வாய்ஸ்களுக்கு நினைவூட்டு" : hi ? "बकाया इनवॉइस का रिमाइंडर भेजें" : "Chase overdue invoices",
      ask: ta ? "காலாவதியான இன்வாய்ஸ்களைக் காட்டி, எல்லோருக்கும் நினைவூட்டல் தயார் செய்" : hi ? "बकाया इनवॉइस दिखाओ और सबको रिमाइंडर तैयार करो" : "Show overdue invoices and prepare reminders for all of them",
    });
  }
  return out;
}
