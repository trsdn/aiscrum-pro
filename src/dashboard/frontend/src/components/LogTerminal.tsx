import { useEffect, useRef } from "react";
import { useDashboardStore } from "../store";
import "./LogTerminal.css";

export function LogTerminal() {
  const logs = useDashboardStore((s) => s.logs);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="log-terminal">
      <div className="log-terminal-header">
        <span className="log-terminal-title">⬤ Terminal</span>
        <span className="log-terminal-count">{logs.length} entries</span>
      </div>
      <div className="log-terminal-body">
        {logs.length === 0 && (
          <div className="log-terminal-empty">Waiting for log output...</div>
        )}
        {logs.map((l, i) => (
          <div key={i} className={`log-line log-${l.level}`}>
            <span className="log-ts">
              {l.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span className={`log-level log-level-${l.level}`}>{l.level.toUpperCase()}</span>
            <span className="log-text">{l.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
