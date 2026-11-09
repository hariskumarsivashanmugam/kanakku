import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import { AppProvider, LANGS, useApp, useData } from "./state";
import { navigate, useRoute, type Page } from "./router";
import { Assistant } from "./Assistant";
import { Approvals, ConfirmDialog, SparkIcon, Toasts } from "./components";
import { Overview } from "./pages/Overview";
import { Sales } from "./pages/Sales";
import { Invoices } from "./pages/Invoices";
import { Disputes } from "./pages/Disputes";
import { Activity } from "./pages/Activity";
import { Workshop } from "./pages/Workshop";
import { Autopilot } from "./pages/Autopilot";

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

const NAV: { page: Page; label: string; icon: ReactNode }[] = [
  { page: "overview", label: "Overview", icon: <Icon d="M3 10.5 10 4l7 6.5V17H3z M8 17v-4h4v4" /> },
  { page: "sales", label: "Sales", icon: <Icon d="M3 16h14 M5 13V9 M9 13V5 M13 13v-6" /> },
  { page: "invoices", label: "Invoices", icon: <Icon d="M5 3h10v14l-2.5-1.5L10 17l-2.5-1.5L5 17z M8 7h4 M8 10h4" /> },
  { page: "disputes", label: "Disputes", icon: <Icon d="M10 3 3 16h14z M10 8v4 M10 14v.01" /> },
  { page: "workshop", label: "Workshop", icon: <Icon d="M3 7h14v9H3z M7 7V4h6v3 M3 11h14" /> },
  { page: "autopilot", label: "Autopilot", icon: <Icon d="M10 2.5v3 M10 14.5v3 M2.5 10h3 M14.5 10h3 M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" /> },
  { page: "activity", label: "Activity", icon: <Icon d="M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M10 6v4l3 2" /> },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Shell() {
  const { page, arg } = useRoute();
  const { status, lang, setLang, pending, openAssistant, assistant } = useApp();
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const invoices = useData(api.invoices);
  const disputes = useData(api.disputes);
  const workshop = useData(api.workshop);

  const overdue = (invoices.data ?? []).filter((i) => i.daysOverdue > 0 && ["SENT", "UNPAID", "PARTIALLY_PAID"].includes(i.status)).length;
  const dueSoon = (disputes.data ?? []).filter((d) => !["RESOLVED", "CLOSED"].includes(d.status) && (d.daysLeftToRespond ?? 99) <= 5).length;
  const owedJobs = (workshop.data?.jobs ?? []).filter((j) => j.status === "done").length;
  const badges: Partial<Record<Page, number>> = { invoices: overdue, disputes: dueSoon, workshop: owedJobs };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openAssistant();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openAssistant]);

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className={`shell${assistant.open ? " has-assistant" : ""}`}>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <a className="brand" href="#/overview" aria-label="Kanakku home">
          <span className="wordmark">Kanakku</span>
          <span className="brand-sub">Meena Prints</span>
        </a>
        <ul>
          {NAV.map((n) => (
            <li key={n.page}>
              <a href={`#/${n.page}`} aria-current={page === n.page ? "page" : undefined}>
                {n.icon}
                <span>{n.label}</span>
                {badges[n.page] ? (
                  <span className="badge" aria-label={`${badges[n.page]} need attention`}>
                    {badges[n.page]}
                  </span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot">
          {status && (
            <p className={`source source-${status.dataMode}`}>
              <span className="dot" aria-hidden />
              {status.dataMode === "demo" ? "Demo store" : "PayPal sandbox"}
            </p>
          )}
          <p className="powered">Payments by PayPal. AI by Claude.</p>
        </div>
      </nav>

      <div className="main-col">
        <header className="topbar">
          <button className="ask-bar" onClick={() => openAssistant()}>
            <SparkIcon />
            <span className="ask-bar-text">Ask about your sales, refunds, invoices or disputes…</span>
            <kbd>{isMac ? "⌘" : "Ctrl"} K</kbd>
          </button>
          <div className="topbar-tools">
            <button className={`ghost approvals-btn${pending.length ? " has-pending" : ""}`} onClick={() => setApprovalsOpen(true)}>
              Approvals{pending.length ? <span className="badge">{pending.length}</span> : null}
            </button>
            <label className="lang">
              <span className="sr-only">Language</span>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {LANGS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>

        <main id="main" tabIndex={-1}>
          {page === "overview" && <Overview />}
          {page === "sales" && <Sales />}
          {page === "invoices" && <Invoices arg={arg} />}
          {page === "disputes" && <Disputes arg={arg} />}
          {page === "workshop" && <Workshop />}
          {page === "autopilot" && <Autopilot />}
          {page === "activity" && <Activity />}
        </main>
      </div>

      <Assistant />
      <Approvals open={approvalsOpen} onClose={() => setApprovalsOpen(false)} />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}

export { navigate };
