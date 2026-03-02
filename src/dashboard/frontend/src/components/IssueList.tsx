import { useDashboardStore } from "../store";
import "./IssueList.css";

const STATUS_ICON: Record<string, string> = {
  planned: "○",
  "in-progress": "◐",
  "status:in-progress": "◐",
  completed: "✓",
  done: "✓",
  "status:done": "✓",
  failed: "✗",
  blocked: "⊘",
};

const STEP_LABELS: Record<string, string> = {
  "creating worktree": "🌲",
  plan: "📋",
  tdd: "🧪",
  implement: "🔨",
  "quality gate": "🔍",
  "code review": "👁",
  "acceptance review": "✅",
  merge: "🔀",
};

export function IssueList() {
  const issues = useDashboardStore((s) => s.issues);
  const repoUrl = useDashboardStore((s) => s.repoUrl);

  if (issues.length === 0) {
    return <div className="empty-state">No issues in this sprint yet.</div>;
  }

  return (
    <ul id="issue-list" className="issue-list">
      {issues.map((issue) => {
        const icon = STATUS_ICON[issue.status] ?? "·";
        const statusClass = issue.status.replace("status:", "");
        const link = repoUrl ? (
          <a href={`${repoUrl}/issues/${issue.number}`} target="_blank" rel="noopener" className="issue-number">
            #{issue.number}
          </a>
        ) : (
          <span className="issue-number">#{issue.number}</span>
        );

        return (
          <li key={issue.number} className={`issue-item issue-${statusClass}`}>
            <span className="issue-icon">{icon}</span>
            {link}
            <span className="issue-title">{issue.title}</span>
            {issue.step && (
              <span className="issue-step" title={issue.step}>
                {STEP_LABELS[issue.step] ?? "⏳"}
              </span>
            )}
            {issue.failReason && (
              <span className="issue-fail" title={issue.failReason}>⚠</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
