import { useEffect, useRef, type ReactNode } from "react";
import { useApp } from "./state";
import { ActionCard } from "./ActionCard";

/** Accessible modal dialog built on <dialog>. */
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal${wide ? " modal-wide" : ""}`} onClose={onClose} onCancel={onClose} aria-labelledby="modal-title">
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <div className="modal-body">{open && children}</div>
    </dialog>
  );
}

/** The single approval step for actions started from buttons. */
export function ConfirmDialog() {
  const { confirming, setConfirming, actions, decide } = useApp();
  const action = confirming ? actions[confirming.id] ?? confirming : null;
  const finished = action && !["pending", "running"].includes(action.status);
  return (
    <Modal open={Boolean(action)} onClose={() => setConfirming(null)} title={finished ? "Done" : "Check before it goes out"}>
      {action && (
        <>
          <ActionCard action={action} onDecide={decide} />
          {finished && (
            <div className="modal-foot">
              <button className="primary" onClick={() => setConfirming(null)}>
                Close
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function Approvals({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { pending, decide } = useApp();
  return (
    <Modal open={open} onClose={onClose} title="Waiting for your approval">
      {pending.length === 0 ? (
        <p className="muted">Nothing is waiting. Refunds, reminders, invoices and dispute replies appear here until you approve or decline them.</p>
      ) : (
        <div className="stack">
          {pending.map((a) => (
            <ActionCard key={a.id} action={a} onDecide={decide} />
          ))}
        </div>
      )}
    </Modal>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function AskButton({ prompt, children = "Ask why" }: { prompt: string; children?: ReactNode }) {
  const { openAssistant } = useApp();
  return (
    <button className="ask-link" onClick={() => openAssistant(prompt)}>
      <SparkIcon /> {children}
    </button>
  );
}

export function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="spark">
      <path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" fill="currentColor" />
      <circle cx="13" cy="12.5" r="1.4" fill="currentColor" />
    </svg>
  );
}

export function Notice({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "info" }) {
  return (
    <p className={`notice notice-${tone}`} role="status">
      {children}
    </p>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="loading-line" aria-busy="true">
      {label}
    </p>
  );
}
