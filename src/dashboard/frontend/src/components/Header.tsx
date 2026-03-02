import { useEffect, useRef, useState, useCallback } from "react";
import { useDashboardStore } from "../store";
import {
  getNotificationsEnabled,
  setNotificationsEnabled,
  requestNotificationPermission,
} from "../notifications";
import "./Header.css";

const PHASES = ["plan", "execute", "review", "retro", "complete"];

export function Header() {
  const state = useDashboardStore((s) => s.state);
  const activeSprintNumber = useDashboardStore((s) => s.activeSprintNumber);
  const viewingSprintNumber = useDashboardStore((s) => s.viewingSprintNumber);
  const availableSprints = useDashboardStore((s) => s.availableSprints);
  const issues = useDashboardStore((s) => s.issues);
  const connected = useDashboardStore((s) => s.connected);
  const executionMode = useDashboardStore((s) => s.executionMode);
  const sprintLimit = useDashboardStore((s) => s.sprintLimit);
  const repoUrl = useDashboardStore((s) => s.repoUrl);
  const send = useDashboardStore((s) => s.send);
  const setViewingSprint = useDashboardStore((s) => s.setViewingSprint);

  const [elapsed, setElapsed] = useState("0m 00s");
  const [notificationsOn, setNotificationsOn] = useState(getNotificationsEnabled);
  const timerRef = useRef<ReturnType<typeof setInterval>>(null);

  const toggleNotifications = useCallback(async () => {
    if (notificationsOn) {
      setNotificationsEnabled(false);
      setNotificationsOn(false);
    } else {
      const granted = await requestNotificationPermission();
      if (granted) {
        setNotificationsEnabled(true);
        setNotificationsOn(true);
      }
    }
  }, [notificationsOn]);

  const isViewingActive = viewingSprintNumber === activeSprintNumber || viewingSprintNumber === 0;
  const displayNumber = viewingSprintNumber || state.sprintNumber || "—";
  const doneCount = issues.filter((i) => i.status === "completed" || i.status === "done").length;
  const totalCount = issues.length;

  const phase = state.phase;
  const running = phase !== "init" && phase !== "complete" && phase !== "failed" && phase !== "paused";
  const paused = phase === "paused";
  const idle = phase === "init" || phase === "complete" || phase === "failed";

  // Timer tracks autonomous mode runtime only
  const isAutonomousRunning = executionMode === "autonomous" && running;

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (state.finalElapsed) {
      const totalSec = Math.floor(state.finalElapsed / 1000);
      setElapsed(`${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, "0")}s ✓`);
      return;
    }
    if (!state.startedAt) { setElapsed("0m 00s"); return; }
    const start = new Date(state.startedAt).getTime();
    if (!isAutonomousRunning) {
      // Freeze at current value when not in autonomous mode
      const sec = Math.floor((Date.now() - start) / 1000);
      setElapsed(`${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`);
      return;
    }
    const tick = () => {
      const sec = Math.floor((Date.now() - start) / 1000);
      setElapsed(`${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`);
    };
    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [state.startedAt, state.finalElapsed, isAutonomousRunning]);

  const currentSprint = availableSprints.find((s) => s.sprintNumber === viewingSprintNumber);
  const milestoneId = currentSprint?.milestoneNumber ?? displayNumber;
  const sprintLabel = repoUrl
    ? <a href={`${repoUrl}/milestone/${milestoneId}`} target="_blank" rel="noopener">Sprint {displayNumber} ↗</a>
    : `Sprint ${displayNumber}`;

  return (
    <header className="header">
      <div className="header-left">
        <h1>🏃 Sprint Runner</h1>
        <span id="sprint-label" className="sprint-badge">{sprintLabel}</span>
        <button id="btn-prev" className="btn btn-small" onClick={() => setViewingSprint(viewingSprintNumber - 1)} disabled={viewingSprintNumber <= 1}>◀</button>
        <button id="btn-next" className="btn btn-small" onClick={() => setViewingSprint(viewingSprintNumber + 1)} disabled={availableSprints.length > 0 && viewingSprintNumber > Math.max(...availableSprints.map(s => s.sprintNumber))}>▶</button>
        <span className={`phase-badge phase-${phase}`}>{phase.toUpperCase()}</span>
        {!isViewingActive && activeSprintNumber > 0 && (
          <span className="viewing-indicator">👁 viewing — Sprint {activeSprintNumber} running</span>
        )}
      </div>

      <div className="header-right">
        <button
          className={`btn btn-small ${notificationsOn ? "btn-notif-on" : ""}`}
          onClick={toggleNotifications}
          title={notificationsOn ? "Disable browser notifications" : "Enable browser notifications"}
        >
          {notificationsOn ? "🔔" : "🔕"}
        </button>
        <span className="issue-count">{doneCount}/{totalCount} done</span>
        <span className="elapsed">{elapsed}</span>
        <span className={`status-dot ${connected ? "status-connected" : "status-disconnected"}`} />

        <select
          className="btn btn-small"
          value={executionMode}
          onChange={(e) => send({ type: "mode:set", mode: e.target.value })}
        >
          <option value="autonomous">⚙ Autonomous</option>
          <option value="hitl">👤 Human-in-the-Loop</option>
        </select>

        <select
          className="btn btn-small"
          value={sprintLimit}
          onChange={(e) => send({ type: "sprint:set-limit", limit: parseInt(e.target.value, 10) })}
          title="Number of sprints to run"
        >
          <option value="0">∞ Infinite</option>
          <option value="1">1 Sprint</option>
          <option value="2">2 Sprints</option>
          <option value="3">3 Sprints</option>
          <option value="5">5 Sprints</option>
          <option value="10">10 Sprints</option>
        </select>

        {idle && <button className="btn btn-primary" onClick={() => send({ type: "sprint:start" })} disabled={!isViewingActive}>▶ Start</button>}
        {running && isViewingActive && <button className="btn btn-small" onClick={() => send({ type: "sprint:pause" })}>⏸ Pause</button>}
        {paused && isViewingActive && <button className="btn btn-small" onClick={() => send({ type: "sprint:resume" })}>▶ Resume</button>}
        {(running || paused) && isViewingActive && <button className="btn btn-danger btn-small" onClick={() => { if (confirm("Stop sprint?")) send({ type: "sprint:stop" }); }}>⏹ Stop</button>}
      </div>

      <div className="phase-stepper">
        {PHASES.map((p) => {
          const idx = PHASES.indexOf(p);
          const currentIdx = PHASES.indexOf(phase);
          let cls = "step";
          if (phase === "failed") cls += " step-failed";
          else if (idx < currentIdx) cls += " step-done";
          else if (idx === currentIdx) cls += " step-active";
          return <div key={p} className={cls} data-phase={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</div>;
        })}
      </div>
    </header>
  );
}
