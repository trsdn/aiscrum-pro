import { useDashboardStore } from "../store";
import { Markdown } from "./Markdown";
import "./SessionPanel.css";

export function SessionPanel() {
  const sessions = useDashboardStore((s) => s.acpSessions);
  const viewingSessionId = useDashboardStore((s) => s.viewingSessionId);
  const sessionOutput = useDashboardStore((s) => s.sessionOutput);
  const openSession = useDashboardStore((s) => s.openSession);
  const closeSession = useDashboardStore((s) => s.closeSession);
  const send = useDashboardStore((s) => s.send);

  if (viewingSessionId) {
    const session = sessions.find((s) => s.sessionId === viewingSessionId);
    const output = sessionOutput.get(viewingSessionId) ?? "";

    return (
      <div className="session-viewer">
        <div className="session-viewer-header">
          <button className="btn btn-small" onClick={closeSession}>← Back</button>
          <span className="session-viewer-title">
            {session?.role ?? "Session"} {session?.issueNumber ? `#${session.issueNumber}` : ""}
          </span>
          {session && !session.endedAt && (
            <button
              className="btn btn-danger btn-small"
              onClick={() => {
                if (confirm("Stop this session?")) {
                  send({ type: "session:stop", sessionId: viewingSessionId });
                }
              }}
            >
              Stop
            </button>
          )}
        </div>
        <div className="session-output">
          <Markdown text={output || "Waiting for output..."} />
        </div>
      </div>
    );
  }

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
            const elapsed = isActive
              ? Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000)
              : 0;
            return (
              <div
                key={s.sessionId}
                className={`session-item ${isActive ? "session-active" : "session-ended"}`}
                onClick={() => openSession(s.sessionId)}
              >
                <span className="session-icon">{isActive ? "⚡" : "✅"}</span>
                <span className="session-role">{s.role}</span>
                {s.model && <span className="session-model">{s.model}</span>}
                {isActive && elapsed > 0 && (
                  <span className="session-elapsed">{elapsed}s</span>
                )}
              </div>
            );
          })}
        </li>
      ))}
    </ul>
  );
}
