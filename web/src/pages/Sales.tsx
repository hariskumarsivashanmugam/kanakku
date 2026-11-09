import { useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi, RowSelectionOptions } from "ag-grid-community";
import { AgCharts } from "ag-charts-react";
import type { AgChartOptions } from "ag-charts-community";
import { api, type Txn } from "../api";
import { money, useApp, useData } from "../state";
import { chartBase, useGridTheme, usePalette } from "../theme";
import { AskButton, Loading, Notice } from "../components";

const RANGES = [7, 30, 90] as const;
const KINDS = [
  { key: "all", label: "Everything" },
  { key: "payment", label: "Payments" },
  { key: "refund", label: "Refunds" },
  { key: "payout", label: "Bank transfers" },
] as const;

export function Sales() {
  const [days, setDays] = useState<number>(30);
  const [kind, setKind] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Txn[]>([]);
  const { data, error } = useData(() => api.transactions(days), [days]);
  const { propose } = useApp();
  const grid = useRef<GridApi<Txn> | null>(null);
  const theme = useGridTheme();

  const rows = useMemo(() => (data ?? []).filter((t) => kind === "all" || t.kind === kind), [data, kind]);
  const c = data?.[0]?.currency ?? "USD";
  const totals = useMemo(() => {
    const all = data ?? [];
    const sales = all.filter((t) => t.kind === "payment").reduce((s, t) => s + t.amount, 0);
    const refunds = all.filter((t) => t.kind === "refund").reduce((s, t) => s - t.amount, 0);
    const fees = all.filter((t) => t.kind === "payment").reduce((s, t) => s + t.fee, 0);
    return { sales, refunds, fees, orders: all.filter((t) => t.kind === "payment").length };
  }, [data]);

  const cols = useMemo<ColDef<Txn>[]>(
    () => [
      {
        field: "date",
        headerName: "Date",
        width: 150,
        sort: "desc",
        valueFormatter: (v) => new Date(v.value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
      },
      { field: "customer", headerName: "Customer", flex: 1, minWidth: 150 },
      { field: "product", headerName: "Product", flex: 1.3, minWidth: 180 },
      {
        field: "kind",
        headerName: "Type",
        width: 130,
        cellRenderer: (p: { data: Txn }) => {
          const t = p.data;
          const label = t.kind === "payment" ? (t.refunded ? "Refunded" : "Payment") : t.kind === "refund" ? "Refund" : t.kind === "payout" ? "Bank transfer" : t.kind;
          return <span className={`pill pill-${t.refunded ? "muted" : t.kind}`}>{label}</span>;
        },
      },
      {
        field: "amount",
        headerName: `Amount (${c})`,
        type: "rightAligned",
        width: 140,
        valueFormatter: (v) => v.value.toLocaleString("en-US", { minimumFractionDigits: 2 }),
        cellClassRules: { "cell-negative": (v) => v.value < 0 },
      },
      { field: "fee", headerName: "Fee", type: "rightAligned", width: 100, valueFormatter: (v) => (v.value ? v.value.toFixed(2) : "") },
      { field: "net", headerName: "Net", type: "rightAligned", width: 120, valueFormatter: (v) => v.value.toLocaleString("en-US", { minimumFractionDigits: 2 }) },
      { field: "id", headerName: "Transaction id", width: 190, cellClass: "cell-id" },
    ],
    [c],
  );

  const rowSelection = useMemo<RowSelectionOptions<Txn>>(
    () => ({ mode: "multiRow", isRowSelectable: (n) => n.data?.kind === "payment" && !n.data.refunded, hideDisabledCheckboxes: true }),
    [],
  );

  const refundTotal = selected.reduce((s, t) => s + t.amount, 0);

  return (
    <div className="page page-pad">
      <header className="page-head">
        <div>
          <h1>Sales</h1>
          <p className="muted">Every payment, refund and bank transfer. Tick payments to refund them.</p>
        </div>
        <div className="head-actions">
          <AskButton prompt="Find duplicate charges from the last two weeks and prepare refunds for them">Find duplicate charges</AskButton>
          <AskButton prompt={`Which customers spent the most in the last ${days} days?`}>Top customers</AskButton>
        </div>
      </header>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={days === r} onClick={() => setDays(r)}>
              {r} days
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Type">
          {KINDS.map((k) => (
            <button key={k.key} aria-pressed={kind === k.key} onClick={() => setKind(k.key)}>
              {k.label}
            </button>
          ))}
        </div>
        <label className="search">
          <span className="sr-only">Search sales</span>
          <input
            type="search"
            placeholder="Search customer, product or id"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              grid.current?.setGridOption("quickFilterText", e.target.value);
            }}
          />
        </label>
      </div>

      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <dl className="summary-row">
            <div>
              <dt>Sales</dt>
              <dd>{money(totals.sales, c, 0)}</dd>
            </div>
            <div>
              <dt>Orders</dt>
              <dd>{totals.orders}</dd>
            </div>
            <div>
              <dt>Refunded</dt>
              <dd className="neg">{money(totals.refunds, c, 0)}</dd>
            </div>
            <div>
              <dt>PayPal fees</dt>
              <dd>{money(totals.fees, c, 0)}</dd>
            </div>
            <div>
              <dt>Average order</dt>
              <dd>{money(totals.orders ? totals.sales / totals.orders : 0, c)}</dd>
            </div>
          </dl>

          <ProductChart txns={data} currency={c} />

          <div className={`selection-bar${selected.length ? " is-on" : ""}`} aria-live="polite">
            {selected.length ? (
              <>
                <span>
                  {selected.length} payment{selected.length > 1 ? "s" : ""} selected, {money(refundTotal, c)}
                </span>
                <button
                  className="primary small"
                  onClick={() =>
                    propose(
                      "propose_refunds",
                      { refunds: selected.map((t) => ({ transaction_id: t.id })), reason: "Selected on the Sales page." },
                      "Sales page: refund selected",
                    )
                  }
                >
                  Refund selected
                </button>
                <button className="ghost small" onClick={() => grid.current?.deselectAll()}>
                  Clear
                </button>
              </>
            ) : (
              <span className="muted">
                {rows.length} {rows.length === 1 ? "row" : "rows"}
                {search ? ` matching “${search}”` : ""}
              </span>
            )}
          </div>

          <div className="grid-tall">
            <AgGridReact<Txn>
              theme={theme}
              rowData={rows}
              columnDefs={cols}
              rowSelection={rowSelection}
              getRowId={(p) => p.data.id}
              onGridReady={(e) => (grid.current = e.api)}
              onSelectionChanged={(e) => setSelected(e.api.getSelectedRows())}
              defaultColDef={{ sortable: true, resizable: true, filter: true }}
              pagination
              paginationPageSize={50}
              paginationPageSizeSelector={[25, 50, 100]}
            />
          </div>
        </>
      )}
    </div>
  );
}

