import { api } from "../api";
import { ActionCard, stateLabel } from "../ActionCard";
import { useApp } from "../state";

export function Activity() {
  const { actions, decide, status } = useApp();
  const list = Object.values(actions).sort((a, b) => (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  const pending = list.filter((a) => a.status === "pending");
  const done = list.filter((a) => a.status !== "pending");

  return (
    <div className="page page-pad">
      <header className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">Everything Kanakku prepared for you, what you approved, and what happened.</p>
        </div>
        {status?.dataMode === "demo" && (
          <div className="head-actions">
            <button
              className="ghost"
              onClick={async () => {
                await api.resetDemo();
                window.location.hash = "/overview";
                window.location.reload();
              }}
            >
              Reset demo store
            </button>
          </div>
        )}
      </header>

      {pending.length > 0 && (
        <section aria-labelledby="pending-title" className="activity-section">
          <h2 id="pending-title">Waiting for you</h2>
          <div className="stack">
            {pending.map((a) => (
              <ActionCard key={a.id} action={a} onDecide={decide} />
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="history-title" className="activity-section">
        <h2 id="history-title">History</h2>
        {done.length === 0 ? (
          <p className="empty-state">Nothing yet. Refunds, reminders, invoices and dispute replies you approve or decline are recorded here.</p>
        ) : (
          <ol className="timeline">
            {done.map((a) => (
              <li key={a.id} className={`tl tl-${a.status}`}>
                <time dateTime={a.decidedAt ?? a.createdAt}>
                  {new Date(a.decidedAt ?? a.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </time>
                <div>
                  <strong>{a.title}</strong> <span className="tl-state">{stateLabel(a)}</span>
                  <ul className="tl-steps">
                    {a.steps.map((s, i) => (
                      <li key={i}>
                        {s.label}
                        {s.result && <span className={`step-result${s.status === "failed" ? " is-failed" : ""}`}> {s.result}</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="tl-source">Started from: {a.requestedBy}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
