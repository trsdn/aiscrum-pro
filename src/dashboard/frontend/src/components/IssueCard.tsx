import { useState } from "react";
import type { GhIssueItem } from "../types";
import { useDashboardStore } from "../store";
import { Markdown } from "./Markdown";

interface IssueCardProps {
  item: GhIssueItem;
  actions?: React.ReactNode;
  /** Content shown only when expanded (below body) */
  extraContent?: React.ReactNode;
}

export function IssueCard({ item, actions, extraContent }: IssueCardProps) {
  const [expanded, setExpanded] = useState(false);
  const repoUrl = useDashboardStore((s) => s.repoUrl);

  return (
    <li className={`tab-list-item${expanded ? " item-expanded" : ""}`}>
      <div className="tab-list-item-header">
        <button
          className="item-expand-toggle"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        {repoUrl ? (
          <a
            href={`${repoUrl}/issues/${item.number}`}
            target="_blank"
            rel="noopener"
            className="item-number"
            onClick={(e) => e.stopPropagation()}
          >
            #{item.number}
          </a>
        ) : (
          <span className="item-number">#{item.number}</span>
        )}
        <span
          className="item-title item-title-clickable"
          onClick={() => setExpanded(!expanded)}
        >
          {item.title}
        </span>
        {actions && <div className="item-actions">{actions}</div>}
      </div>
      {!expanded && item.labels && item.labels.length > 0 && (
        <div className="item-labels">
          {item.labels.map((l) => <span key={l} className="label-badge">{l}</span>)}
        </div>
      )}
      {expanded && (
        <div className="item-detail">
          {item.labels && item.labels.length > 0 && (
            <div className="item-labels">
              {item.labels.map((l) => <span key={l} className="label-badge">{l}</span>)}
            </div>
          )}
          {item.body ? (
            <div className="item-body-full"><Markdown text={item.body} /></div>
          ) : (
            <div className="item-body-empty">No description.</div>
          )}
          {item.blockedReason && (
            <div className="item-blocked-reason">
              <strong>⛔ Reason:</strong> {item.blockedReason}
            </div>
          )}
          {extraContent}
        </div>
      )}
    </li>
  );
}
