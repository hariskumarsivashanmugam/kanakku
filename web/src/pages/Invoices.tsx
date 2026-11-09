import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, RowSelectionOptions } from "ag-grid-community";
import { api, type Invoice, type InvoiceDraft } from "../api";
import { money, shortDate, useApp, useData } from "../state";
import { useGridTheme } from "../theme";
import { AskButton, Loading, Modal, Notice, SparkIcon } from "../components";
import { navigate } from "../router";

const OPEN = ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED"];
const TABS = [
  { key: "all", label: "All" },
  { key: "overdue", label: "Overdue" },
  { key: "open", label: "Waiting for payment" },
  { key: "paid", label: "Paid" },
  { key: "draft", label: "Drafts" },
] as const;

const statusLabel = (i: Invoice) => {
  if (OPEN.includes(i.status) && i.daysOverdue > 0) return { text: `${i.daysOverdue} days overdue`, cls: "overdue" };
  return (
    {
      SENT: { text: "Sent", cls: "open" },
      UNPAID: { text: "Unpaid", cls: "open" },
      SCHEDULED: { text: "Scheduled", cls: "open" },
      PARTIALLY_PAID: { text: "Part paid", cls: "open" },
      PAID: { text: "Paid", cls: "paid" },
      MARKED_AS_PAID: { text: "Paid", cls: "paid" },
      DRAFT: { text: "Draft", cls: "muted" },
      CANCELLED: { text: "Cancelled", cls: "muted" },
    } as Record<string, { text: string; cls: string }>
  )[i.status] ?? { text: i.status, cls: "muted" };
};

