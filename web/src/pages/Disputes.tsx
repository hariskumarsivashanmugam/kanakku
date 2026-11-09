import { useEffect, useRef, useState } from "react";
import { api, type Dispute } from "../api";
import { humanReason, money, shortDate, useApp, useData } from "../state";
import { AskButton, Loading, Notice, SparkIcon } from "../components";

const isOpen = (d: Dispute) => !["RESOLVED", "CLOSED"].includes(d.status);

const statusText = (d: Dispute) =>
  ({
    WAITING_FOR_SELLER_RESPONSE: "Waiting for your reply",
    WAITING_FOR_BUYER_RESPONSE: "Waiting for the buyer",
    UNDER_REVIEW: "PayPal is reviewing",
    RESOLVED: "Resolved",
    CLOSED: "Closed",
  })[d.status] ?? d.status.replace(/_/g, " ").toLowerCase();

export function Disputes({ arg }: { arg: string | null }) {
  const { data, error } = useData(api.disputes);
  const open = (data ?? []).filter(isOpen);
  const closed = (data ?? []).filter((d) => !isOpen(d));
  return (
    <div className="page page-pad">
      <header className="page-head">
        <div>
          <h1>Disputes</h1>
          <p className="muted">Buyers who opened a case with PayPal. Reply before the deadline, or PayPal usually decides for the buyer.</p>
        </div>
        <div className="head-actions">
          <AskButton prompt="Summarise my disputes from the last 90 days: reasons, amounts and what they have in common">What do they have in common?</AskButton>
        </div>
      </header>
      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading />}
      {data && open.length === 0 && <p className="empty-state">No open disputes. When a buyer opens one, it shows up here with its deadline.</p>}
      <div className="stack">
        {open.map((d) => (
          <DisputeCase key={d.id} d={d} focus={arg === d.id} />
        ))}
      </div>
      {closed.length > 0 && (
        <details className="closed">
          <summary>
            {closed.length} resolved {closed.length === 1 ? "dispute" : "disputes"}
          </summary>
          <div className="stack">
            {closed.map((d) => (
              <DisputeCase key={d.id} d={d} focus={false} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function DisputeCase({ d, focus }: { d: Dispute; focus: boolean }) {
  const { propose, status } = useApp();
  const [reply, setReply] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [err, setErr] = useState("");
  const ref = useRef<HTMLElement>(null);
  const urgent = d.daysLeftToRespond !== undefined && d.daysLeftToRespond <= 3;
  const canReply = d.status === "WAITING_FOR_SELLER_RESPONSE";

  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);

  async function draft() {
    setDrafting(true);
    setErr("");
    try {
      setReply((await api.disputeReply(d.id)).message);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  return (
    <article ref={ref} className={`case${urgent && isOpen(d) ? " case-urgent" : ""}${focus ? " case-focus" : ""}`} aria-labelledby={`case-${d.id}`}>
      <header className="case-head">
        <div>
          <h2 id={`case-${d.id}`}>
            {d.customer} <span className="case-amount">{money(d.amount, d.currency)}</span>
          </h2>
          <p className="muted">
            {humanReason(d.reason)} on {d.product ?? "an order"}
            {d.orderDate ? `, ordered ${shortDate(d.orderDate)}` : ""}. Case {d.id}.
          </p>
        </div>
        {isOpen(d) && d.daysLeftToRespond !== undefined ? (
          <div className={`deadline${urgent ? " deadline-urgent" : ""}`}>
            <span className="deadline-num">{d.daysLeftToRespond}</span>
            <span>{d.daysLeftToRespond === 1 ? "day left" : "days left"}</span>
          </div>
        ) : (
          <span className="pill pill-muted">{statusText(d)}</span>
        )}
      </header>

      {d.messages?.length ? (
        <ol className="thread-msgs">
          {d.messages.map((m, i) => (
            <li key={i} className={`tmsg tmsg-${m.from}`}>
              <span className="tmsg-who">
                {m.from === "buyer" ? d.customer : "You"} · {shortDate(m.at)}
              </span>
              <p>{m.text}</p>
            </li>
          ))}
        </ol>
      ) : null}

      {canReply && (
        <div className="case-reply">
          {!reply ? (
            <div className="row-gap">
              <button className="primary" onClick={draft} disabled={drafting || !status?.aiReady}>
                <SparkIcon /> {drafting ? "Writing a reply…" : "Draft a reply with AI"}
              </button>
              <button className="ghost" onClick={() => setReply(" ")}>
                Write it myself
              </button>
              <AskButton prompt={`What should I do about ${d.customer}'s dispute ${d.id}? Should I refund or reply?`}>Should I refund instead?</AskButton>
            </div>
          ) : (
            <>
              <label htmlFor={`reply-${d.id}`} className="muted">
                Your reply to {d.customer}. Edit anything in [brackets] before sending.
              </label>
              <textarea id={`reply-${d.id}`} rows={7} value={reply.trimStart()} onChange={(e) => setReply(e.target.value)} />
              <div className="row-gap">
                <button
                  className="primary"
                  disabled={reply.trim().length < 10}
                  onClick={() =>
                    propose(
                      "propose_dispute_reply",
                      { dispute_id: d.id, message: reply.trim(), reason: `${humanReason(d.reason)} claim for ${money(d.amount, d.currency)}.` },
                      "Disputes page: reply",
                    )
                  }
                >
                  Review and send
                </button>
                <button className="ghost" onClick={draft} disabled={drafting || !status?.aiReady}>
                  {drafting ? "Rewriting…" : "Write another version"}
                </button>
              </div>
            </>
          )}
          {err && <Notice>{err}</Notice>}
        </div>
      )}
    </article>
  );
}
