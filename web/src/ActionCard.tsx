import type { Action } from "./api";
import { money } from "./state";

export function approveLabel(a: Action) {
  if (a.type === "refund") return a.moneyOut ? `Approve and refund ${money(a.moneyOut.amount, a.moneyOut.currency)}` : "Approve and refund";
  if (a.type === "invoice_reminder") return a.steps.length === 1 ? "Approve and send reminder" : `Approve and send ${a.steps.length} reminders`;
  if (a.type === "dispute_reply") return "Approve and send reply";
  return "Approve and send invoice";
}

const doneWord: Record<Action["type"], string> = {
  refund: "Refunded",
  invoice_reminder: "Reminders sent",
  create_invoice: "Invoice sent",
  dispute_reply: "Reply sent",
};

export function stateLabel(a: Action) {
  switch (a.status) {
    case "pending":
      return "Needs your approval";
    case "running":
      return "Working…";
    case "done":
      return doneWord[a.type];
    case "partly_done":
      return "Partly done";
    case "failed":
      return "Didn't go through";
    case "rejected":
      return "Declined, nothing changed";
  }
}

export function ActionCard({ action, onDecide }: { action: Action; onDecide: (id: string, approve: boolean) => void }) {
  const pending = action.status === "pending";
  const running = action.status === "running";
  return (
    <div className={`action action-${action.status}`} role="group" aria-label={action.title}>
      <div className="action-head">
        <strong>{action.title}</strong>
        <span className="action-state">{stateLabel(action)}</span>
      </div>
      {action.reason && <p className="action-reason">{action.reason}</p>}
      <ul className="action-steps">
        {action.steps.map((s, i) => (
          <li key={i} className={s.status ? `step-${s.status}` : ""}>
            <span>{s.label}</span>
            {s.result && <span className="step-result">{s.result}</span>}
          </li>
        ))}
      </ul>
      {(pending || running) && (
        <div className="action-buttons">
          <button className="primary" disabled={running} onClick={() => onDecide(action.id, true)}>
            {approveLabel(action)}
          </button>
          <button className="ghost" disabled={running} onClick={() => onDecide(action.id, false)}>
            Decline
          </button>
        </div>
      )}
    </div>
  );
}
