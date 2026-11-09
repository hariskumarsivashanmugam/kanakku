import { useMemo, useState } from "react";
import { AgCharts } from "ag-charts-react";
import type { AgChartOptions } from "ag-charts-community";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { api, type Overview as OverviewData } from "../api";
import { LANGS, money, useApp, useData } from "../state";
import { chartBase, useGridTheme, usePalette } from "../theme";
import { RichText } from "../RichText";
import { AskButton, Loading, Notice } from "../components";
import { navigate } from "../router";
import { PriceCheckDialog } from "../PriceCheck";

export function Overview() {
  const { lang } = useApp();
  const ov = useData(api.overview);
  const brief = useData(() => api.brief(lang), [lang]);
  const locale = LANGS.find((l) => l.code === lang)?.locale ?? "en-IN";

  return (
    <div className="page page-overview">
      <section className="ledger" aria-labelledby="brief-title">
        <div className="ledger-inner">
          <h1 id="brief-title">Today, {new Date().toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" })}</h1>
          {brief.error ? (
            <p className="brief-warning">Couldn't write today's summary: {brief.error}</p>
          ) : brief.data ? (
            <>
              {brief.data.text && (
                <p className="brief-text">
                  <RichText text={brief.data.text} />
                </p>
              )}
              {brief.data.warnings?.map((w) => (
                <p key={w} className="brief-warning">
                  {w}
                </p>
              ))}
            </>
          ) : (
            <p className="brief-text loading-line" aria-busy="true">
              Reading your account…
            </p>
          )}
        </div>
      </section>

      {ov.error && <Notice>{ov.error}</Notice>}
      {!ov.data ? (
        <div className="page-pad">
          <Loading />
        </div>
      ) : (
        <OverviewBody d={ov.data} />
      )}
    </div>
  );
}

function OverviewBody({ d }: { d: OverviewData }) {
  const k = d.kpis;
  const c = k.currency;
  const salesMissing = d.unavailable.includes("sales");
  return (
    <div className="page-pad overview-grid">
      <dl className="kpis" aria-label="Key numbers">
        <Kpi label="Sales this month" value={salesMissing ? "—" : money(k.salesMtd, c, 0)} sub={salesMissing ? "Needs Transaction search" : change(k.salesChangePct, "vs same days last month")} trend={k.salesChangePct} />
        <Kpi label="You keep, after fees and refunds" value={salesMissing ? "—" : money(k.netMtd, c, 0)} sub={salesMissing ? "" : `${money(k.feesMtd, c, 0)} in PayPal fees`} />
        <Kpi
          label="Refund rate, 30 days"
          value={salesMissing ? "—" : `${k.refundRate30.toFixed(1)}%`}
          sub={salesMissing ? "" : `${k.refundRatePrev30.toFixed(1)}% the 30 days before`}
          trend={salesMissing ? null : -(k.refundRate30 - k.refundRatePrev30)}
          onClick={() => navigate("sales")}
        />
        <Kpi label="Customers owe you" value={money(k.owed, c, 0)} sub={k.overdueCount ? `${money(k.overdue, c, 0)} overdue on ${k.overdueCount} invoices` : "Nothing overdue"} alert={k.overdueCount > 0} onClick={() => navigate("invoices")} />
        <Kpi
          label="Open disputes"
          value={String(k.disputesOpen)}
          sub={k.nextDisputeDays !== null ? `Next reply due in ${k.nextDisputeDays} day${k.nextDisputeDays === 1 ? "" : "s"}` : "No deadlines this week"}
          alert={k.disputesDueSoon > 0}
          onClick={() => navigate("disputes")}
        />
      </dl>

      <section className="panel panel-chart" aria-labelledby="sales-chart-title">
        <div className="panel-head">
          <h2 id="sales-chart-title">Sales and refunds, last 60 days</h2>
          <AskButton prompt="How have my weekly sales changed over the last 60 days, and what drove the peak?">Explain this</AskButton>
        </div>
        {salesMissing ? <p className="muted">Sales appear here once Transaction search is enabled on your PayPal app.</p> : <SalesChart series={d.series} currency={c} />}
      </section>

      <Attention d={d} />

      <section className="panel panel-insights" aria-labelledby="insights-title">
        <div className="panel-head">
          <h2 id="insights-title">What Kanakku noticed</h2>
        </div>
        {d.insights.length === 0 ? (
          <p className="muted">Insights appear once there are a few weeks of sales.</p>
        ) : (
          <ul className="insights">
            {d.insights.slice(0, 4).map((i) => (
              <li key={i.id} className={`insight insight-${i.tone}`}>
                <strong>{i.title}</strong>
                <p>
                  {i.detail} <AskButton prompt={i.ask}>{i.tone === "warn" ? "Ask why" : "Dig in"}</AskButton>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel panel-products" aria-labelledby="products-title">
        <div className="panel-head">
          <h2 id="products-title">Products, last 30 days</h2>
          <button className="link" onClick={() => navigate("sales")}>
            See all sales
          </button>
        </div>
        <ProductsGrid rows={d.topProducts} currency={c} />
      </section>
    </div>
  );
}

function change(p: number | null, suffix: string) {
  if (p === null) return "No sales in the same days last month";
  return `${p >= 0 ? "+" : ""}${Math.round(p)}% ${suffix}`;
}

function Kpi({ label, value, sub, trend, alert, onClick }: { label: string; value: string; sub: string; trend?: number | null; alert?: boolean; onClick?: () => void }) {
  const tone = alert ? "kpi-alert" : trend === undefined || trend === null ? "" : trend >= 0 ? "kpi-up" : "kpi-down";
  const body = (
    <>
      <dt>{label}</dt>
      <dd className="kpi-value">{value}</dd>
      <dd className="kpi-sub">{sub}</dd>
    </>
  );
  return onClick ? (
    <button className={`kpi ${tone}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`kpi ${tone}`}>{body}</div>
  );
}

function SalesChart({ series, currency }: { series: OverviewData["series"]; currency: string }) {
  const p = usePalette();
  const options = useMemo<AgChartOptions>(() => {
    const data = series.map((s) => ({
      ...s,
      label: new Date(s.date + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }),
      refundsNeg: -s.refunds,
    }));
    const fmt = (v: number) => `${currency} ${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
    return {
      ...chartBase(p),
      data,
      series: [
        { type: "bar", xKey: "label", yKey: "sales", yName: "Sales", fill: p.indigo, cornerRadius: 2, tooltip: { renderer: ({ datum }: any) => ({ heading: datum.label, data: [{ label: "Sales", value: fmt(datum.sales) }] }) } },
        { type: "bar", xKey: "label", yKey: "refundsNeg", yName: "Refunds", fill: p.madder, cornerRadius: 2, tooltip: { renderer: ({ datum }: any) => ({ heading: datum.label, data: [{ label: "Refunds", value: fmt(datum.refunds) }] }) } },
      ],
      axes: {
        x: { type: "category", position: "bottom", label: { color: p.muted, autoRotate: false }, line: { stroke: p.line } },
        y: { type: "number", position: "left", label: { color: p.muted, formatter: ({ value }: any) => (value < 0 ? "−" : "") + Math.abs(value).toLocaleString("en-US") }, gridLine: { style: [{ stroke: p.line }] } },
      },
      legend: { position: "top", item: { label: { color: p.muted } } },
    } as AgChartOptions;
  }, [series, p, currency]);
  return (
    <div className="chart-area">
      <AgCharts options={options} style={{ height: "100%" }} />
    </div>
  );
}

function Attention({ d }: { d: OverviewData }) {
  const { propose } = useApp();
  const a = d.attention;
  const c = a.currency;
  const items: { key: string; tone: "urgent" | "normal"; title: string; detail: string; button: string; onClick: () => void }[] = [];

  for (const dis of a.urgent_disputes) {
    items.push({
      key: dis.id,
      tone: "urgent",
      title: `Reply to ${dis.customer}'s dispute`,
      detail: `${money(dis.amount, c)}, due in ${dis.days_left} day${dis.days_left === 1 ? "" : "s"}. If you don't reply, PayPal usually sides with the buyer.`,
      button: "Draft a reply",
      onClick: () => navigate("disputes", dis.id),
    });
  }
  if (a.possible_duplicate_charges.length) {
    const total = a.possible_duplicate_charges.reduce((s, x) => s + x.amount, 0);
    items.push({
      key: "dupes",
      tone: "urgent",
      title: `${a.possible_duplicate_charges.length} customer${a.possible_duplicate_charges.length > 1 ? "s were" : " was"} charged twice`,
      detail: `${a.possible_duplicate_charges.map((x) => x.customer).join(" and ")}, ${money(total, c)} in total, minutes apart.`,
      button: "Refund the duplicates",
      onClick: () =>
        propose(
          "propose_refunds",
          {
            refunds: a.possible_duplicate_charges.map((x) => ({ transaction_id: x.duplicate_charge_id })),
            reason: "Each of these customers was charged twice for the same item within a few minutes.",
          },
          "Overview: duplicate charges",
        ),
    });
  }
  if (a.overdue_invoices.count) {
    items.push({
      key: "overdue",
      tone: "normal",
      title: `${money(a.overdue_invoices.total_due, c, 0)} overdue on ${a.overdue_invoices.count} invoices`,
      detail: `The oldest is ${a.overdue_invoices.oldest_days_overdue} days late.`,
      button: "Chase them",
      onClick: () => navigate("invoices", "overdue"),
    });
  }

  return (
    <section className="panel panel-attention" aria-labelledby="attention-title">
      <div className="panel-head">
        <h2 id="attention-title">Needs attention</h2>
        {items.length > 0 && <span className="count">{items.length}</span>}
      </div>
      {items.length === 0 ? (
        <p className="muted">All clear. No urgent disputes, duplicate charges or overdue invoices.</p>
      ) : (
        <ul className="attention">
          {items.map((i) => (
            <li key={i.key} className={`attention-item attention-${i.tone}`}>
              <strong>{i.title}</strong>
              <p>{i.detail}</p>
              <button className={i.tone === "urgent" ? "primary small" : "ghost small"} onClick={i.onClick}>
                {i.button}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProductsGrid({ rows, currency }: { rows: OverviewData["topProducts"]; currency: string }) {
  const theme = useGridTheme();
  const { status } = useApp();
  const [checking, setChecking] = useState<string | null>(null);
  const cols = useMemo<ColDef[]>(
    (): ColDef[] => [
      { field: "product", headerName: "Product", flex: 2, minWidth: 180 },
      { field: "orders", headerName: "Orders", type: "rightAligned", width: 100 },
      { field: "sales", headerName: `Sales (${currency})`, type: "rightAligned", width: 140, valueFormatter: (v) => v.value.toLocaleString("en-US") },
      {
        field: "change_pct",
        headerName: "vs previous 30 days",
        type: "rightAligned",
        width: 170,
        valueFormatter: (v) => (v.value === null ? "new" : `${v.value >= 0 ? "+" : ""}${Math.round(v.value)}%`),
        cellClassRules: { "cell-good": (v) => v.value > 0, "cell-negative": (v) => v.value < 0 },
      },
      {
        field: "refund_rate_pct",
        headerName: "Refund rate",
        type: "rightAligned",
        width: 130,
        valueFormatter: (v) => `${v.value.toFixed(1)}%`,
        cellClassRules: { "cell-urgent": (v) => v.value >= 10 },
      },
      {
        headerName: "Market price",
        width: 150,
        sortable: false,
        cellRenderer: (p: { data: OverviewData["topProducts"][number] }) => (
          <button
            className="ask-link"
            onClick={() => setChecking(p.data.product)}
            disabled={!status?.priceCheckReady}
            title={status?.priceCheckReady ? "Compare with similar products at other retailers" : "Add CHANNEL3_API_KEY to .env to compare prices"}
          >
            Check price
          </button>
        ),
      },
    ],
    [currency, status?.priceCheckReady],
  );
  return (
    <>
      <div style={{ height: 56 + Math.max(3, rows.length) * 44 }}>
        <AgGridReact theme={theme} rowData={rows} columnDefs={cols} suppressCellFocus />
      </div>
      <PriceCheckDialog product={checking} onClose={() => setChecking(null)} />
    </>
  );
}
