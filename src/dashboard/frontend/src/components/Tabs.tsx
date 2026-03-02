import { useEffect, useState } from "react";
import type { GhIssueItem } from "../types";
import { useDashboardStore } from "../store";
import "./TabList.css";

export function BacklogTab() {
  const [items, setItems] = useState<GhIssueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const send = useDashboardStore((s) => s.send);
  const repoUrl = useDashboardStore((s) => s.repoUrl);
  const sprintNumber = useDashboardStore((s) => s.activeSprintNumber);
  const backlogPending = useDashboardStore((s) => s.backlogPending);
  const backlogPlanned = useDashboardStore((s) => s.backlogPlanned);

  const fetchItems = () => {
    setLoading(true);
    fetch("/api/backlog")
      .then((r) => r.json())
      .then((d) => {
        setItems(Array.isArray(d) ? d : []);
        // Clear planned set on refresh since server data is fresh
        useDashboardStore.setState({ backlogPlanned: new Set() });
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchItems(); }, []);

  const planIssue = (num: number) => {
    useDashboardStore.setState((s) => ({ backlogPending: new Set(s.backlogPending).add(num) }));
    send({ type: "backlog:plan-issue", issueNumber: num });
  };

  // Hide items that were confirmed planned (until next refresh)
  const visibleItems = items.filter((i) => !backlogPlanned.has(i.number));

  if (loading) return <div className="tab-loading">Loading backlog...</div>;
  if (visibleItems.length === 0) return <div className="tab-empty">No backlog items.</div>;

  return (
    <div className="tab-list-container">
      <div className="tab-list-header">
        <h2>Backlog ({visibleItems.length})</h2>
        <button className="btn btn-small" onClick={fetchItems}>↻ Refresh</button>
      </div>
      <ul className="tab-list">
        {visibleItems.map((item) => (
          <li key={item.number} className="tab-list-item">
            <div className="tab-list-item-header">
              {repoUrl ? (
                <a href={`${repoUrl}/issues/${item.number}`} target="_blank" rel="noopener" className="item-number">#{item.number}</a>
              ) : (
                <span className="item-number">#{item.number}</span>
              )}
              <span className="item-title">{item.title}</span>
              <button
                className={`btn btn-small btn-primary${backlogPending.has(item.number) ? " btn-pending" : ""}`}
                disabled={backlogPending.has(item.number)}
                onClick={() => planIssue(item.number)}
              >
                {backlogPending.has(item.number) ? "Adding…" : `→ Sprint ${sprintNumber || "?"}`}
              </button>
            </div>
            {item.labels && item.labels.length > 0 && (
              <div className="item-labels">
                {item.labels.map((l) => <span key={l} className="label-badge">{l}</span>)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BlockedTab() {
  const [items, setItems] = useState<GhIssueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const send = useDashboardStore((s) => s.send);
  const repoUrl = useDashboardStore((s) => s.repoUrl);

  const fetchItems = () => {
    setLoading(true);
    fetch("/api/blocked")
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchItems(); }, []);

  if (loading) return <div className="tab-loading">Loading blocked items...</div>;
  if (items.length === 0) return <div className="tab-empty">No blocked items 🎉</div>;

  return (
    <div className="tab-list-container">
      <div className="tab-list-header">
        <h2>Blocked ({items.length})</h2>
        <button className="btn btn-small" onClick={fetchItems}>↻ Refresh</button>
      </div>
      <ul className="tab-list">
        {items.map((item) => (
          <li key={item.number} className="tab-list-item">
            <div className="tab-list-item-header">
              {repoUrl ? (
                <a href={`${repoUrl}/issues/${item.number}`} target="_blank" rel="noopener" className="item-number">#{item.number}</a>
              ) : (
                <span className="item-number">#{item.number}</span>
              )}
              <span className="item-title">{item.title}</span>
              <button
                className="btn btn-small"
                onClick={() => {
                  const msg = prompt("Add comment:");
                  if (msg) send({ type: "blocked:comment", issueNumber: item.number, body: msg });
                }}
              >
                💬
              </button>
              <button
                className="btn btn-small btn-primary"
                onClick={() => {
                  if (confirm(`Unblock #${item.number}?`))
                    send({ type: "blocked:unblock", issueNumber: item.number });
                }}
              >
                🔓 Unblock
              </button>
            </div>
            {item.blockedReason && (
              <div className="item-blocked-reason">
                <strong>⛔ Reason:</strong> {item.blockedReason}
              </div>
            )}
            {item.body && <div className="item-body">{item.body.slice(0, 300)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DecisionsTab() {
  const [items, setItems] = useState<GhIssueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const send = useDashboardStore((s) => s.send);
  const repoUrl = useDashboardStore((s) => s.repoUrl);

  const fetchItems = () => {
    setLoading(true);
    fetch("/api/decisions")
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchItems(); }, []);

  if (loading) return <div className="tab-loading">Loading decisions...</div>;
  if (items.length === 0) return <div className="tab-empty">No pending decisions.</div>;

  return (
    <div className="tab-list-container">
      <div className="tab-list-header">
        <h2>⚖️ Decisions ({items.length})</h2>
        <button className="btn btn-small" onClick={fetchItems}>↻ Refresh</button>
      </div>
      <ul className="tab-list">
        {items.map((item) => (
          <li key={item.number} className="tab-list-item">
            <div className="tab-list-item-header">
              {repoUrl ? (
                <a href={`${repoUrl}/issues/${item.number}`} target="_blank" rel="noopener" className="item-number">#{item.number}</a>
              ) : (
                <span className="item-number">#{item.number}</span>
              )}
              <span className="item-title">{item.title}</span>
              <div className="decision-actions">
                <button
                  className="btn btn-small btn-success"
                  onClick={() => send({ type: "decisions:approve", issueNumber: item.number })}
                >
                  ✅ Approve
                </button>
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => send({ type: "decisions:reject", issueNumber: item.number })}
                >
                  ❌ Reject
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => {
                    const msg = prompt("Comment:");
                    if (msg) send({ type: "decisions:comment", issueNumber: item.number, body: msg });
                  }}
                >
                  💬
                </button>
              </div>
            </div>
            {item.body && <div className="item-body">{item.body.slice(0, 500)}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IdeasTab() {
  const [items, setItems] = useState<GhIssueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const repoUrl = useDashboardStore((s) => s.repoUrl);

  const fetchItems = () => {
    setLoading(true);
    fetch("/api/ideas")
      .then((r) => r.json())
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchItems(); }, []);

  if (loading) return <div className="tab-loading">Loading ideas...</div>;
  if (items.length === 0) return <div className="tab-empty">No ideas yet.</div>;

  return (
    <div className="tab-list-container">
      <div className="tab-list-header">
        <h2>💡 Ideas ({items.length})</h2>
        <button className="btn btn-small" onClick={fetchItems}>↻ Refresh</button>
      </div>
      <ul className="tab-list">
        {items.map((item) => (
          <li key={item.number} className="tab-list-item">
            <div className="tab-list-item-header">
              {repoUrl ? (
                <a href={`${repoUrl}/issues/${item.number}`} target="_blank" rel="noopener" className="item-number">#{item.number}</a>
              ) : (
                <span className="item-number">#{item.number}</span>
              )}
              <span className="item-title">{item.title}</span>
            </div>
            {item.body && <div className="item-body">{item.body.slice(0, 300)}</div>}
            {item.labels && item.labels.length > 0 && (
              <div className="item-labels">
                {item.labels.map((l) => <span key={l} className="label-badge">{l}</span>)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
