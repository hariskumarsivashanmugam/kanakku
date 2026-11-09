import { useState } from "react";
import { api, type AutopilotRule, type AutopilotRun } from "../api";
import { useApp, useData } from "../state";
import { Loading, Notice } from "../components";
import { navigate } from "../router";

const OUTCOME: Record<AutopilotRun["results"][number]["outcome"], string> = {
  did: "Done",
  asked: "Waiting for you",
  held: "Held back",
  nothing: "Nothing to do",
  error: "Problem",
};

export function Autopilot() {
  const { data, error } = useData(api.autopilot);
  const { reload, toast, upsertActions } = useApp();
  const [running, setRunning] = useState(false);

  async function runNow() {
    setRunning(true);
    try {
      const run = await api.runAutopilot();
      upsertActions(await api.actions());
      const did = run.results.filter((r) => r.outcome === "did").length;
      const asked = run.results.filter((r) => r.outcome === "asked" || r.outcome === "held").length;
      toast(did || asked ? `Autopilot finished: ${did} rule${did === 1 ? "" : "s"} acted, ${asked} waiting for you` : "Autopilot finished: nothing needed doing");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRunning(false);
      reload();
    }
  }

  const last = data?.runs[0];

  return (
    <div className="page page-pad">
      <header className="page-head">
        <div>
          <h1>Autopilot</h1>
          <p className="muted">
            Standing rules Kanakku follows for you. It acts on its own only within the limits you set, and asks you for everything else. Every step is recorded in Activity.
          </p>
        </div>
        <div className="head-actions">
          <button className="primary" onClick={runNow} disabled={running || !data}>
            {running ? "Running…" : "Run now"}
          </button>
        </div>
      </header>

      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <ScheduleBar schedule={data.schedule} lastRun={last?.at} />

          <section aria-labelledby="rules-title" className="autopilot-section">
            <h2 id="rules-title">Rules</h2>
            <div className="rules">
              {data.rules.map((r) => (
                <RuleCard key={r.id} rule={r} lastResult={last?.results.find((x) => x.ruleId === r.id)} />
              ))}
            </div>
          </section>

          <section aria-labelledby="runs-title" className="autopilot-section">
            <h2 id="runs-title">Recent runs</h2>
            {data.runs.length === 0 ? (
              <p className="empty-state">Autopilot hasn't run yet. Press Run now to see what it would do today.</p>
            ) : (
              <ol className="runs">
                {data.runs.map((run) => (
                  <li key={run.id} className="run">
                    <div className="run-head">
                      <time dateTime={run.at}>{new Date(run.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time>
                      <span className="muted">
                        {{ manual: "Run by you", schedule: "Scheduled run", webhook: "After a PayPal event", external: "Run by Render" }[run.trigger]}
                      </span>
                    </div>
                    <ul className="run-results">
                      {run.results.map((r) => (
                        <li key={r.ruleId} className={`rr rr-${r.outcome}`}>
                          <span className="rr-outcome">{OUTCOME[r.outcome]}</span>
                          <span>
                            <strong>{r.ruleName}.</strong> {r.summary}
                            {r.outcome === "asked" || r.outcome === "held" ? (
                              <>
                                {" "}
                                <button className="link" onClick={() => navigate("activity")}>
                                  Review
                                </button>
                              </>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ScheduleBar({ schedule, lastRun }: { schedule: { enabled: boolean; intervalMinutes: number }; lastRun?: string }) {
  const { reload, toast } = useApp();
  const [minutes, setMinutes] = useState(schedule.intervalMinutes);
  const save = async (patch: Partial<typeof schedule>) => {
    try {
      await api.updateSchedule(patch);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <div className="schedule-bar">
      <label className="switch">
        <input type="checkbox" checked={schedule.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        <span>Run automatically every</span>
      </label>
      <input
        className="minutes"
        type="number"
        min={5}
        max={1440}
        value={minutes}
        aria-label="Minutes between runs"
        onChange={(e) => setMinutes(Number(e.target.value))}
        onBlur={() => minutes !== schedule.intervalMinutes && save({ intervalMinutes: minutes })}
      />
      <span>minutes</span>
      <span className="muted schedule-last">{lastRun ? `Last run ${new Date(lastRun).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Not run yet"}</span>
    </div>
  );
}

function RuleCard({ rule, lastResult }: { rule: AutopilotRule; lastResult?: AutopilotRun["results"][number] }) {
  const { reload, toast } = useApp();
  const [params, setParams] = useState(rule.params);
  const save = async (patch: Parameters<typeof api.updateRule>[1]) => {
    try {
      await api.updateRule(rule.id, patch);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  return (
    <article className={`rule${rule.enabled ? "" : " rule-off"}`} aria-labelledby={`rule-${rule.id}`}>
      <div className="rule-head">
        <label className="switch">
          <input type="checkbox" checked={rule.enabled} onChange={(e) => save({ enabled: e.target.checked })} aria-describedby={`rule-desc-${rule.id}`} />
          <h3 id={`rule-${rule.id}`}>{rule.name}</h3>
        </label>
        {rule.modes.length > 1 ? (
          <div className="segmented" role="group" aria-label={`${rule.name}: what to do`}>
            <button aria-pressed={rule.mode === "auto"} onClick={() => save({ mode: "auto" })} disabled={!rule.enabled}>
              Do it for me
            </button>
            <button aria-pressed={rule.mode === "ask"} onClick={() => save({ mode: "ask" })} disabled={!rule.enabled}>
              Ask me first
            </button>
          </div>
        ) : (
          <span className="pill pill-muted">Always asks you first</span>
        )}
      </div>
      <p id={`rule-desc-${rule.id}`} className="muted">
        {rule.description}
      </p>
      <div className="rule-params">
        {Object.entries(params).map(([k, v]) => (
          <label key={k}>
            {rule.paramLabels[k] ?? k}
            <input
              type="number"
              min={0}
              value={v}
              disabled={!rule.enabled}
              onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })}
              onBlur={() => v !== rule.params[k] && save({ params: { [k]: v } })}
            />
          </label>
        ))}
      </div>
      {lastResult && (
        <p className={`rule-last rr-${lastResult.outcome}`}>
          Last run: {lastResult.summary}
        </p>
      )}
    </article>
  );
}
