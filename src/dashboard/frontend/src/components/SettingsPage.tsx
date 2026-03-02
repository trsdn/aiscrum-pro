import { useEffect, useState } from "react";
import "./SettingsPage.css";

interface McpServer {
  type: string;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
}

interface Config {
  project: { name: string; base_branch: string };
  copilot: {
    executable: string;
    max_parallel_sessions: number;
    session_timeout_ms: number;
    auto_approve_tools: boolean;
    allow_tool_patterns: string[];
    mcp_servers: McpServer[];
    instructions: string[];
    phases: Record<string, { model?: string; mcp_servers?: McpServer[]; instructions?: string[] }>;
  };
  sprint: {
    prefix: string;
    max_issues: number;
    max_issues_created_per_sprint: number;
    max_sprints: number;
    max_drift_incidents: number;
    max_retries: number;
    enable_challenger: boolean;
    enable_tdd: boolean;
    auto_revert_drift: boolean;
    backlog_labels: string[];
  };
  quality_gates: {
    require_tests: boolean;
    require_lint: boolean;
    require_types: boolean;
    require_build: boolean;
    max_diff_lines: number;
    test_command: string | string[];
    lint_command: string | string[];
    typecheck_command: string | string[];
    build_command: string | string[];
    require_challenger: boolean;
  };
  escalation: { notifications: { ntfy: boolean; ntfy_topic: string; ntfy_server_url: string } };
  git: {
    worktree_base: string;
    branch_pattern: string;
    auto_merge: boolean;
    squash_merge: boolean;
    delete_branch_after_merge: boolean;
  };
}

function BoolBadge({ value }: { value: boolean }) {
  return (
    <span className={`settings-badge ${value ? "on" : "off"}`}>
      {value ? "Enabled" : "Disabled"}
    </span>
  );
}

function cmdStr(cmd: string | string[]): string {
  return Array.isArray(cmd) ? cmd.join(" ") : cmd;
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
    <div className="settings-section">
      <div className="settings-section-header" onClick={() => setOpen(!open)}>
        <span className={`chevron ${open ? "open" : ""}`}>▶</span>
        <span>{icon}</span>
        <span>{title}</span>
      </div>
      {open && <div className="settings-section-body">{children}</div>}
    </div>
  );
}