function ProductChart({ txns, currency }: { txns: Txn[]; currency: string }) {
  const p = usePalette();
  const options = useMemo<AgChartOptions>(() => {
    const by = new Map<string, { product: string; sales: number; refunds: number }>();
    for (const t of txns) {
      if (t.kind !== "payment" && t.kind !== "refund") continue;
      const name = t.product.replace(/ ×\d+$/, "");
      const r = by.get(name) ?? { product: name, sales: 0, refunds: 0 };
      if (t.kind === "payment") r.sales += t.amount;
      else r.refunds -= t.amount;
      by.set(name, r);
    }
    const data = [...by.values()].sort((a, b) => b.sales - a.sales).slice(0, 8);
    return {
      ...chartBase(p),
      title: { text: `Sales and refunds by product (${currency})`, color: p.ink, fontSize: 15, fontWeight: 600 },
      data,
      series: [
        { type: "bar", direction: "horizontal", xKey: "product", yKey: "sales", yName: "Sales", fill: p.indigo, cornerRadius: 2 },
        { type: "bar", direction: "horizontal", xKey: "product", yKey: "refunds", yName: "Refunds", fill: p.madder, cornerRadius: 2 },
      ],
      legend: { position: "top" },
    } as AgChartOptions;
  }, [txns, p, currency]);
  return (
    <div className="panel chart-panel">
      <div className="chart-area chart-short">
        <AgCharts options={options} style={{ height: "100%" }} />
      </div>
    </div>
  );
}