export function Invoices({ arg }: { arg: string | null }) {
  const [tab, setTab] = useState<string>(arg && TABS.some((t) => t.key === arg) ? arg : "all");
  const [selected, setSelected] = useState<Invoice[]>([]);
  const [composer, setComposer] = useState(false);
  const { data, error } = useData(api.invoices);
  const { propose } = useApp();
  const theme = useGridTheme();
  const grid = useRef<GridApi<Invoice> | null>(null);

  useEffect(() => {
    if (arg && TABS.some((t) => t.key === arg)) setTab(arg);
  }, [arg]);

  const rows = useMemo(() => {
    const all = data ?? [];
    switch (tab) {
      case "overdue":
        return all.filter((i) => OPEN.includes(i.status) && i.daysOverdue > 0);
      case "open":
        return all.filter((i) => OPEN.includes(i.status));
      case "paid":
        return all.filter((i) => ["PAID", "MARKED_AS_PAID"].includes(i.status));
      case "draft":
        return all.filter((i) => i.status === "DRAFT");
      default:
        return all;
    }
  }, [data, tab]);

  const c = data?.[0]?.currency ?? "USD";
  const sums = useMemo(() => {
    const all = data ?? [];
    const open = all.filter((i) => OPEN.includes(i.status));
    const overdue = open.filter((i) => i.daysOverdue > 0);
    const yearStart = `${new Date().getUTCFullYear()}-01-01`;
    const paid = all.filter((i) => ["PAID", "MARKED_AS_PAID"].includes(i.status) && i.issueDate >= yearStart);
    return {
      owed: open.reduce((s, i) => s + i.amountDue, 0),
      overdue: overdue.reduce((s, i) => s + i.amountDue, 0),
      overdueCount: overdue.length,
      openCount: open.length,
      paid: paid.reduce((s, i) => s + i.amount, 0),
      paidCount: paid.length,
    };
  }, [data]);

  const cols = useMemo<ColDef<Invoice>[]>(
    () => [
      { field: "number", headerName: "Invoice", width: 120 },
      { field: "customer", headerName: "Customer", flex: 1, minWidth: 170 },
      {
        field: "status",
        headerName: "Status",
        width: 170,
        cellRenderer: (p: { data: Invoice }) => {
          const s = statusLabel(p.data);
          return <span className={`pill pill-${s.cls}`}>{s.text}</span>;
        },
      },
      { field: "amount", headerName: `Total (${c})`, type: "rightAligned", width: 130, valueFormatter: (v) => v.value.toLocaleString("en-US", { minimumFractionDigits: 2 }) },
      { field: "amountDue", headerName: "Still owed", type: "rightAligned", width: 130, valueFormatter: (v) => (v.value ? v.value.toLocaleString("en-US", { minimumFractionDigits: 2 }) : "—") },
      { field: "issueDate", headerName: "Sent", width: 110, valueFormatter: (v) => (v.value ? shortDate(v.value) : "") },
      { field: "dueDate", headerName: "Due", width: 110, valueFormatter: (v) => (v.value ? shortDate(v.value) : "") },
      { field: "lastReminder", headerName: "Last reminder", width: 140, valueFormatter: (v) => (v.value ? shortDate(v.value) : "—") },
    ],
    [c],
  );

  const rowSelection = useMemo<RowSelectionOptions<Invoice>>(
    () => ({ mode: "multiRow", isRowSelectable: (n) => Boolean(n.data && OPEN.includes(n.data.status)), hideDisabledCheckboxes: true }),
    [],
  );

  const remind = (list: Invoice[], source: string) =>
    propose(
      "propose_invoice_reminders",
      {
        invoice_ids: list.map((i) => i.id),
        reason: list.length === 1 ? `${list[0].number} is waiting for payment.` : `${list.length} invoices are waiting for payment.`,
        note: "Hope all is well! A gentle reminder that this invoice is now due. You can pay securely through the PayPal link. Thank you for stocking our prints.",
      },
      source,
    );

  return (
    <div className="page page-pad">
      <header className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="muted">What customers owe you. Tick open invoices to send reminders.</p>
        </div>
        <div className="head-actions">
          <AskButton prompt="Which customers usually pay their invoices late, and by how much?">Who pays late?</AskButton>
          <button className="primary" onClick={() => setComposer(true)}>
            New invoice
          </button>
        </div>
      </header>

      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <dl className="summary-row">
            <div>
              <dt>Customers owe you</dt>
              <dd>{money(sums.owed, c, 0)}</dd>
              <dd className="dd-sub">{sums.openCount} open invoices</dd>
            </div>
            <div className={sums.overdueCount ? "is-alert" : ""}>
              <dt>Overdue</dt>
              <dd>{money(sums.overdue, c, 0)}</dd>
              <dd className="dd-sub">{sums.overdueCount} invoices</dd>
            </div>
            <div>
              <dt>Paid this year</dt>
              <dd>{money(sums.paid, c, 0)}</dd>
              <dd className="dd-sub">{sums.paidCount} invoices</dd>
            </div>
          </dl>

          <div className="toolbar">
            <div className="segmented" role="group" aria-label="Show">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  aria-pressed={tab === t.key}
                  onClick={() => {
                    setTab(t.key);
                    navigate("invoices", t.key === "all" ? undefined : t.key);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {tab === "overdue" && rows.length > 0 && (
              <button className="primary small" onClick={() => remind(rows, "Invoices page: remind all overdue")}>
                Remind all {rows.length} overdue
              </button>
            )}
          </div>

          <div className={`selection-bar${selected.length ? " is-on" : ""}`} aria-live="polite">
            {selected.length ? (
              <>
                <span>
                  {selected.length} selected, {money(selected.reduce((s, i) => s + i.amountDue, 0), c)} owed
                </span>
                <button className="primary small" onClick={() => remind(selected, "Invoices page: remind selected")}>
                  Send reminders
                </button>
                <button className="ghost small" onClick={() => grid.current?.deselectAll()}>
                  Clear
                </button>
              </>
            ) : (
              <span className="muted">
                {rows.length} {rows.length === 1 ? "invoice" : "invoices"}
              </span>
            )}
          </div>

          <div style={{ height: 60 + Math.max(4, Math.min(rows.length, 12)) * 44 }}>
            <AgGridReact<Invoice>
              theme={theme}
              rowData={rows}
              columnDefs={cols}
              rowSelection={rowSelection}
              getRowId={(p) => p.data.id}
              onGridReady={(e) => (grid.current = e.api)}
              onSelectionChanged={(e) => setSelected(e.api.getSelectedRows())}
              defaultColDef={{ sortable: true, resizable: true, filter: true }}
              overlayNoRowsTemplate="Nothing here."
            />
          </div>
        </>
      )}

      <Modal open={composer} onClose={() => setComposer(false)} title="New invoice" wide>
        <InvoiceComposer onDone={() => setComposer(false)} />
      </Modal>
    </div>
  );
}

const SAMPLE = `Hi Meena! Loved the last batch. For the Lisbon shop could you send 12 Ajrakh stoles and 20 block-print tote bags? Same price as before, $32 for the stoles and $11 per tote. Please invoice Casa Lino, hola@casalino.example.com. We can pay within 2 weeks. Obrigada! – Inês`;