export function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setConfig(data as Config))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="settings-loading">❌ Failed to load config: {error}</div>;
  if (!config) return <div className="settings-loading">Loading configuration…</div>;

  return (
    <div className="settings-page">
      <h1>⚙️ Settings</h1>

      <Section icon="📁" title="Project" defaultOpen={true}>
        <table className="settings-table">
          <tbody>
            <tr><td>Name</td><td>{config.project.name}</td></tr>
            <tr><td>Base Branch</td><td><code>{config.project.base_branch}</code></td></tr>
          </tbody>
        </table>
      </Section>

      <Section icon="🤖" title="Copilot" defaultOpen={true}>
        <table className="settings-table">
          <tbody>
            <tr><td>Executable</td><td><code>{config.copilot.executable}</code></td></tr>
            <tr><td>Max Parallel Sessions</td><td>{config.copilot.max_parallel_sessions}</td></tr>
            <tr><td>Session Timeout</td><td>{Math.round(config.copilot.session_timeout_ms / 1000)}s</td></tr>
            <tr><td>Auto-approve Tools</td><td><BoolBadge value={config.copilot.auto_approve_tools} /></td></tr>
            {config.copilot.allow_tool_patterns.length > 0 && (
              <tr>
                <td>Tool Patterns</td>
                <td>
                  <ul className="settings-list">
                    {config.copilot.allow_tool_patterns.map((p, i) => <li key={i}><code>{p}</code></li>)}
                  </ul>
                </td>
              </tr>
            )}
            {config.copilot.instructions.length > 0 && (
              <tr>
                <td>Instructions</td>
                <td>
                  <ul className="settings-list">
                    {config.copilot.instructions.map((inst, i) => <li key={i}>{inst}</li>)}
                  </ul>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section icon="🏃" title="Sprint">
        <table className="settings-table">
          <tbody>
            <tr><td>Prefix</td><td>{config.sprint.prefix}</td></tr>
            <tr><td>Max Issues per Sprint</td><td>{config.sprint.max_issues}</td></tr>
            <tr><td>Max Issues Created</td><td>{config.sprint.max_issues_created_per_sprint}</td></tr>
            <tr><td>Max Sprints</td><td>{config.sprint.max_sprints === 0 ? "∞ (unlimited)" : config.sprint.max_sprints}</td></tr>
            <tr><td>Max Drift Incidents</td><td>{config.sprint.max_drift_incidents}</td></tr>
            <tr><td>Max Retries</td><td>{config.sprint.max_retries}</td></tr>
            <tr><td>Challenger</td><td><BoolBadge value={config.sprint.enable_challenger} /></td></tr>
            <tr><td>TDD</td><td><BoolBadge value={config.sprint.enable_tdd} /></td></tr>
            <tr><td>Auto-revert Drift</td><td><BoolBadge value={config.sprint.auto_revert_drift} /></td></tr>
            {config.sprint.backlog_labels.length > 0 && (
              <tr>
                <td>Backlog Labels</td>
                <td>
                  <ul className="settings-list">
                    {config.sprint.backlog_labels.map((l, i) => <li key={i}><code>{l}</code></li>)}
                  </ul>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Section>

      <Section icon="🛡️" title="Quality Gates">
        <table className="settings-table">
          <tbody>
            <tr><td>Tests</td><td><BoolBadge value={config.quality_gates.require_tests} /></td></tr>
            <tr><td>Test Command</td><td><code>{cmdStr(config.quality_gates.test_command)}</code></td></tr>
            <tr><td>Lint</td><td><BoolBadge value={config.quality_gates.require_lint} /></td></tr>
            <tr><td>Lint Command</td><td><code>{cmdStr(config.quality_gates.lint_command)}</code></td></tr>
            <tr><td>Type Check</td><td><BoolBadge value={config.quality_gates.require_types} /></td></tr>
            <tr><td>Type Command</td><td><code>{cmdStr(config.quality_gates.typecheck_command)}</code></td></tr>
            <tr><td>Build</td><td><BoolBadge value={config.quality_gates.require_build} /></td></tr>
            <tr><td>Build Command</td><td><code>{cmdStr(config.quality_gates.build_command)}</code></td></tr>
            <tr><td>Max Diff Lines</td><td>{config.quality_gates.max_diff_lines}</td></tr>
            <tr><td>Challenger</td><td><BoolBadge value={config.quality_gates.require_challenger} /></td></tr>
          </tbody>
        </table>
      </Section>

      {config.copilot.mcp_servers.length > 0 && (
        <Section icon="🔌" title={`MCP Servers (${config.copilot.mcp_servers.length})`}>
          {config.copilot.mcp_servers.map((srv, i) => (
            <div className="settings-mcp-card" key={i}>
              <div className="settings-mcp-name">{srv.name}</div>
              <div className="settings-mcp-detail">
                Type: <code>{srv.type}</code>
                {srv.command && <> · Command: <code>{srv.command} {srv.args?.join(" ")}</code></>}
                {srv.url && <> · URL: <code>{srv.url}</code></>}
              </div>
            </div>
          ))}
        </Section>
      )}

      {Object.keys(config.copilot.phases).length > 0 && (
        <Section icon="🔄" title="Phase Overrides">
          {Object.entries(config.copilot.phases).map(([phase, cfg]) => (
            <div className="settings-mcp-card" key={phase}>
              <div className="settings-mcp-name">{phase}</div>
              <table className="settings-table">
                <tbody>
                  {cfg.model && <tr><td>Model</td><td><code>{cfg.model}</code></td></tr>}
                  {cfg.mcp_servers && cfg.mcp_servers.length > 0 && (
                    <tr><td>MCP Servers</td><td>{cfg.mcp_servers.map((s) => s.name).join(", ")}</td></tr>
                  )}
                  {cfg.instructions && cfg.instructions.length > 0 && (
                    <tr><td>Instructions</td><td>{cfg.instructions.length} custom</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </Section>
      )}

      <Section icon="🔔" title="Notifications">
        <table className="settings-table">
          <tbody>
            <tr><td>ntfy</td><td><BoolBadge value={config.escalation.notifications.ntfy} /></td></tr>
            {config.escalation.notifications.ntfy && (
              <>
                <tr><td>Topic</td><td><code>{config.escalation.notifications.ntfy_topic}</code></td></tr>
                <tr><td>Server</td><td><code>{config.escalation.notifications.ntfy_server_url}</code></td></tr>
              </>
            )}
          </tbody>
        </table>
      </Section>

      <Section icon="🔀" title="Git">
        <table className="settings-table">
          <tbody>
            <tr><td>Worktree Base</td><td><code>{config.git.worktree_base}</code></td></tr>
            <tr><td>Branch Pattern</td><td><code>{config.git.branch_pattern}</code></td></tr>
            <tr><td>Auto Merge</td><td><BoolBadge value={config.git.auto_merge} /></td></tr>
            <tr><td>Squash Merge</td><td><BoolBadge value={config.git.squash_merge} /></td></tr>
            <tr><td>Delete Branch After Merge</td><td><BoolBadge value={config.git.delete_branch_after_merge} /></td></tr>
          </tbody>
        </table>
      </Section>
    </div>
  );
}
