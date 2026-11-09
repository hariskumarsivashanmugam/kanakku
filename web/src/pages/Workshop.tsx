import { useMemo, useRef, useState } from "react";
import { BryntumScheduler } from "@bryntum/scheduler-react";
import type { BryntumSchedulerProps } from "@bryntum/scheduler-react";
import "@bryntum/scheduler/scheduler.css";
import "@bryntum/scheduler/stockholm-light.css";
import "@bryntum/scheduler/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler/fontawesome/css/solid.css";
import { api, type Job, type Workshop as WorkshopData } from "../api";
import { money, shortDate, useApp, useData } from "../state";
import { AskButton, Loading, Modal, Notice } from "../components";

const STATUS: Record<Job["status"], { label: string; color: string }> = {
  planned: { label: "Planned", color: "#8A93B8" },
  in_progress: { label: "In progress", color: "#2D3E8C" },
  done: { label: "Done, not paid", color: "#D99A1E" },
  paid: { label: "Paid", color: "#2F7A4F" },
};

/** Local calendar date, so dates don't shift across time zones. */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export function Workshop() {
  const { data, error } = useData(api.workshop);
  const { propose, reload, toast } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const scheduler = useRef<BryntumScheduler>(null);

  const selected = data?.jobs.find((j) => j.id === selectedId) ?? null;
  const unpaidDone = (data?.jobs ?? []).filter((j) => j.status === "done");

  async function update(id: string, patch: Parameters<typeof api.updateJob>[1]) {
    try {
      await api.updateJob(id, patch);
    } catch (e) {
      toast((e as Error).message, "error");
    }
    reload();
  }

  const payJobs = (jobs: Job[]) =>
    propose(
      "propose_artisan_payouts",
      { job_ids: jobs.map((j) => j.id), reason: jobs.length === 1 ? `“${jobs[0].title}” is finished.` : `${jobs.length} finished jobs are waiting to be paid.` },
      "Workshop: pay artisans",
    );

  return (
    <div className="page page-pad">
      <header className="page-head">
        <div>
          <h1>Workshop</h1>
          <p className="muted">Who's making what, and when. Drag a job to move it or give it to someone else. When a job is done, pay the artisan through PayPal.</p>
        </div>
        <div className="head-actions">
          <AskButton prompt="Which artisans are free next week, and who could take a new order of 20 Ajrakh stoles?">Who's free next week?</AskButton>
          <button className="primary" onClick={() => setCreating(true)} disabled={!data}>
            New job
          </button>
        </div>
      </header>

      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <dl className="summary-row">
            <div className={data.summary.owedCount ? "is-alert" : ""}>
              <dt>Owed to artisans</dt>
              <dd>{money(data.summary.owed, data.summary.currency, 0)}</dd>
              <dd className="dd-sub">
                {data.summary.owedCount} finished {data.summary.owedCount === 1 ? "job" : "jobs"}
              </dd>
            </div>
            <div>
              <dt>In progress</dt>
              <dd>{data.summary.inProgress}</dd>
              <dd className="dd-sub">jobs being made now</dd>
            </div>
            <div>
              <dt>Paid this month</dt>
              <dd>{money(data.summary.paidThisMonth, data.summary.currency, 0)}</dd>
              <dd className="dd-sub">through PayPal Payouts</dd>
            </div>
          </dl>

          <div className="toolbar">
            {unpaidDone.length > 0 && (
              <button className="primary small" onClick={() => payJobs(unpaidDone)}>
                {unpaidDone.length === 1 ? "Pay for the finished job" : `Pay for all ${unpaidDone.length} finished jobs`}
              </button>
            )}
            <ul className="legend" aria-label="Job colours">
              {Object.values(STATUS).map((s) => (
                <li key={s.label}>
                  <span style={{ background: s.color }} aria-hidden /> {s.label}
                </li>
              ))}
            </ul>
          </div>

          <div className="scheduler-wrap">
            <Schedule data={data} schedulerRef={scheduler} onSelect={setSelectedId} onChange={update} />
          </div>

          {selected ? (
            <JobPanel job={selected} data={data} onUpdate={update} onPay={() => payJobs([selected])} onClose={() => setSelectedId(null)} />
          ) : (
            <p className="muted hint">Select a job to see its details, change its status or pay the artisan.</p>
          )}
        </>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New job">
        {data && (
          <NewJob
            data={data}
            onDone={() => {
              setCreating(false);
              reload();
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function Schedule({
  data,
  schedulerRef,
  onSelect,
  onChange,
}: {
  data: WorkshopData;
  schedulerRef: React.RefObject<BryntumScheduler | null>;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Parameters<typeof api.updateJob>[1]) => void;
}) {
  const resources = useMemo(() => data.artisans.map((a) => ({ id: a.id, name: a.name, craft: a.craft, place: a.place })), [data.artisans]);
  const events = useMemo(
    () =>
      data.jobs.map((j) => ({
        id: j.id,
        resourceId: j.artisanId,
        name: j.title,
        startDate: parseYmd(j.start),
        endDate: parseYmd(j.end),
        eventColor: STATUS[j.status].color,
        draggable: j.status !== "paid",
        resizable: j.status !== "paid",
        pay: j.pay,
        currency: j.currency,
        status: j.status,
      })),
    [data.jobs],
  );

  const props = useMemo<BryntumSchedulerProps>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      startDate: new Date(today.getTime() - 14 * 86_400_000),
      endDate: new Date(today.getTime() + 24 * 86_400_000),
      viewPreset: "weekAndDayLetter",
      tickSize: 36,
      rowHeight: 64,
      barMargin: 8,
      eventStyle: "rounded",
      columns: [
        {
          text: "Artisan",
          field: "name",
          width: 240,
          renderer: ({ record }: any) => ({
            className: "artisan-cell",
            children: [
              { tag: "strong", text: record.name },
              { tag: "span", text: `${record.craft}, ${record.place}` },
            ],
          }),
        },
      ],
      eventRenderer: ({ eventRecord }: any) => ({
        className: "job-bar",
        children: [
          { tag: "span", className: "job-title", text: eventRecord.name },
          { tag: "span", className: "job-meta", text: `${eventRecord.currency} ${eventRecord.pay}, ${STATUS[eventRecord.status as Job["status"]].label.toLowerCase()}` },
        ],
      }),
      timeRangesFeature: { showCurrentTimeLine: true },
      eventEditFeature: false,
      eventMenuFeature: false,
      scheduleMenuFeature: false,
      cellMenuFeature: false,
      eventDragCreateFeature: false,
      eventCopyPasteFeature: false,
      eventTooltipFeature: {
        template: ({ eventRecord }: any) =>
          `<strong>${escapeHtml(eventRecord.name)}</strong><br>${escapeHtml(eventRecord.currency)} ${eventRecord.pay}<br>${STATUS[eventRecord.status as Job["status"]].label}`,
      },
    };
  }, []);

  return (
    <BryntumScheduler
      ref={schedulerRef}
      {...props}
      resources={resources}
      events={events}
      onEventClick={({ eventRecord }) => onSelect(String(eventRecord.id))}
      onAfterEventDrop={({ eventRecords, valid }) => {
        if (!valid) return;
        for (const r of eventRecords as any[]) {
          onChange(String(r.id), { start: ymd(r.startDate), end: ymd(r.endDate), artisanId: String(r.resourceId) });
        }
      }}
      onEventResizeEnd={({ changed, eventRecord }) => {
        if (!changed) return;
        const r = eventRecord as any;
        onChange(String(r.id), { start: ymd(r.startDate), end: ymd(r.endDate) });
      }}
    />
  );
}

function payoutText(status: string) {
  return (
    {
      SUCCESS: "Paid",
      UNCLAIMED: "Sent, waiting for the artisan to accept",
      PENDING: "Sent, PayPal is processing it",
      FAILED: "Failed",
      RETURNED: "Returned",
      BLOCKED: "Blocked by PayPal",
    }[status] ?? status.toLowerCase()
  );
}

function escapeHtml(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function JobPanel({
  job,
  data,
  onUpdate,
  onPay,
  onClose,
}: {
  job: Job;
  data: WorkshopData;
  onUpdate: (id: string, patch: Parameters<typeof api.updateJob>[1]) => void;
  onPay: () => void;
  onClose: () => void;
}) {
  const a = data.artisans.find((x) => x.id === job.artisanId);
  const lastDay = new Date(parseYmd(job.end).getTime() - 86_400_000);
  return (
    <section className="panel job-panel" aria-labelledby="job-title">
      <div className="panel-head">
        <h2 id="job-title">{job.title}</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close job details">
          ×
        </button>
      </div>
      <dl className="job-facts">
        <div>
          <dt>Artisan</dt>
          <dd>
            {a?.name}
            <span className="muted">
              {" "}
              {a?.craft}, {a?.place}
            </span>
          </dd>
        </div>
        <div>
          <dt>When</dt>
          <dd>
            {shortDate(job.start)} to {shortDate(ymd(lastDay))}
          </dd>
        </div>
        <div>
          <dt>Pay</dt>
          <dd>{money(job.pay, job.currency)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <span className={`pill pill-job-${job.status}`}>{STATUS[job.status].label}</span>
          </dd>
        </div>
        {job.customer && (
          <div>
            <dt>For</dt>
            <dd>{job.customer}</dd>
          </div>
        )}
        {job.payout && (
          <div>
            <dt>PayPal payout</dt>
            <dd>
              {payoutText(job.payout.status)} on {shortDate(job.payout.paidAt)}
              <span className="muted"> ({job.payout.batchId})</span>
            </dd>
          </div>
        )}
      </dl>
      <div className="row-gap">
        {job.status === "planned" && (
          <button className="ghost" onClick={() => onUpdate(job.id, { status: "in_progress" })}>
            Mark as started
          </button>
        )}
        {(job.status === "planned" || job.status === "in_progress") && (
          <button className="ghost" onClick={() => onUpdate(job.id, { status: "done" })}>
            Mark as done
          </button>
        )}
        {job.status === "done" && (
          <>
            <button className="primary" onClick={onPay}>
              Pay {a?.name.split(" ")[0]} {money(job.pay, job.currency)}
            </button>
            <button className="ghost" onClick={() => onUpdate(job.id, { status: "in_progress" })}>
              Not done yet
            </button>
          </>
        )}
        {job.status === "paid" && <span className="muted">Paid jobs are locked so they can't be paid twice.</span>}
      </div>
    </section>
  );
}

function NewJob({ data, onDone }: { data: WorkshopData; onDone: () => void }) {
  const { toast } = useApp();
  const today = ymd(new Date());
  const [f, setF] = useState({ artisanId: data.artisans[0]?.id ?? "", title: "", customer: "", start: today, days: 7, pay: 100 });
  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        const end = ymd(new Date(parseYmd(f.start).getTime() + Math.max(1, f.days) * 86_400_000));
        try {
          await api.createJob({ artisanId: f.artisanId, title: f.title, customer: f.customer || undefined, start: f.start, end, pay: f.pay });
          toast("Job added to the schedule");
          onDone();
        } catch (err) {
          toast((err as Error).message, "error");
        }
      }}
    >
      <label>
        What's being made
        <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Ajrakh stoles ×15 for Casa Lino" required />
      </label>
      <label>
        Artisan
        <select value={f.artisanId} onChange={(e) => setF({ ...f, artisanId: e.target.value })}>
          {data.artisans.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}, {a.craft}
            </option>
          ))}
        </select>
      </label>
      <div className="field-row">
        <label>
          Starts
          <input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} required />
        </label>
        <label>
          Working days
          <input type="number" min={1} value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })} />
        </label>
      </div>
      <div className="field-row">
        <label>
          Pay (USD)
          <input type="number" min={0} step="1" value={f.pay} onChange={(e) => setF({ ...f, pay: Number(e.target.value) })} />
        </label>
        <label>
          For customer (optional)
          <input value={f.customer} onChange={(e) => setF({ ...f, customer: e.target.value })} />
        </label>
      </div>
      <div className="modal-foot">
        <button className="primary" type="submit">
          Add to schedule
        </button>
      </div>
    </form>
  );
}
