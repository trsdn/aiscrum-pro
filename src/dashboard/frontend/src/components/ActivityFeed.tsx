import { useEffect, useRef } from "react";
import { useDashboardStore } from "../store";
import "./ActivityFeed.css";

export function ActivityFeed() {
  const activities = useDashboardStore((s) => s.activities);
  const bottomRef = useRef<HTMLLIElement>(null);

  // Scroll to bottom on new entries and on initial mount (tab switch)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activities]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, []);

  return (
    <div id="activity-panel" className="activity-container">
      <ul id="activity-list" className="activity-list">
        {activities.map((a, i) => (
          <li key={i} className={`activity-item activity-${a.status}`}>
            <span className="activity-time">
              {a.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <span className={`activity-dot activity-dot-${a.status}`} />
            <div className="activity-content">
              <span className="activity-label">{a.label}</span>
              {a.detail && <span className="activity-detail">{a.detail}</span>}
            </div>
          </li>
        ))}
        {activities.length === 0 && (
          <li className="empty-state">No activity yet. Start a sprint to see progress.</li>
        )}
        <li ref={bottomRef} style={{ height: 0 }} aria-hidden />
      </ul>
    </div>
  );
}
