import type { Action } from "./api";

const money = (n: number, c: string) => `${c} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function approveLabel(a: Action) {
  if (a.type === "refund") return `Approve and refund ${a.moneyOut ? money(a.moneyOut.amount, a.moneyOut.currency) : ""}`.trim();
  if (a.type === "invoice_reminder") return a.steps.length === 1 ? "Approve and send reminder" : `Approve and send ${a.steps.length} reminders`;
  return "Approve and send invoice";
}

const doneWord: Record<Action["type"], string> = {
  refund: "Refunded",
  invoice_reminder: "Reminders sent",
  create_invoice: "Invoice sent",
};

export function ActionCard({ action, onDecide }: { action: Action; onDecide: (id: string, approve: boolean) => void }) {
  const pending = action.status === "pending";
  const running = action.status === "running";
  return (
    <div className={`action action-${action.status}`} role="group" aria-label={action.title}>
      <div className="action-head">
        <strong>{action.title}</strong>
        <span className="action-state">
          {pending && "Needs your approval"}
          {running && "Working…"}
          {action.status === "done" && doneWord[action.type]}
          {action.status === "partly_done" && "Partly done"}
          {action.status === "failed" && "Didn't go through"}
          {action.status === "rejected" && "Declined, nothing was changed"}
        </span>
      </div>
      <p className="action-reason">{action.reason}</p>
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
