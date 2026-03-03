import { useEffect, useState, useCallback } from "react";
import { useDashboardStore } from "../store";
import "./SprintReport.css";

interface QualityCheck {
  name: string;
  passed: boolean;
  details?: string;
}

interface IssueResult {
  issueNumber: number;
  status: string;
  qualityGatePassed?: boolean;
  qualityDetails?: { checks?: QualityCheck[] };
  codeReview?: { approved?: boolean; feedback?: string };
  branch?: string;
  duration_ms?: number;
  filesChanged?: string[];
  retryCount?: number;
  points?: number;
}

interface SprintPlan {
  sprintNumber: number;
  sprint_issues: Array<{ number: number; title: string; ice_score?: number; points?: number }>;
  rationale?: string;
}

interface ReviewResult {
  summary?: string;
  demoItems?: string[];
  velocityUpdate?: string;
  openItems?: string[];
}

interface RetroResult {
  wentWell?: string[];
  wentBadly?: string[];
  improvements?: Array<{ title: string; description?: string }>;
}

interface SprintStateData {
  sprintNumber: number;
  phase: string;
  startedAt?: string;
  plan?: SprintPlan;
  result?: { results: IssueResult[]; parallelizationRatio?: number; mergeConflicts?: number };
  review?: ReviewResult;
  retro?: RetroResult;
  error?: string;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function Section({
  icon,
  title,
  children,
  defaultOpen = false,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="report-section">
      <div className="report-section-header" onClick={() => setOpen(!open)}>
        <span className={`chevron ${open ? "open" : ""}`}>▶</span>
        <span>{icon}</span>
        <span>{title}</span>
      </div>
      {open && <div className="report-section-body">{children}</div>}
    </div>
  );
}

function generateMarkdown(data: SprintStateData): string {
  const lines: string[] = [];
  lines.push(`# Sprint ${data.sprintNumber} Report`);
  lines.push("");

  if (data.startedAt) {
    lines.push(`**Date:** ${new Date(data.startedAt).toLocaleDateString()}`);
  }
  lines.push(`**Phase:** ${data.phase}`);
  lines.push("");

  // Summary
  const results = data.result?.results ?? [];
  const completed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalDuration = results.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
  const firstPass = results.filter((r) => r.qualityGatePassed && (r.retryCount ?? 0) === 0).length;

  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Planned | ${data.plan?.sprint_issues?.length ?? 0} |`);
  lines.push(`| Completed | ${completed} |`);
  lines.push(`| Failed | ${failed} |`);
  lines.push(`| Total Duration | ${formatDuration(totalDuration)} |`);
  lines.push(`| First-pass Rate | ${results.length > 0 ? Math.round((firstPass / results.length) * 100) : 0}% |`);
  lines.push("");

  // Issue results
  if (results.length > 0) {
    lines.push("## Issue Results");
    lines.push("");
    lines.push(`| Issue | Status | Quality | Duration | Files |`);
    lines.push(`|-------|--------|---------|----------|-------|`);
    for (const r of results) {
      const status = r.status === "completed" ? "✅" : "❌";
      const quality = r.qualityGatePassed ? "Pass" : "Fail";
      const duration = r.duration_ms ? formatDuration(r.duration_ms) : "—";
      const files = r.filesChanged?.length ?? 0;
      lines.push(`| #${r.issueNumber} | ${status} ${r.status} | ${quality} | ${duration} | ${files} |`);
    }
    lines.push("");
  }

  // Review
  if (data.review) {
    lines.push("## Review");
    lines.push("");
    if (data.review.summary) lines.push(data.review.summary);
    if (data.review.demoItems?.length) {
      lines.push("");
      lines.push("### Demo Items");
      for (const item of data.review.demoItems) lines.push(`- ${item}`);
    }
    if (data.review.openItems?.length) {
      lines.push("");
      lines.push("### Open Items");
      for (const item of data.review.openItems) lines.push(`- ${item}`);
    }
    lines.push("");
  }

  // Retro
  if (data.retro) {
    lines.push("## Retrospective");
    lines.push("");
    if (data.retro.wentWell?.length) {
      lines.push("### What Went Well");
      for (const item of data.retro.wentWell) lines.push(`- ${item}`);
      lines.push("");
    }
    if (data.retro.wentBadly?.length) {
      lines.push("### What Could Improve");
      for (const item of data.retro.wentBadly) lines.push(`- ${item}`);
      lines.push("");
    }
    if (data.retro.improvements?.length) {
      lines.push("### Improvements");
      for (const imp of data.retro.improvements) {
        lines.push(`- **${imp.title}**: ${imp.description ?? ""}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function SprintReport() {
  const viewingSprintNumber = useDashboardStore((s) => s.viewingSprintNumber);
  const availableSprints = useDashboardStore((s) => s.availableSprints);
  const [sprintNum, setSprintNum] = useState(viewingSprintNumber || 1);
  const [data, setData] = useState<SprintStateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (viewingSprintNumber > 0) setSprintNum(viewingSprintNumber);
  }, [viewingSprintNumber]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/sprints/${sprintNum}/state`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => setData(d as SprintStateData))
      .catch((e) => { if (e.name !== "AbortError") setData(null); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sprintNum]);

  const copyMarkdown = useCallback(() => {
    if (!data) return;
    navigator.clipboard.writeText(generateMarkdown(data)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [data]);

  const downloadMarkdown = useCallback(() => {
    if (!data) return;
    const md = generateMarkdown(data);
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sprint-${data.sprintNumber}-report.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [data]);

  if (loading) return <div className="report-loading">Loading sprint report…</div>;

  const results = data?.result?.results ?? [];
  const planned = data?.plan?.sprint_issues ?? [];
  const completed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalDuration = results.reduce((sum, r) => sum + (r.duration_ms ?? 0), 0);
  const firstPass = results.filter((r) => r.qualityGatePassed && (r.retryCount ?? 0) === 0).length;
  const firstPassRate = results.length > 0 ? Math.round((firstPass / results.length) * 100) : 0;

  return (
    <div className="sprint-report">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <h1>📋 Sprint Report</h1>
        <select
          className="report-sprint-select"
          value={sprintNum}
          onChange={(e) => setSprintNum(parseInt(e.target.value, 10))}
        >
          {availableSprints.length > 0 ? (
            availableSprints.map((s) => (
              <option key={s.sprintNumber} value={s.sprintNumber}>
                Sprint {s.sprintNumber}
              </option>
            ))
          ) : (
            <option value={sprintNum}>Sprint {sprintNum}</option>
          )}
        </select>
      </div>

      {data?.startedAt && (
        <div className="report-subtitle">
          Started {new Date(data.startedAt).toLocaleString()} · Phase: {data.phase?.toUpperCase()}
          {data.error && <> · ⚠️ {data.error}</>}
        </div>
      )}

      {results.length === 0 && planned.length === 0 ? (
        <div className="report-empty">
          No data available for Sprint {sprintNum}.<br />
          The sprint may not have been executed yet.
        </div>
      ) : (
        <>
          <div className="report-actions">
            <button className="btn btn-small" onClick={copyMarkdown} disabled={!data}>{copied ? "✅ Copied!" : "📋 Copy Markdown"}</button>
            <button className="btn btn-small" onClick={downloadMarkdown} disabled={!data}>⬇ Download .md</button>
          </div>

          <div className="report-summary">
            <div className="summary-card">
              <div className="value">{planned.length}</div>
              <div className="label">Planned</div>
            </div>
            <div className="summary-card success">
              <div className="value">{completed}</div>
              <div className="label">Completed</div>
            </div>
            {failed > 0 && (
              <div className="summary-card danger">
                <div className="value">{failed}</div>
                <div className="label">Failed</div>
              </div>
            )}
            <div className="summary-card info">
              <div className="value">{firstPassRate}%</div>
              <div className="label">First-pass</div>
            </div>
            <div className="summary-card">
              <div className="value">{totalDuration > 0 ? formatDuration(totalDuration) : "—"}</div>
              <div className="label">Total Duration</div>
            </div>
            {data?.result?.mergeConflicts != null && data.result.mergeConflicts > 0 && (
              <div className="summary-card danger">
                <div className="value">{data.result.mergeConflicts}</div>
                <div className="label">Merge Conflicts</div>
              </div>
            )}
          </div>

          {results.length > 0 && (
            <Section icon="📋" title={`Issue Results (${results.length})`} defaultOpen={true}>
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Issue</th>
                    <th>Status</th>
                    <th>Quality</th>
                    <th>Duration</th>
                    <th>Files</th>
                    <th>Retries</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.issueNumber}>
                      <td><strong>#{r.issueNumber}</strong></td>
                      <td>{r.status === "completed" ? "✅" : "❌"} {r.status}</td>
                      <td>
                        {r.qualityDetails?.checks ? (
                          <div className="quality-checks">
                            {r.qualityDetails.checks.map((c, i) => (
                              <span key={i} className={`quality-check ${c.passed ? "pass" : "fail"}`}>
                                {c.passed ? "✓" : "✗"} {c.name}
                              </span>
                            ))}
                          </div>
                        ) : (
                          r.qualityGatePassed ? "✅ Pass" : "❌ Fail"
                        )}
                      </td>
                      <td className="duration-cell">
                        {r.duration_ms ? formatDuration(r.duration_ms) : "—"}
                      </td>
                      <td>{r.filesChanged?.length ?? 0}</td>
                      <td>{r.retryCount ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {data?.plan?.rationale && (
            <Section icon="🎯" title="Planning Rationale">
              <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5, margin: 0 }}>
                {data.plan.rationale}
              </p>
            </Section>
          )}

          {data?.review && (
            <Section icon="🔍" title="Review" defaultOpen={true}>
              {data.review.summary && (
                <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.5, marginBottom: 12 }}>
                  {data.review.summary}
                </p>
              )}
              {data.review.demoItems && data.review.demoItems.length > 0 && (
                <>
                  <strong style={{ fontSize: 12, color: "var(--text-dim)" }}>Demo Items</strong>
                  <ul className="retro-list" style={{ marginBottom: 12 }}>
                    {data.review.demoItems.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </>
              )}
              {data.review.velocityUpdate && (
                <p style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 8 }}>
                  📈 {data.review.velocityUpdate}
                </p>
              )}
              {data.review.openItems && data.review.openItems.length > 0 && (
                <>
                  <strong style={{ fontSize: 12, color: "var(--text-dim)" }}>Open Items</strong>
                  <ul className="retro-list">
                    {data.review.openItems.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </>
              )}
            </Section>
          )}

          {data?.retro && (
            <Section icon="🔄" title="Retrospective" defaultOpen={true}>
              {data.retro.wentWell && data.retro.wentWell.length > 0 && (
                <>
                  <strong style={{ fontSize: 12, color: "var(--text-dim)" }}>What Went Well</strong>
                  <ul className="retro-list well">
                    {data.retro.wentWell.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </>
              )}
              {data.retro.wentBadly && data.retro.wentBadly.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <strong style={{ fontSize: 12, color: "var(--text-dim)" }}>What Could Improve</strong>
                  <ul className="retro-list bad">
                    {data.retro.wentBadly.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}
              {data.retro.improvements && data.retro.improvements.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <strong style={{ fontSize: 12, color: "var(--text-dim)" }}>Improvements</strong>
                  <ul className="retro-list improve">
                    {data.retro.improvements.map((imp, i) => (
                      <li key={i}><strong>{imp.title}</strong>{imp.description ? `: ${imp.description}` : ""}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          )}
        </>
      )}

    </div>
  );
}
