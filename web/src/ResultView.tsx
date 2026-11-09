import { useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { AgCharts } from "ag-charts-react";
import type { AgChartOptions } from "ag-charts-community";
import type { Answer } from "./api";
import { RichText } from "./RichText";
import { useDarkMode, useGridTheme, palettes } from "./theme";

const MONEY_FIELDS = /amount|sales|refunds|fees|^fee$|^net$|total|due/;

export function ResultView({ answer, compact }: { answer: Answer; compact?: boolean }) {
  const dark = useDarkMode();
  const p = useMemo(() => {
    const base = dark ? palettes.dark : palettes.light;
    return { ...base, fills: [base.indigo, base.madder, base.turmeric] };
  }, [dark]);

  const theme = useGridTheme();

  const t = answer.table;
  const columnDefs = useMemo<ColDef[]>(() => {
    if (!t) return [];
    return t.columns.map((c) => {
      const sample = t.rows.find((r) => r[c.field] !== undefined && r[c.field] !== "")?.[c.field];
      const numeric = typeof sample === "number";
      const def: ColDef = {
        field: c.field,
        headerName: c.header,
        filter: numeric ? "agNumberColumnFilter" : "agTextColumnFilter",
        sortable: true,
        resizable: true,
        minWidth: numeric ? 110 : 140,
        flex: numeric ? 0 : 1,
        type: numeric ? "rightAligned" : undefined,
      };
      if (numeric && MONEY_FIELDS.test(c.field)) {
        def.valueFormatter = (v) =>
          typeof v.value === "number" ? v.value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
        def.cellClassRules = { "cell-negative": (v) => typeof v.value === "number" && v.value < 0 };
      }
      if (c.field === "days_left_to_respond" || c.field === "days_overdue") {
        def.cellClassRules = {
          "cell-urgent": (v) => (c.field === "days_left_to_respond" ? typeof v.value === "number" && v.value <= 3 : v.value > 7),
        };
      }
      return def;
    });
  }, [t]);

  const chartOptions = useMemo<AgChartOptions | null>(() => {
    const c = answer.chart;
    if (!c || !t) return null;
    const timeLike = /date|day|week|month/.test(c.x) || t.rows.every((r) => /^\d{4}-\d{2}/.test(String(r[c.x])));
    const rows = c.type === "line" || timeLike ? t.rows : t.rows.slice(0, 12);
    // Friendlier labels for ISO dates and "0 Sun"-style weekday keys.
    const data = rows.map((r) => {
      const v = String(r[c.x] ?? "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ...r, [c.x]: new Date(v + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) };
      if (/^\d{4}-\d{2}$/.test(v)) return { ...r, [c.x]: new Date(v + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) };
      if (/^\d [A-Z][a-z]{2}$/.test(v)) return { ...r, [c.x]: v.slice(2) };
      return r;
    });
    const header = (f: string) => t.columns.find((x) => x.field === f)?.header ?? f.replace(/_/g, " ");
    const base = {
      data,
      background: { fill: "transparent" },
      title: { text: c.title, color: p.ink, fontFamily: "Anek Latin, sans-serif", fontSize: compact ? 14 : 16, fontWeight: 600 as const },
      legend: { enabled: c.y.length > 1 || c.type === "pie", item: { label: { color: p.muted } } },
      theme: {
        params: { fontFamily: "Anek Latin, Anek Tamil, Anek Devanagari, sans-serif" },
        overrides: {
          common: {
            axes: {
              category: { label: { color: p.muted }, line: { stroke: p.line } },
              number: { label: { color: p.muted }, gridLine: { style: [{ stroke: p.line }] } },
            },
          },
        },
      },
    };
    if (c.type === "pie") {
      return {
        ...base,
        series: [
          {
            type: "donut",
            angleKey: c.y[0],
            legendItemKey: c.x,
            fills: [p.fills[0], p.fills[1], p.fills[2], "#6F7DB8", "#E39A8D", "#8FA36B", "#9A86C4", "#5A8F9E"],
            innerRadiusRatio: 0.6,
          },
        ],
      } as AgChartOptions;
    }
    return {
      ...base,
      series: c.y.map((y, i) => ({
        type: c.type,
        xKey: c.x,
        yKey: y,
        yName: header(y),
        ...(c.type === "bar" ? { fill: p.fills[i % 3], cornerRadius: 3 } : { stroke: p.fills[i % 3], marker: { fill: p.fills[i % 3], size: 5 }, strokeWidth: 2.5 }),
      })),
    } as AgChartOptions;
  }, [answer.chart, t, p]);

  return (
    <div className={`result${compact ? " result-compact" : ""}`}>
      <div className="result-summary">
        <RichText text={answer.summary} />
      </div>
      {chartOptions && (
        <div className="chart-box">
          <AgCharts options={chartOptions} style={{ height: "100%" }} />
        </div>
      )}
      {t && (
        <div className="grid-box">
          <div className="grid-meta">
            <span>
              {t.title}: {t.rows.length} {t.rows.length === 1 ? "row" : "rows"}
            </span>
            <span className="muted">From {answer.dataMode === "demo" ? "the demo store" : "your PayPal sandbox"}</span>
          </div>
          <div className="grid-wrap" style={{ height: Math.min(compact ? 340 : 520, 56 + Math.max(3, t.rows.length) * 44) }}>
            <AgGridReact theme={theme} rowData={t.rows} columnDefs={columnDefs} animateRows={false} suppressCellFocus={false} />
          </div>
        </div>
      )}
    </div>
  );
}