function InvoiceComposer({ onDone }: { onDone: () => void }) {
  const { propose, status } = useApp();
  const [text, setText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [err, setErr] = useState("");
  const [d, setD] = useState<InvoiceDraft>({ customer_name: "", customer_email: "", currency: "USD", items: [{ name: "", quantity: 1, unit_amount: 0 }], due_in_days: 14, note: "", missing: [] });

  const total = d.items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_amount) || 0), 0);
  const valid = d.customer_name.trim() && /\S+@\S+\.\S+/.test(d.customer_email) && d.items.length && d.items.every((i) => i.name.trim() && i.quantity > 0 && i.unit_amount > 0);

  async function fill() {
    setDrafting(true);
    setErr("");
    try {
      const draft = await api.invoiceDraft(text);
      setD({ ...draft, items: draft.items.length ? draft.items : [{ name: "", quantity: 1, unit_amount: 0 }] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  const setItem = (i: number, patch: Partial<InvoiceDraft["items"][number]>) => setD((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));

  return (
    <div className="composer">
      <section className="composer-paste">
        <label htmlFor="paste">
          <strong>Paste the order</strong>
          <span className="muted"> from WhatsApp, email or a note, in any language. Kanakku fills in the invoice for you to check.</span>
        </label>
        <textarea id="paste" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste a message here…" />
        <div className="row-gap">
          <button className="primary" onClick={fill} disabled={drafting || text.trim().length < 10 || !status?.aiReady}>
            <SparkIcon /> {drafting ? "Reading the message…" : "Fill in the invoice"}
          </button>
          <button className="link" onClick={() => setText(SAMPLE)}>
            Use an example message
          </button>
        </div>
        {err && <Notice>{err}</Notice>}
      </section>

      <form
        className="composer-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          propose(
            "propose_new_invoice",
            {
              customer_name: d.customer_name,
              customer_email: d.customer_email,
              currency: d.currency || "USD",
              items: d.items.map((i) => ({ name: i.name, quantity: Number(i.quantity), unit_amount: Number(i.unit_amount) })),
              note: d.note || undefined,
              due_in_days: Number(d.due_in_days) || 14,
              reason: text ? "Filled in from a pasted message and checked by you." : "Created on the Invoices page.",
            },
            "Invoices page: new invoice",
          ).then((a) => a && onDone());
        }}
      >
        {d.missing.length > 0 && <Notice tone="info">Still needed: {d.missing.join(", ")}.</Notice>}
        <div className="field-row">
          <label>
            Bill to
            <input value={d.customer_name} onChange={(e) => setD({ ...d, customer_name: e.target.value })} required />
          </label>
          <label>
            Email
            <input type="email" value={d.customer_email} onChange={(e) => setD({ ...d, customer_email: e.target.value })} required />
          </label>
        </div>
        <table className="items">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Qty</th>
              <th scope="col">Price</th>
              <th scope="col">Amount</th>
              <th scope="col">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((it, i) => (
              <tr key={i}>
                <td>
                  <input aria-label="Item" value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} />
                </td>
                <td>
                  <input aria-label="Quantity" type="number" min={1} value={it.quantity} onChange={(e) => setItem(i, { quantity: Number(e.target.value) })} />
                </td>
                <td>
                  <input aria-label="Unit price" type="number" min={0} step="0.01" value={it.unit_amount} onChange={(e) => setItem(i, { unit_amount: Number(e.target.value) })} />
                </td>
                <td className="num">{(it.quantity * it.unit_amount).toFixed(2)}</td>
                <td>
                  {d.items.length > 1 && (
                    <button type="button" className="icon-btn" aria-label={`Remove ${it.name || "item"}`} onClick={() => setD({ ...d, items: d.items.filter((_, j) => j !== i) })}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="link" onClick={() => setD({ ...d, items: [...d.items, { name: "", quantity: 1, unit_amount: 0 }] })}>
          Add an item
        </button>
        <div className="field-row">
          <label>
            Currency
            <input value={d.currency} maxLength={3} onChange={(e) => setD({ ...d, currency: e.target.value.toUpperCase() })} />
          </label>
          <label>
            Due in (days)
            <input type="number" min={1} value={d.due_in_days} onChange={(e) => setD({ ...d, due_in_days: Number(e.target.value) })} />
          </label>
        </div>
        <label>
          Note to customer
          <textarea rows={2} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} />
        </label>
        <div className="composer-foot">
          <strong>Total {money(total, d.currency || "USD")}</strong>
          <button className="primary" type="submit" disabled={!valid}>
            Review and send
          </button>
        </div>
      </form>
    </div>
  );
}
