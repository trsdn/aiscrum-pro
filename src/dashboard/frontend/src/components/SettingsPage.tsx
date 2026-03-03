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
    min_issues: number;
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

function cmdArr(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
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

interface AgentRole {
  name: string;
  instructions: string;
  prompts: Record<string, string>;
  model?: string;
  mode?: string;
}

interface QualityGates {
  checks: {
    tests: { enabled: boolean; command?: string | string[] };
    lint: { enabled: boolean; command?: string | string[] };
    types: { enabled: boolean; command?: string | string[] };
    build: { enabled: boolean; command?: string | string[] };
  };
  limits: { max_diff_lines: number };
  review: { require_challenger: boolean };
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  planner: "Sprint planning — selects and sequences backlog issues",
  general: "Issue execution — implements code changes for each issue",
  reviewer: "Code review — reviews PRs for quality and correctness",
  "quality-reviewer": "Acceptance review — validates acceptance criteria",
  "test-engineer": "TDD — generates tests before implementation",
  refiner: "Refinement — enriches idea issues with details and ICE scores",
  retro: "Retrospective — analyzes sprint and suggests improvements",
  researcher: "Research — investigates technical topics and options",
};

const ROLE_PLACEHOLDERS: Record<string, { name: string; desc: string }[]> = {
  planner: [
    { name: "PROJECT_NAME", desc: "Project name from config" },
    { name: "REPO_OWNER", desc: "GitHub repository owner" },
    { name: "REPO_NAME", desc: "GitHub repository name" },
    { name: "SPRINT_NUMBER", desc: "Current sprint number" },
    { name: "MIN_ISSUES", desc: "Minimum issues required in sprint" },
    { name: "MAX_ISSUES", desc: "Maximum issues allowed in sprint" },
    { name: "BASE_BRANCH", desc: "Base git branch (e.g. main)" },
  ],
  general: [
    { name: "PROJECT_NAME", desc: "Project name" },
    { name: "REPO_OWNER", desc: "Repository owner" },
    { name: "REPO_NAME", desc: "Repository name" },
    { name: "SPRINT_NUMBER", desc: "Current sprint number" },
    { name: "ISSUE_NUMBER", desc: "GitHub issue number being worked on" },
    { name: "ISSUE_TITLE", desc: "Issue title" },
    { name: "ISSUE_BODY", desc: "Full issue body text (sanitized)" },
    { name: "BRANCH_NAME", desc: "Feature branch name" },
    { name: "BASE_BRANCH", desc: "Base git branch" },
    { name: "WORKTREE_PATH", desc: "Path to git worktree directory" },
    { name: "MAX_DIFF_LINES", desc: "Max diff lines before extra review" },
    { name: "IMPLEMENTATION_PLAN", desc: "Plan from item planner (if available)" },
  ],
  reviewer: [
    { name: "PROJECT_NAME", desc: "Project name" },
    { name: "REPO_OWNER", desc: "Repository owner" },
    { name: "REPO_NAME", desc: "Repository name" },
    { name: "SPRINT_NUMBER", desc: "Current sprint number" },
    { name: "SPRINT_START_SHA", desc: "Git SHA at sprint start" },
    { name: "SPRINT_ISSUES", desc: "Summary of all sprint issues (sanitized)" },
    { name: "BASE_BRANCH", desc: "Base git branch" },
    { name: "METRICS", desc: "Sprint velocity and quality metrics" },
    { name: "FAILED_GATES", desc: "List of failed quality gates" },
    { name: "FLAGGED_PRS", desc: "PRs flagged for extra review" },
  ],
  "quality-reviewer": [
    { name: "ISSUE_NUMBER", desc: "Issue number under review" },
    { name: "ISSUE_TITLE", desc: "Issue title" },
    { name: "ACCEPTANCE_CRITERIA", desc: "Issue acceptance criteria" },
    { name: "DIFF", desc: "Code diff of the PR" },
    { name: "TEST_OUTPUT", desc: "Test execution output" },
    { name: "QG_RESULT", desc: "Quality gate check results" },
  ],
  "test-engineer": [
    { name: "PROJECT_NAME", desc: "Project name" },
    { name: "REPO_OWNER", desc: "Repository owner" },
    { name: "REPO_NAME", desc: "Repository name" },
    { name: "SPRINT_NUMBER", desc: "Current sprint number" },
    { name: "ISSUE_NUMBER", desc: "Issue number" },
    { name: "ISSUE_TITLE", desc: "Issue title" },
    { name: "ISSUE_BODY", desc: "Issue body (sanitized)" },
    { name: "BRANCH_NAME", desc: "Feature branch name" },
    { name: "BASE_BRANCH", desc: "Base git branch" },
    { name: "WORKTREE_PATH", desc: "Worktree directory" },
    { name: "MAX_DIFF_LINES", desc: "Max diff lines" },
    { name: "IMPLEMENTATION_PLAN", desc: "Implementation plan" },
  ],
  refiner: [
    { name: "PROJECT_NAME", desc: "Project name" },
    { name: "REPO_OWNER", desc: "Repository owner" },
    { name: "REPO_NAME", desc: "Repository name" },
    { name: "SPRINT_NUMBER", desc: "Current sprint number" },
    { name: "BASE_BRANCH", desc: "Base git branch" },
  ],
  retro: [
    { name: "PROJECT_NAME", desc: "Project name" },
    { name: "REPO_OWNER", desc: "Repository owner" },
    { name: "REPO_NAME", desc: "Repository name" },
    { name: "SPRINT_NUMBER", desc: "Current sprint number" },
    { name: "SPRINT_REVIEW_DATA", desc: "Data from sprint review" },
    { name: "FAILURE_DIAGNOSTICS", desc: "Diagnostics of failed items" },
  ],
};

function PlaceholderHelp({ roleName }: { roleName: string }) {
  const [open, setOpen] = useState(false);
  const placeholders = ROLE_PLACEHOLDERS[roleName];
  if (!placeholders) return null;
  return (
    <div className="placeholder-help">
      <button className="placeholder-help-toggle" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Available placeholders ({placeholders.length})
      </button>
      {open && (
        <div className="placeholder-help-list">
          {placeholders.map((p) => (
            <div key={p.name} className="placeholder-help-item">
              <code>{"{{" + p.name + "}}"}</code>
              <span>{p.desc}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const MODEL_OPTIONS: Array<{ value: string; label: string } | { group: string; options: { value: string; label: string }[] }> = [
  { value: "", label: "Default (inherit from global)" },
  { group: "High Tier", options: [
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { value: "claude-opus-4", label: "Claude Opus 4" },
    { value: "gpt-4.1", label: "GPT-4.1" },
    { value: "o4-mini", label: "o4-mini" },
  ]},
  { group: "Low Tier", options: [
    { value: "claude-haiku-3-5", label: "Claude Haiku 3.5" },
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ]},
];

function RoleEditor({ role, onSave }: { role: AgentRole; onSave: (r: AgentRole) => void }) {
  const [instructions, setInstructions] = useState(role.instructions);
  const [prompts, setPrompts] = useState(role.prompts);
  const [model, setModel] = useState(role.model ?? "");
  const [mode, setMode] = useState(role.mode ?? "autonomous");
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState(false);

  const update = (field: "instructions" | string, value: string) => {
    if (field === "instructions") {
      setInstructions(value);
    } else {
      setPrompts((prev) => ({ ...prev, [field]: value }));
    }
    setDirty(true);
  };

  const save = () => {
    onSave({ ...role, instructions, prompts, model: model || undefined, mode: mode || undefined });
    setDirty(false);
  };

  return (
    <div className="role-editor">
      <div className="role-editor-header" onClick={() => setOpen(!open)}>
        <h4>
          <span>{open ? "▾" : "▸"}</span>
          {role.name}
          <span className="role-editor-desc">{ROLE_DESCRIPTIONS[role.name] ?? "Agent role"}</span>
        </h4>
        <div className="role-editor-badges">
          {model && <span className="role-badge">🧠 {model}</span>}
          {mode === "manual" && <span className="role-badge">🖐 manual</span>}
          {dirty && <button className="btn btn-primary btn-small role-editor-save" onClick={(e) => { e.stopPropagation(); save(); }}>💾 Save</button>}
        </div>
      </div>
      {open && (
        <div className="role-editor-body">
          <div className="role-config-row">
            <div className="role-config-field">
              <label>Model</label>
              <select className="settings-input" value={model} onChange={(e) => { setModel(e.target.value); setDirty(true); }}>
                {MODEL_OPTIONS.map((opt) =>
                  "group" in opt ? (
                    <optgroup key={opt.group} label={opt.group}>
                      {opt.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </optgroup>
                  ) : (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  )
                )}
              </select>
            </div>
            <div className="role-config-field">
              <label>Mode</label>
              <select className="settings-input" value={mode} onChange={(e) => { setMode(e.target.value); setDirty(true); }}>
                <option value="autonomous">🤖 Autonomous</option>
                <option value="manual">🖐 Manual</option>
              </select>
            </div>
          </div>
          <PlaceholderHelp roleName={role.name} />
          <div>
            <label>Instructions (copilot-instructions.md)</label>
            <textarea value={instructions} onChange={(e) => update("instructions", e.target.value)} />
          </div>
          {Object.entries(prompts).map(([fname, content]) => (
            <div key={fname}>
              <label>Prompt: {fname}</label>
              <textarea
                className="role-prompt-textarea"
                value={content}
                onChange={(e) => update(fname, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [savedConfig, setSavedConfig] = useState<string>("");
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [qualityGates, setQualityGates] = useState<QualityGates | null>(null);
  const [savedQg, setSavedQg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/roles").then((r) => r.json()),
      fetch("/api/quality-gates").then((r) => r.json()),
    ]).then(([cfg, rls, qg]) => {
      setConfig(cfg as Config);
      setSavedConfig(JSON.stringify(cfg));
      setRoles((rls as AgentRole[]) ?? []);
      if (qg) { setQualityGates(qg as QualityGates); setSavedQg(JSON.stringify(qg)); }
    }).catch((e) => setError(String(e)));
  }, []);

  const isDirty = config ? JSON.stringify(config) !== savedConfig : false;
  const qgDirty = qualityGates ? JSON.stringify(qualityGates) !== savedQg : false;

  const showToast = useCallback((msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

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
        // Also save quality gates if dirty
        if (qualityGates && qgDirty) {
          const qgRes = await fetch("/api/quality-gates", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(qualityGates),
          });
          if (qgRes.ok) setSavedQg(JSON.stringify(qualityGates));
        }
        showToast("✅ Settings saved", "success");
      } else {
        const data = await res.json();
        showToast(`❌ ${data.error ?? "Save failed"}`, "error");
      }
    } catch (e) {
      showToast(`❌ ${String(e)}`, "error");
    }
  }, [config, qualityGates, qgDirty, showToast]);

  const reset = useCallback(() => {
    if (savedConfig) setConfig(JSON.parse(savedConfig));
    if (savedQg) setQualityGates(JSON.parse(savedQg));
  }, [savedConfig, savedQg]);

  const saveRole = useCallback(async (role: AgentRole) => {
    try {
      const res = await fetch("/api/roles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(role),
      });
      if (res.ok) {
        setRoles((prev) => prev.map((r) => r.name === role.name ? role : r));
        showToast(`✅ ${role.name} saved`, "success");
      } else {
        showToast(`❌ Failed to save ${role.name}`, "error");
      }
    } catch (e) {
      showToast(`❌ ${String(e)}`, "error");
    }
  }, [showToast]);

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
  const upQgCheck = useCallback((check: keyof QualityGates["checks"], patch: Partial<{ enabled: boolean; command: string | string[] }>) => {
    setQualityGates((prev) => prev ? { ...prev, checks: { ...prev.checks, [check]: { ...prev.checks[check], ...patch } } } : prev);
  }, []);
  const upQgLimits = useCallback((patch: Partial<QualityGates["limits"]>) => {
    setQualityGates((prev) => prev ? { ...prev, limits: { ...prev.limits, ...patch } } : prev);
  }, []);
  const upQgReview = useCallback((patch: Partial<QualityGates["review"]>) => {
    setQualityGates((prev) => prev ? { ...prev, review: { ...prev.review, ...patch } } : prev);
  }, []);

  if (error) return <div className="settings-loading">❌ Failed to load config: {error}</div>;
  if (!config) return <div className="settings-loading">Loading configuration…</div>;

  return (
    <div className="settings-page">
      <h1>⚙️ Settings</h1>

      <div className="settings-actions">
        <button className="btn btn-primary btn-small" onClick={save} disabled={!isDirty && !qgDirty}>
          💾 Save
        </button>
        <button className="btn btn-small" onClick={reset} disabled={!isDirty && !qgDirty}>
          ↩ Reset
        </button>
        {(isDirty || qgDirty) && <span className="settings-dirty">● Unsaved changes</span>}
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
            <Row label="Min Issues" desc="Minimum issues to plan per sprint (0 = no minimum)">
              <NumInput value={config.sprint.min_issues} onChange={(v) => upSprint({ min_issues: v })} min={0} narrow />
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
        {qualityGates ? (
          <table className="settings-table">
            <tbody>
              <Row label="Tests" desc="Require tests to pass before merging">
                <Toggle value={qualityGates.checks.tests.enabled} onChange={(v) => upQgCheck("tests", { enabled: v })} />
              </Row>
              <Row label="Test Command" desc="Shell command to run tests">
                <TextInput value={cmdStr(qualityGates.checks.tests.command ?? "")} onChange={(v) => upQgCheck("tests", { command: cmdArr(v) })} />
              </Row>
              <Row label="Lint" desc="Require linter to pass before merging">
                <Toggle value={qualityGates.checks.lint.enabled} onChange={(v) => upQgCheck("lint", { enabled: v })} />
              </Row>
              <Row label="Lint Command" desc="Shell command to run linter">
                <TextInput value={cmdStr(qualityGates.checks.lint.command ?? "")} onChange={(v) => upQgCheck("lint", { command: cmdArr(v) })} />
              </Row>
              <Row label="Type Check" desc="Require type checking to pass before merging">
                <Toggle value={qualityGates.checks.types.enabled} onChange={(v) => upQgCheck("types", { enabled: v })} />
              </Row>
              <Row label="Type Command" desc="Shell command to run type checker">
                <TextInput value={cmdStr(qualityGates.checks.types.command ?? "")} onChange={(v) => upQgCheck("types", { command: cmdArr(v) })} />
              </Row>
              <Row label="Build" desc="Require build to succeed before merging">
                <Toggle value={qualityGates.checks.build.enabled} onChange={(v) => upQgCheck("build", { enabled: v })} />
              </Row>
              <Row label="Build Command" desc="Shell command to build the project">
                <TextInput value={cmdStr(qualityGates.checks.build.command ?? "")} onChange={(v) => upQgCheck("build", { command: cmdArr(v) })} />
              </Row>
              <Row label="Max Diff Lines" desc="Maximum lines changed per PR before extra review is triggered">
                <NumInput value={qualityGates.limits.max_diff_lines} onChange={(v) => upQgLimits({ max_diff_lines: v })} min={1} narrow />
              </Row>
              <Row label="Challenger" desc="Require adversarial review agent to challenge every PR">
                <Toggle value={qualityGates.review.require_challenger} onChange={(v) => upQgReview({ require_challenger: v })} />
              </Row>
            </tbody>
          </table>
        ) : (
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
              <Row label="Max Diff Lines" desc="Maximum lines changed per PR">
                <NumInput value={config.quality_gates.max_diff_lines} onChange={(v) => upQg({ max_diff_lines: v })} min={1} narrow />
              </Row>
              <Row label="Challenger" desc="Require adversarial code review on every PR">
                <Toggle value={config.quality_gates.require_challenger} onChange={(v) => upQg({ require_challenger: v })} />
              </Row>
            </tbody>
          </table>
        )}
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

      {roles.length > 0 && (
        <Section icon="🤖" title={`Agent Roles (${roles.length})`}>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
            Each agent role has system instructions and prompt templates. Edit the content below and save per role.
          </div>
          {roles.map((role) => (
            <RoleEditor key={role.name} role={role} onSave={saveRole} />
          ))}
        </Section>
      )}

      {toast && <div className={`settings-toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
