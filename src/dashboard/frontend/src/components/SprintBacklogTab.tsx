import { useEffect, useState } from "react";
import type { GhIssueItem } from "../types";
import { useDashboardStore } from "../store";
import { IssueCard } from "./IssueCard";
import "./TabList.css";

export function SprintBacklogTab() {
  const [items, setItems] = useState<GhIssueItem[]>([]);
  const [sprintNumber, setSprintNumber] = useState(0);
  const [loading, setLoading] = useState(true);
  const send = useDashboardStore((s) => s.send);

  const fetchItems = () => {
    setLoading(true);
    fetch("/api/sprint-backlog")
      .then((r) => r.json())
      .then((d) => {
        setSprintNumber(d.sprintNumber ?? 0);
        setItems(Array.isArray(d.items) ? d.items : []);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchItems(); }, []);

  const handleRemove = (issueNumber: number) => {
    if (confirm(`Remove #${issueNumber} from Sprint ${sprintNumber}?`)) {
      send({ type: "backlog:remove-issue", issueNumber });
      setItems((prev) => prev.filter((i) => i.number !== issueNumber));
    }
  };

  if (loading) return <div className="tab-loading">Loading sprint backlog...</div>;
  if (items.length === 0) return <div className="tab-empty">No issues in sprint backlog.</div>;

  return (
    <div className="tab-list-container">
      <div className="tab-list-header">
        <h2>📦 Sprint {sprintNumber} Backlog ({items.length})</h2>
        <button className="btn btn-small" onClick={fetchItems}>↻ Refresh</button>
      </div>
      <ul className="tab-list">
        {items.map((item) => (
          <IssueCard
            key={item.number}
            item={item}
            actions={
              <button
                className="btn btn-small btn-danger"
                onClick={() => handleRemove(item.number)}
              >
                ✕ Remove
              </button>
            }
          />
        ))}
      </ul>
    </div>
  );
}
