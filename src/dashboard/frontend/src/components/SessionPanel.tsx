import { useState, useEffect } from "react";
import { useDashboardStore } from "../store";
import type { AcpSession } from "../types";
import "./SessionPanel.css";

function sessionIcon(s: AcpSession): string {
  if (!s.endedAt) return "⚡";
  switch (s.outcome) {
    case "approved": return "✅";
    case "changes_requested": return "🔄";
    case "failed": return "❌";
    default: return "✅";
  }
}

export function SessionPanel() {
  const sessions = useDashboardStore((s) => s.acpSessions);
  const viewingSessionId = useDashboardStore((s) => s.viewingSessionId);
  const openSession = useDashboardStore((s) => s.openSession);
  const send = useDashboardStore((s) => s.send);
  const [now, setNow] = useState(Date.now());

  // Tick every second so elapsed timers update
  const hasActive = sessions.some((s) => !s.endedAt);
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActive]);

  // Group sessions by issue
  const grouped = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const key = s.issueNumber ? `#${s.issueNumber}` : "general";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  if (sessions.length === 0) {
    return <div className="empty-state">No active ACP sessions</div>;
  }

  return (
    <ul className="session-list">
      {[...grouped.entries()].map(([group, items]) => (
        <li key={group} className="session-group">
          <span className="session-group-label">{group}</span>
          {items.map((s) => {
            const isActive = !s.endedAt;
            const isViewing = viewingSessionId === s.sessionId;
            const elapsed = isActive
              ? Math.floor((now - new Date(s.startedAt).getTime()) / 1000)
              : 0;
            return (
              <div
                key={s.sessionId}
                className={`session-item ${isActive ? "session-active" : "session-ended"}${isViewing ? " session-viewing" : ""}`}
                onClick={() => openSession(s.sessionId)}
              >
                <span className={`session-icon${isActive ? " session-icon-active" : ""}`}>{sessionIcon(s)}</span>
                <span className="session-role">{s.role}</span>
                {s.model && <span className="session-model">{s.model}</span>}
                {isActive && elapsed > 0 && (
                  <span className="session-elapsed">{elapsed}s</span>
                )}
                {isViewing && <span className="session-viewing-badge">viewing</span>}
                {isActive && isViewing && (
                  <button
                    className="session-stop-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm("Stop this session?")) {
                        send({ type: "session:stop", sessionId: s.sessionId });
                      }
                    }}
                    title="Stop session"
                  >
                    ■
                  </button>
                )}
              </div>
            );
          })}
        </li>
      ))}
    </ul>
  );
}
