import { useEffect, useRef, useState } from "react";
import { api, type Answer } from "./api";
import { useApp } from "./state";
import { ActionCard } from "./ActionCard";
import { RichText } from "./RichText";
import { ResultView } from "./ResultView";
import { SparkIcon } from "./components";

type Msg = { id: number; role: "user" | "assistant"; text: string; answer?: Answer; error?: boolean };

const STARTERS = [
  "How did sales this month compare with last month?",
  "Which products get refunded the most?",
  "Invoice Juniper & Thread for 10 Kalamkari scarves at $19 each",
  "இந்த வாரம் எவ்வளவு விற்பனை ஆனது?",
  "पिछले महीने सबसे ज़्यादा किसने खरीदा?",
];

let nextId = 1;

export function Assistant() {
  const { assistant, closeAssistant, actions, upsertActions, decide, status } = useApp();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastNonce = useRef(0);

  useEffect(() => {
    if (!assistant.open) return;
    if (assistant.prompt && assistant.nonce !== lastNonce.current) {
      lastNonce.current = assistant.nonce;
      send(assistant.prompt);
    } else {
      setTimeout(() => input.current?.focus(), 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.open, assistant.nonce]);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    if (!assistant.open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeAssistant();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [assistant.open, closeAssistant]);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = messages.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.answer?.summary ?? m.text }));
    setMessages((m) => [...m, { id: nextId++, role: "user", text: q }]);
    setDraft("");
    setBusy(true);
    try {
      const answer = await api.ask(q, history);
      upsertActions(answer.actions);
      setMessages((m) => [...m, { id: nextId++, role: "assistant", text: answer.summary, answer }]);
    } catch (e) {
      setMessages((m) => [...m, { id: nextId++, role: "assistant", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={`assistant${assistant.open ? " is-open" : ""}`} aria-label="Ask Kanakku" aria-hidden={!assistant.open} inert={!assistant.open}>
      <header className="assistant-head">
        <h2>
          <SparkIcon /> Ask Kanakku
        </h2>
        <div className="row-gap">
          {messages.length > 0 && (
            <button className="ghost small" onClick={() => setMessages([])}>
              New conversation
            </button>
          )}
          <button className="icon-btn" onClick={closeAssistant} aria-label="Close assistant">
            ×
          </button>
        </div>
      </header>

      <div className="assistant-body">
        {messages.length === 0 && (
          <div className="empty">
            <p>Ask about sales, refunds, invoices or disputes in any language. Answers come with a table you can sort and filter. Kanakku can also prepare refunds, reminders and invoices for you to approve.</p>
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
          <div key={m.id} className={`msg msg-${m.role}${m.error ? " msg-error" : ""}`}>
            {m.role === "user" ? (
              <span>{m.text}</span>
            ) : m.error ? (
              <span>{m.text}</span>
            ) : m.answer && (m.answer.table || m.answer.chart) ? (
              <ResultView answer={m.answer} compact />
            ) : (
              <RichText text={m.text} />
            )}
            {m.answer?.actions.map((a) => actions[a.id] && <ActionCard key={a.id} action={actions[a.id]} onDecide={decide} />)}
          </div>
        ))}
        {busy && (
          <div className="msg msg-assistant thinking" aria-live="polite">
            Looking through your account…
          </div>
        )}
        <div ref={end} />
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
          ref={input}
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
      {status && !status.aiReady && <p className="warn">Add ANTHROPIC_API_KEY to your .env file and restart the server to ask questions.</p>}
    </aside>
  );
}
