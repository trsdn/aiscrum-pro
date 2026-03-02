import { useEffect, useState, useCallback } from "react";
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

// --- Reusable field components ---

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <span
      className={`settings-badge settings-toggle ${value ? "on" : "off"}`}
      onClick={() => onChange(!value)}
    >
      {value ? "✓ Enabled" : "✗ Disabled"}
    </span>
  );
}

function NumInput({ value, onChange, min, max, narrow }: { value: number; onChange: (v: number) => void; min?: number; max?: number; narrow?: boolean }) {
  return (
    <input
      type="number"
      className={`settings-input ${narrow ? "settings-input-narrow" : ""}`}
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(parseInt(e.target.value, 10) || 0)}
    />
  );
}

function TextInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      className="settings-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
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

/** Row with label, editable value, and description */
function Row({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{children}</td>
      <td>{desc}</td>
    </tr>
  );
}

export function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [savedConfig, setSavedConfig] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        setConfig(data as Config);
        setSavedConfig(JSON.stringify(data));
      })
      .catch((e) => setError(String(e)));
  }, []);

  const isDirty = config ? JSON.stringify(config) !== savedConfig : false;

  const save = useCallback(async () => {
    if (!config) return;
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        setSavedConfig(JSON.stringify(config));
        setToast({ msg: "✅ Settings saved", type: "success" });
      } else {
        const data = await res.json();
        setToast({ msg: `❌ ${data.error ?? "Save failed"}`, type: "error" });
      }
    } catch (e) {
      setToast({ msg: `❌ ${String(e)}`, type: "error" });
    }
    setTimeout(() => setToast(null), 2500);
  }, [config]);

  const reset = useCallback(() => {
    if (savedConfig) setConfig(JSON.parse(savedConfig));
  }, [savedConfig]);

  // Updater helpers
  const up = useCallback(<K extends keyof Config>(section: K, patch: Partial<Config[K]>) => {
    setConfig((prev) => prev ? { ...prev, [section]: { ...prev[section], ...patch } } : prev);
  }, []);

  const upQg = useCallback((patch: Partial<Config["quality_gates"]>) => up("quality_gates", patch), [up]);
  const upSprint = useCallback((patch: Partial<Config["sprint"]>) => up("sprint", patch), [up]);
  const upCopilot = useCallback((patch: Partial<Config["copilot"]>) => up("copilot", patch), [up]);
  const upGit = useCallback((patch: Partial<Config["git"]>) => up("git", patch), [up]);
  const upNotif = useCallback((patch: Partial<Config["escalation"]["notifications"]>) => {
    setConfig((prev) => prev ? { ...prev, escalation: { ...prev.escalation, notifications: { ...prev.escalation.notifications, ...patch } } } : prev);
  }, []);

  if (error) return <div className="settings-loading">❌ Failed to load config: {error}</div>;
  if (!config) return <div className="settings-loading">Loading configuration…</div>;

  return (
    <div className="settings-page">
      <h1>⚙️ Settings</h1>

      <div className="settings-actions">
        <button className="btn btn-primary btn-small" onClick={save} disabled={!isDirty}>
          💾 Save
        </button>
        <button className="btn btn-small" onClick={reset} disabled={!isDirty}>
          ↩ Reset
        </button>
        {isDirty && <span className="settings-dirty">● Unsaved changes</span>}
      </div>

      <Section icon="📁" title="Project" defaultOpen={true}>
        <table className="settings-table">
          <tbody>
            <Row label="Name" desc="Display name for this project">
              <TextInput value={config.project.name} onChange={(v) => up("project", { name: v })} />
            </Row>
            <Row label="Base Branch" desc="Main branch to merge PRs into (e.g. main, develop)">
              <TextInput value={config.project.base_branch} onChange={(v) => up("project", { base_branch: v })} />
            </Row>
          </tbody>
        </table>
      </Section>

      <Section icon="🤖" title="Copilot" defaultOpen={true}>
        <table className="settings-table">
          <tbody>
            <Row label="Executable" desc="Path to the Copilot CLI binary">
              <TextInput value={config.copilot.executable} onChange={(v) => upCopilot({ executable: v })} />
            </Row>
            <Row label="Max Parallel Sessions" desc="How many ACP sessions can run simultaneously (1-20)">
              <NumInput value={config.copilot.max_parallel_sessions} onChange={(v) => upCopilot({ max_parallel_sessions: v })} min={1} max={20} narrow />
            </Row>
            <Row label="Session Timeout" desc="Max time (seconds) before an idle session is killed">
              <NumInput value={Math.round(config.copilot.session_timeout_ms / 1000)} onChange={(v) => upCopilot({ session_timeout_ms: v * 1000 })} min={0} narrow />
            </Row>
            <Row label="Auto-approve Tools" desc="Automatically approve tool calls without human confirmation">
              <Toggle value={config.copilot.auto_approve_tools} onChange={(v) => upCopilot({ auto_approve_tools: v })} />
            </Row>
          </tbody>
        </table>
        {config.copilot.instructions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Instructions ({config.copilot.instructions.length})</span>
            <ul className="settings-list">
              {config.copilot.instructions.map((inst, i) => <li key={i}>{inst}</li>)}
            </ul>
          </div>
        )}
      </Section>

      <Section icon="🏃" title="Sprint">
        <table className="settings-table">
          <tbody>
            <Row label="Prefix" desc="Milestone title prefix for sprint naming (e.g. 'Sprint' → 'Sprint 1')">
              <TextInput value={config.sprint.prefix} onChange={(v) => upSprint({ prefix: v })} />
            </Row>
            <Row label="Max Issues" desc="Maximum issues to plan per sprint">
              <NumInput value={config.sprint.max_issues} onChange={(v) => upSprint({ max_issues: v })} min={1} narrow />
            </Row>
            <Row label="Max Issues Created" desc="Max issues the agent can auto-create per sprint">
              <NumInput value={config.sprint.max_issues_created_per_sprint} onChange={(v) => upSprint({ max_issues_created_per_sprint: v })} min={1} narrow />
            </Row>
            <Row label="Max Sprints" desc="Number of sprints to run in a loop (0 = unlimited)">
              <NumInput value={config.sprint.max_sprints} onChange={(v) => upSprint({ max_sprints: v })} min={0} narrow />
            </Row>
            <Row label="Max Drift Incidents" desc="How many unplanned issues before escalation">
              <NumInput value={config.sprint.max_drift_incidents} onChange={(v) => upSprint({ max_drift_incidents: v })} min={0} narrow />
            </Row>
            <Row label="Max Retries" desc="Retry attempts for a failed issue before giving up">
              <NumInput value={config.sprint.max_retries} onChange={(v) => upSprint({ max_retries: v })} min={0} narrow />
            </Row>
            <Row label="Challenger" desc="Run adversarial review agent to challenge sprint decisions">
              <Toggle value={config.sprint.enable_challenger} onChange={(v) => upSprint({ enable_challenger: v })} />
            </Row>
            <Row label="TDD" desc="Require test-driven development workflow for all issues">
              <Toggle value={config.sprint.enable_tdd} onChange={(v) => upSprint({ enable_tdd: v })} />
            </Row>
            <Row label="Auto-revert Drift" desc="Automatically revert changes that cause sprint scope drift">
              <Toggle value={config.sprint.auto_revert_drift} onChange={(v) => upSprint({ auto_revert_drift: v })} />
            </Row>
          </tbody>
        </table>
      </Section>

      <Section icon="🛡️" title="Quality Gates">
        <table className="settings-table">
          <tbody>
            <Row label="Tests" desc="Require tests to pass before merging">
              <Toggle value={config.quality_gates.require_tests} onChange={(v) => upQg({ require_tests: v })} />
            </Row>
            <Row label="Test Command" desc="Command to run tests">
              <TextInput value={cmdStr(config.quality_gates.test_command)} onChange={(v) => upQg({ test_command: v })} />
            </Row>
            <Row label="Lint" desc="Require linter to pass before merging">
              <Toggle value={config.quality_gates.require_lint} onChange={(v) => upQg({ require_lint: v })} />
            </Row>
            <Row label="Lint Command" desc="Command to run linter">
              <TextInput value={cmdStr(config.quality_gates.lint_command)} onChange={(v) => upQg({ lint_command: v })} />
            </Row>
            <Row label="Type Check" desc="Require type checking to pass before merging">
              <Toggle value={config.quality_gates.require_types} onChange={(v) => upQg({ require_types: v })} />
            </Row>
            <Row label="Type Command" desc="Command to run type checker">
              <TextInput value={cmdStr(config.quality_gates.typecheck_command)} onChange={(v) => upQg({ typecheck_command: v })} />
            </Row>
            <Row label="Build" desc="Require build to succeed before merging">
              <Toggle value={config.quality_gates.require_build} onChange={(v) => upQg({ require_build: v })} />
            </Row>
            <Row label="Build Command" desc="Command to build the project">
              <TextInput value={cmdStr(config.quality_gates.build_command)} onChange={(v) => upQg({ build_command: v })} />
            </Row>
            <Row label="Max Diff Lines" desc="Maximum lines changed per PR (exceeding triggers review)">
              <NumInput value={config.quality_gates.max_diff_lines} onChange={(v) => upQg({ max_diff_lines: v })} min={1} narrow />
            </Row>
            <Row label="Challenger" desc="Require adversarial code review on every PR">
              <Toggle value={config.quality_gates.require_challenger} onChange={(v) => upQg({ require_challenger: v })} />
            </Row>
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
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            MCP servers connect external tools to Copilot sessions. Edit in <code>.aiscrum/config.yaml</code>.
          </div>
        </Section>
      )}

      {Object.keys(config.copilot.phases).length > 0 && (
        <Section icon="🔄" title="Phase Overrides">
          {Object.entries(config.copilot.phases).map(([phase, cfg]) => (
            <div className="settings-mcp-card" key={phase}>
              <div className="settings-mcp-name">{phase}</div>
              <table className="settings-table">
                <tbody>
                  {cfg.model && <tr><td>Model</td><td><code>{cfg.model}</code></td><td>AI model for this phase</td></tr>}
                  {cfg.mcp_servers && cfg.mcp_servers.length > 0 && (
                    <tr><td>MCP Servers</td><td>{cfg.mcp_servers.map((s) => s.name).join(", ")}</td><td>Additional servers for this phase</td></tr>
                  )}
                  {cfg.instructions && cfg.instructions.length > 0 && (
                    <tr><td>Instructions</td><td>{cfg.instructions.length} custom</td><td>Extra instructions appended for this phase</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            Override model, MCP servers, or instructions per sprint phase. Edit in <code>.aiscrum/config.yaml</code>.
          </div>
        </Section>
      )}

      <Section icon="🔔" title="Notifications">
        <table className="settings-table">
          <tbody>
            <Row label="ntfy" desc="Send push notifications via ntfy.sh when events occur">
              <Toggle value={config.escalation.notifications.ntfy} onChange={(v) => upNotif({ ntfy: v })} />
            </Row>
            <Row label="Topic" desc="ntfy topic name for push notifications">
              <TextInput value={config.escalation.notifications.ntfy_topic} onChange={(v) => upNotif({ ntfy_topic: v })} />
            </Row>
            <Row label="Server" desc="ntfy server URL (default: https://ntfy.sh)">
              <TextInput value={config.escalation.notifications.ntfy_server_url} onChange={(v) => upNotif({ ntfy_server_url: v })} />
            </Row>
          </tbody>
        </table>
      </Section>

      <Section icon="🔀" title="Git">
        <table className="settings-table">
          <tbody>
            <Row label="Worktree Base" desc="Directory where git worktrees are created for parallel work">
              <TextInput value={config.git.worktree_base} onChange={(v) => upGit({ worktree_base: v })} />
            </Row>
            <Row label="Branch Pattern" desc="Pattern for feature branches. Placeholders: {prefix}, {sprint}, {issue}">
              <TextInput value={config.git.branch_pattern} onChange={(v) => upGit({ branch_pattern: v })} />
            </Row>
            <Row label="Auto Merge" desc="Automatically merge PRs when all quality gates pass">
              <Toggle value={config.git.auto_merge} onChange={(v) => upGit({ auto_merge: v })} />
            </Row>
            <Row label="Squash Merge" desc="Use squash merge instead of regular merge commits">
              <Toggle value={config.git.squash_merge} onChange={(v) => upGit({ squash_merge: v })} />
            </Row>
            <Row label="Delete Branch" desc="Delete feature branch after successful merge">
              <Toggle value={config.git.delete_branch_after_merge} onChange={(v) => upGit({ delete_branch_after_merge: v })} />
            </Row>
          </tbody>
        </table>
      </Section>

      {toast && <div className={`settings-toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
