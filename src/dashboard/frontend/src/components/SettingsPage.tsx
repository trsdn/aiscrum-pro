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
    sequential_execution: boolean;
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

function NumInput({
  value,
  onChange,
  min,
  max,
  narrow,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  narrow?: boolean;
}) {
  return (
    <input
      type="number"
      className={`settings-input ${narrow ? "settings-input-narrow" : ""}`}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        const raw = parseInt(e.target.value, 10);
        if (Number.isNaN(raw)) return;
        const clamped = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, raw));
        onChange(clamped);
      }}
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
function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc: string;
  children: React.ReactNode;
}) {
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
  skills: Array<{ name: string; description: string; content: string; dirName: string }>;
  mcp_servers: Array<{
    name: string;
    type: string;
    command?: string;
    url?: string;
    args?: string[];
  }>;
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
  documentation: "Documentation — maintains changelog, architecture docs, and user guides",
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
  documentation: [
    { name: "PROJECT_NAME", desc: "Project name" },
    { name: "REPO_OWNER", desc: "Repository owner" },
    { name: "REPO_NAME", desc: "Repository name" },
    { name: "SPRINT_NUMBER", desc: "Current sprint number" },
    { name: "BASE_BRANCH", desc: "Base git branch" },
    { name: "SPRINT_REVIEW_DATA", desc: "Data from sprint review" },
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

const MODEL_OPTIONS: Array<
  { value: string; label: string } | { group: string; options: { value: string; label: string }[] }
> = [
  { value: "", label: "Default (inherit from global)" },
  {
    group: "High Tier",
    options: [
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { value: "claude-opus-4", label: "Claude Opus 4" },
      { value: "gpt-4.1", label: "GPT-4.1" },
      { value: "o4-mini", label: "o4-mini" },
    ],
  },
  {
    group: "Low Tier",
    options: [
      { value: "claude-haiku-3-5", label: "Claude Haiku 3.5" },
      { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
      { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
    ],
  },
];

function RoleEditor({ role, onSave }: { role: AgentRole; onSave: (r: AgentRole) => void }) {
  const [instructions, setInstructions] = useState(role.instructions);
  const [prompts, setPrompts] = useState(role.prompts);
  const [model, setModel] = useState(role.model ?? "");
  const [mode, setMode] = useState(role.mode ?? "autonomous");
  const [skills, setSkills] = useState<Record<string, string>>(
    Object.fromEntries(role.skills.map((s) => [s.dirName, s.content])),
  );
  const [mcpServers, setMcpServers] = useState(role.mcp_servers);
  const [dirty, setDirty] = useState(false);
  const [skillEditing, setSkillEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const update = (field: "instructions" | string, value: string) => {
    if (field === "instructions") {
      setInstructions(value);
    } else {
      setPrompts((prev) => ({ ...prev, [field]: value }));
    }
    setDirty(true);
  };

  const updateSkill = (dirName: string, content: string) => {
    setSkills((prev) => ({ ...prev, [dirName]: content }));
    setDirty(true);
  };

  const addMcp = () => {
    setMcpServers((prev) => [...prev, { name: "", type: "stdio", command: "" }]);
    setDirty(true);
  };

  const removeMcp = (idx: number) => {
    setMcpServers((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const updateMcp = (idx: number, patch: Partial<AgentRole["mcp_servers"][0]>) => {
    setMcpServers((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
    setDirty(true);
  };

  const save = () => {
    onSave({
      ...role,
      instructions,
      prompts,
      model: model || undefined,
      mode: mode || undefined,
      skills: role.skills.map((s) => ({ ...s, content: skills[s.dirName] ?? s.content })),
      mcp_servers: mcpServers,
    });
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
          {role.skills.length > 0 && (
            <span className="role-badge">🛠 {role.skills.length} skills</span>
          )}
          {mcpServers.length > 0 && <span className="role-badge">🔌 {mcpServers.length} MCP</span>}
          {dirty && (
            <button
              className="btn btn-primary btn-small role-editor-save"
              onClick={(e) => {
                e.stopPropagation();
                save();
              }}
            >
              💾 Save
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="role-editor-body">
          <div className="role-config-row">
            <div className="role-config-field">
              <label>Model</label>
              <select
                className="settings-input"
                value={model}
                onChange={(e) => {
                  setModel(e.target.value);
                  setDirty(true);
                }}
              >
                {MODEL_OPTIONS.map((opt) =>
                  "group" in opt ? (
                    <optgroup key={opt.group} label={opt.group}>
                      {opt.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ),
                )}
              </select>
            </div>
            <div className="role-config-field">
              <label>Mode</label>
              <select
                className="settings-input"
                value={mode}
                onChange={(e) => {
                  setMode(e.target.value);
                  setDirty(true);
                }}
              >
                <option value="autonomous">🤖 Autonomous</option>
                <option value="manual">🖐 Manual</option>
              </select>
            </div>
          </div>

          {/* Skills — overview with collapsible edit */}
          <div className="role-section-label">🛠 Skills ({role.skills.length})</div>
          {role.skills.length === 0 && (
            <div className="role-empty-hint">
              No skills configured. Add files to <code>.aiscrum/roles/{role.name}/skills/</code>
            </div>
          )}
          {role.skills.map((s) => (
            <div key={s.dirName} className="role-skill-card">
              <div
                className="role-skill-card-header"
                onClick={() => setSkillEditing(skillEditing === s.dirName ? null : s.dirName)}
              >
                <div className="role-skill-info">
                  <span className="role-skill-name">🛠 {s.name}</span>
                  <span className="role-skill-desc">{s.description}</span>
                </div>
                <button className="btn btn-small">
                  {skillEditing === s.dirName ? "▾ Close" : "✎ Edit"}
                </button>
              </div>
              {skillEditing === s.dirName && (
                <textarea
                  className="role-skill-textarea"
                  value={skills[s.dirName] ?? s.content}
                  onChange={(e) => updateSkill(s.dirName, e.target.value)}
                />
              )}
            </div>
          ))}

          {/* MCP Servers — editable */}
          <div className="role-section-label">
            🔌 MCP Servers ({mcpServers.length})
            <button className="btn btn-small" style={{ marginLeft: 8 }} onClick={addMcp}>
              + Add
            </button>
          </div>
          {mcpServers.length === 0 && (
            <div className="role-empty-hint">No MCP servers configured for this agent.</div>
          )}
          {mcpServers.map((m, i) => (
            <div key={i} className="role-mcp-edit-row">
              <input
                className="settings-input"
                placeholder="Name"
                value={m.name}
                onChange={(e) => updateMcp(i, { name: e.target.value })}
              />
              <select
                className="settings-input"
                value={m.type}
                onChange={(e) => updateMcp(i, { type: e.target.value })}
              >
                <option value="stdio">stdio</option>
                <option value="sse">sse</option>
                <option value="streamable-http">streamable-http</option>
              </select>
              {m.type === "stdio" ? (
                <input
                  className="settings-input"
                  style={{ flex: 2 }}
                  placeholder="Command (e.g. npx server)"
                  value={m.command ?? ""}
                  onChange={(e) => updateMcp(i, { command: e.target.value })}
                />
              ) : (
                <input
                  className="settings-input"
                  style={{ flex: 2 }}
                  placeholder="URL"
                  value={m.url ?? ""}
                  onChange={(e) => updateMcp(i, { url: e.target.value })}
                />
              )}
              <button className="btn btn-small btn-danger" onClick={() => removeMcp(i)}>
                ✕
              </button>
            </div>
          ))}

          <PlaceholderHelp roleName={role.name} />
          <div>
            <label>Instructions (copilot-instructions.md)</label>
            <textarea
              value={instructions}
              onChange={(e) => update("instructions", e.target.value)}
            />
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
  const [savedRoles, setSavedRoles] = useState<string>("");
  const [resetKey, setResetKey] = useState(0);
  const [qualityGates, setQualityGates] = useState<QualityGates | null>(null);
  const [savedQg, setSavedQg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/config").then((r) => r.json()),
      fetch("/api/roles").then((r) => r.json()),
      fetch("/api/quality-gates").then((r) => r.json()),
    ])
      .then(([cfg, rls, qg]) => {
        setConfig(cfg as Config);
        setSavedConfig(JSON.stringify(cfg));
        const roleList = (rls as AgentRole[]) ?? [];
        setRoles(roleList);
        setSavedRoles(JSON.stringify(roleList));
        if (qg) {
          setQualityGates(qg as QualityGates);
          setSavedQg(JSON.stringify(qg));
        }
      })
      .catch((e) => setError(String(e)));
  }, []);

  const isDirty = config ? JSON.stringify(config) !== savedConfig : false;
  const qgDirty = qualityGates ? JSON.stringify(qualityGates) !== savedQg : false;

  const showToast = useCallback((msg: string, type: "success" | "error") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const save = useCallback(async () => {
    if (!config) return;
    const results: string[] = [];
    try {
      // Save config independently
      if (isDirty) {
        const res = await fetch("/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(config),
        });
        if (res.ok) {
          setSavedConfig(JSON.stringify(config));
          results.push("config");
        } else {
          const data = await res.json();
          showToast(`❌ Config: ${data.error ?? "Save failed"}`, "error");
          return;
        }
      }
      // Save quality gates independently
      if (qualityGates && qgDirty) {
        const qgRes = await fetch("/api/quality-gates", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(qualityGates),
        });
        if (qgRes.ok) {
          setSavedQg(JSON.stringify(qualityGates));
          results.push("quality gates");
        } else {
          showToast("❌ Quality gates save failed", "error");
          return;
        }
      }
      if (results.length > 0) {
        showToast(`✅ Saved ${results.join(" + ")}`, "success");
      } else {
        showToast("ℹ️ No changes to save", "success");
      }
    } catch (e) {
      showToast(`❌ ${String(e)}`, "error");
    }
  }, [config, isDirty, qualityGates, qgDirty, showToast]);

  const reset = useCallback(() => {
    if (savedConfig) setConfig(JSON.parse(savedConfig));
    if (savedQg) setQualityGates(JSON.parse(savedQg));
    if (savedRoles) {
      setRoles(JSON.parse(savedRoles));
      setResetKey((k) => k + 1);
    }
  }, [savedConfig, savedQg, savedRoles]);

  const saveRole = useCallback(
    async (role: AgentRole) => {
      try {
        const skillsMap: Record<string, string> = {};
        for (const s of role.skills) skillsMap[s.dirName] = s.content;
        const res = await fetch("/api/roles", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: role.name,
            instructions: role.instructions,
            prompts: role.prompts,
            model: role.model,
            mode: role.mode,
            skills: skillsMap,
            mcp_servers: role.mcp_servers,
          }),
        });
        if (res.ok) {
          const updatedRoles = roles.map((r) => (r.name === role.name ? role : r));
          setRoles(updatedRoles);
          setSavedRoles(JSON.stringify(updatedRoles));
          showToast(`✅ ${role.name} saved`, "success");
        } else {
          showToast(`❌ Failed to save ${role.name}`, "error");
        }
      } catch (e) {
        showToast(`❌ ${String(e)}`, "error");
      }
    },
    [showToast],
  );

  // Updater helpers
  const up = useCallback(<K extends keyof Config>(section: K, patch: Partial<Config[K]>) => {
    setConfig((prev) => (prev ? { ...prev, [section]: { ...prev[section], ...patch } } : prev));
  }, []);

  const upQg = useCallback(
    (patch: Partial<Config["quality_gates"]>) => up("quality_gates", patch),
    [up],
  );
  const upSprint = useCallback((patch: Partial<Config["sprint"]>) => up("sprint", patch), [up]);
  const upCopilot = useCallback((patch: Partial<Config["copilot"]>) => up("copilot", patch), [up]);
  const upGit = useCallback((patch: Partial<Config["git"]>) => up("git", patch), [up]);
  const upNotif = useCallback((patch: Partial<Config["escalation"]["notifications"]>) => {
    setConfig((prev) =>
      prev
        ? {
            ...prev,
            escalation: {
              ...prev.escalation,
              notifications: { ...prev.escalation.notifications, ...patch },
            },
          }
        : prev,
    );
  }, []);
  const upQgCheck = useCallback(
    (
      check: keyof QualityGates["checks"],
      patch: Partial<{ enabled: boolean; command: string | string[] }>,
    ) => {
      setQualityGates((prev) =>
        prev
          ? { ...prev, checks: { ...prev.checks, [check]: { ...prev.checks[check], ...patch } } }
          : prev,
      );
    },
    [],
  );
  const upQgLimits = useCallback((patch: Partial<QualityGates["limits"]>) => {
    setQualityGates((prev) => (prev ? { ...prev, limits: { ...prev.limits, ...patch } } : prev));
  }, []);
  const upQgReview = useCallback((patch: Partial<QualityGates["review"]>) => {
    setQualityGates((prev) => (prev ? { ...prev, review: { ...prev.review, ...patch } } : prev));
  }, []);

  if (error) return <div className="settings-loading">❌ Failed to load config: {error}</div>;
  if (!config) return <div className="settings-loading">Loading configuration…</div>;

  return (
    <div className="settings-page">
      <h1>⚙️ Settings</h1>

      <div className="settings-actions">
        <button
          className="btn btn-primary btn-small"
          onClick={save}
          disabled={!isDirty && !qgDirty}
        >
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
              <TextInput
                value={config.project.base_branch}
                onChange={(v) => up("project", { base_branch: v })}
              />
            </Row>
          </tbody>
        </table>
      </Section>

      <Section icon="🤖" title="Copilot" defaultOpen={true}>
        <table className="settings-table">
          <tbody>
            <Row label="Executable" desc="Path to the Copilot CLI binary">
              <TextInput
                value={config.copilot.executable}
                onChange={(v) => upCopilot({ executable: v })}
              />
            </Row>
            <Row
              label="Max Parallel Sessions"
              desc="How many ACP sessions can run simultaneously (1-20)"
            >
              <NumInput
                value={config.copilot.max_parallel_sessions}
                onChange={(v) => upCopilot({ max_parallel_sessions: v })}
                min={1}
                max={20}
                narrow
              />
            </Row>
            <Row label="Session Timeout" desc="Max time (seconds) before an idle session is killed">
              <NumInput
                value={Math.round(config.copilot.session_timeout_ms / 1000)}
                onChange={(v) => upCopilot({ session_timeout_ms: v * 1000 })}
                min={0}
                narrow
              />
            </Row>
            <Row
              label="Auto-approve Tools"
              desc="Automatically approve tool calls without human confirmation"
            >
              <Toggle
                value={config.copilot.auto_approve_tools}
                onChange={(v) => upCopilot({ auto_approve_tools: v })}
              />
            </Row>
          </tbody>
        </table>
        {config.copilot.instructions.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Instructions ({config.copilot.instructions.length})
            </span>
            <ul className="settings-list">
              {config.copilot.instructions.map((inst, i) => (
                <li key={i}>{inst}</li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section icon="🏃" title="Sprint">
        <table className="settings-table">
          <tbody>
            <Row
              label="Prefix"
              desc="Milestone title prefix for sprint naming (e.g. 'Sprint' → 'Sprint 1')"
            >
              <TextInput value={config.sprint.prefix} onChange={(v) => upSprint({ prefix: v })} />
            </Row>
            <Row label="Min Issues" desc="Minimum issues to plan per sprint (0 = no minimum)">
              <NumInput
                value={config.sprint.min_issues}
                onChange={(v) => upSprint({ min_issues: v })}
                min={0}
                narrow
              />
            </Row>
            <Row label="Max Issues" desc="Maximum issues to plan per sprint">
              <NumInput
                value={config.sprint.max_issues}
                onChange={(v) => upSprint({ max_issues: v })}
                min={1}
                narrow
              />
            </Row>
            <Row label="Max Issues Created" desc="Max issues the agent can auto-create per sprint">
              <NumInput
                value={config.sprint.max_issues_created_per_sprint}
                onChange={(v) => upSprint({ max_issues_created_per_sprint: v })}
                min={1}
                narrow
              />
            </Row>
            <Row label="Max Sprints" desc="Number of sprints to run in a loop (0 = unlimited)">
              <NumInput
                value={config.sprint.max_sprints}
                onChange={(v) => upSprint({ max_sprints: v })}
                min={0}
                narrow
              />
            </Row>
            <Row label="Max Drift Incidents" desc="How many unplanned issues before escalation">
              <NumInput
                value={config.sprint.max_drift_incidents}
                onChange={(v) => upSprint({ max_drift_incidents: v })}
                min={0}
                narrow
              />
            </Row>
            <Row label="Max Retries" desc="Retry attempts for a failed issue before giving up">
              <NumInput
                value={config.sprint.max_retries}
                onChange={(v) => upSprint({ max_retries: v })}
                min={0}
                narrow
              />
            </Row>
            <Row
              label="Challenger"
              desc="Run adversarial review agent to challenge sprint decisions"
            >
              <Toggle
                value={config.sprint.enable_challenger}
                onChange={(v) => upSprint({ enable_challenger: v })}
              />
            </Row>
            <Row label="TDD" desc="Require test-driven development workflow for all issues">
              <Toggle
                value={config.sprint.enable_tdd}
                onChange={(v) => upSprint({ enable_tdd: v })}
              />
            </Row>
            <Row
              label="Sequential Execution"
              desc="Run developer agents one at a time to avoid merge conflicts"
            >
              <Toggle
                value={config.sprint.sequential_execution}
                onChange={(v) => upSprint({ sequential_execution: v })}
              />
            </Row>
            <Row
              label="Auto-revert Drift"
              desc="Automatically revert changes that cause sprint scope drift"
            >
              <Toggle
                value={config.sprint.auto_revert_drift}
                onChange={(v) => upSprint({ auto_revert_drift: v })}
              />
            </Row>
          </tbody>
        </table>
      </Section>

      <Section icon="🛡️" title="Quality Gates">
        {qualityGates ? (
          <div className="qg-grid">
            {(["tests", "lint", "types", "build"] as const).map((check) => (
              <div key={check} className="qg-card">
                <div className="qg-card-header">
                  <Toggle
                    value={qualityGates.checks[check].enabled}
                    onChange={(v) => upQgCheck(check, { enabled: v })}
                  />
                  <span className="qg-card-title">
                    {check.charAt(0).toUpperCase() + check.slice(1)}
                  </span>
                </div>
                <label>Command</label>
                <textarea
                  className="qg-command-textarea"
                  value={cmdStr(qualityGates.checks[check].command ?? "")}
                  onChange={(e) => upQgCheck(check, { command: cmdArr(e.target.value) })}
                  placeholder={`e.g. npm run ${check}`}
                />
              </div>
            ))}
            <div className="qg-card">
              <div className="qg-card-header">
                <span className="qg-card-title">Max Diff Lines</span>
              </div>
              <NumInput
                value={qualityGates.limits.max_diff_lines}
                onChange={(v) => upQgLimits({ max_diff_lines: v })}
                min={1}
                narrow
              />
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
                Lines changed per PR before extra review
              </div>
            </div>
            <div className="qg-card">
              <div className="qg-card-header">
                <Toggle
                  value={qualityGates.review.require_challenger}
                  onChange={(v) => upQgReview({ require_challenger: v })}
                />
                <span className="qg-card-title">Challenger Review</span>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                Adversarial review agent challenges every PR
              </div>
            </div>
          </div>
        ) : (
          <table className="settings-table">
            <tbody>
              <Row label="Tests" desc="Require tests to pass before merging">
                <Toggle
                  value={config.quality_gates.require_tests}
                  onChange={(v) => upQg({ require_tests: v })}
                />
              </Row>
              <Row label="Test Command" desc="Command to run tests">
                <TextInput
                  value={cmdStr(config.quality_gates.test_command)}
                  onChange={(v) => upQg({ test_command: v })}
                />
              </Row>
              <Row label="Lint" desc="Require linter to pass before merging">
                <Toggle
                  value={config.quality_gates.require_lint}
                  onChange={(v) => upQg({ require_lint: v })}
                />
              </Row>
              <Row label="Lint Command" desc="Command to run linter">
                <TextInput
                  value={cmdStr(config.quality_gates.lint_command)}
                  onChange={(v) => upQg({ lint_command: v })}
                />
              </Row>
              <Row label="Type Check" desc="Require type checking to pass before merging">
                <Toggle
                  value={config.quality_gates.require_types}
                  onChange={(v) => upQg({ require_types: v })}
                />
              </Row>
              <Row label="Type Command" desc="Command to run type checker">
                <TextInput
                  value={cmdStr(config.quality_gates.typecheck_command)}
                  onChange={(v) => upQg({ typecheck_command: v })}
                />
              </Row>
              <Row label="Build" desc="Require build to succeed before merging">
                <Toggle
                  value={config.quality_gates.require_build}
                  onChange={(v) => upQg({ require_build: v })}
                />
              </Row>
              <Row label="Build Command" desc="Command to build the project">
                <TextInput
                  value={cmdStr(config.quality_gates.build_command)}
                  onChange={(v) => upQg({ build_command: v })}
                />
              </Row>
              <Row label="Max Diff Lines" desc="Maximum lines changed per PR">
                <NumInput
                  value={config.quality_gates.max_diff_lines}
                  onChange={(v) => upQg({ max_diff_lines: v })}
                  min={1}
                  narrow
                />
              </Row>
              <Row label="Challenger" desc="Require adversarial code review on every PR">
                <Toggle
                  value={config.quality_gates.require_challenger}
                  onChange={(v) => upQg({ require_challenger: v })}
                />
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
                {srv.command && (
                  <>
                    {" "}
                    · Command:{" "}
                    <code>
                      {srv.command} {srv.args?.join(" ")}
                    </code>
                  </>
                )}
                {srv.url && (
                  <>
                    {" "}
                    · URL: <code>{srv.url}</code>
                  </>
                )}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            MCP servers connect external tools to Copilot sessions. Edit in{" "}
            <code>.aiscrum/config.yaml</code>.
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
                  {cfg.model && (
                    <tr>
                      <td>Model</td>
                      <td>
                        <code>{cfg.model}</code>
                      </td>
                      <td>AI model for this phase</td>
                    </tr>
                  )}
                  {cfg.mcp_servers && cfg.mcp_servers.length > 0 && (
                    <tr>
                      <td>MCP Servers</td>
                      <td>{cfg.mcp_servers.map((s) => s.name).join(", ")}</td>
                      <td>Additional servers for this phase</td>
                    </tr>
                  )}
                  {cfg.instructions && cfg.instructions.length > 0 && (
                    <tr>
                      <td>Instructions</td>
                      <td>{cfg.instructions.length} custom</td>
                      <td>Extra instructions appended for this phase</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
            Override model, MCP servers, or instructions per sprint phase. Edit in{" "}
            <code>.aiscrum/config.yaml</code>.
          </div>
        </Section>
      )}

      <Section icon="🔔" title="Notifications">
        <table className="settings-table">
          <tbody>
            <Row label="ntfy" desc="Send push notifications via ntfy.sh when events occur">
              <Toggle
                value={config.escalation.notifications.ntfy}
                onChange={(v) => upNotif({ ntfy: v })}
              />
            </Row>
            <Row label="Topic" desc="ntfy topic name for push notifications">
              <TextInput
                value={config.escalation.notifications.ntfy_topic}
                onChange={(v) => upNotif({ ntfy_topic: v })}
              />
            </Row>
            <Row label="Server" desc="ntfy server URL (default: https://ntfy.sh)">
              <TextInput
                value={config.escalation.notifications.ntfy_server_url}
                onChange={(v) => upNotif({ ntfy_server_url: v })}
              />
            </Row>
          </tbody>
        </table>
      </Section>

      <Section icon="🔀" title="Git">
        <table className="settings-table">
          <tbody>
            <Row
              label="Worktree Base"
              desc="Directory where git worktrees are created for parallel work"
            >
              <TextInput
                value={config.git.worktree_base}
                onChange={(v) => upGit({ worktree_base: v })}
              />
            </Row>
            <Row
              label="Branch Pattern"
              desc="Pattern for feature branches. Placeholders: {prefix}, {sprint}, {issue}"
            >
              <TextInput
                value={config.git.branch_pattern}
                onChange={(v) => upGit({ branch_pattern: v })}
              />
            </Row>
            <Row label="Auto Merge" desc="Automatically merge PRs when all quality gates pass">
              <Toggle value={config.git.auto_merge} onChange={(v) => upGit({ auto_merge: v })} />
            </Row>
            <Row label="Squash Merge" desc="Use squash merge instead of regular merge commits">
              <Toggle
                value={config.git.squash_merge}
                onChange={(v) => upGit({ squash_merge: v })}
              />
            </Row>
            <Row label="Delete Branch" desc="Delete feature branch after successful merge">
              <Toggle
                value={config.git.delete_branch_after_merge}
                onChange={(v) => upGit({ delete_branch_after_merge: v })}
              />
            </Row>
          </tbody>
        </table>
      </Section>

      {roles.length > 0 && (
        <Section icon="🤖" title={`Agent Roles (${roles.length})`}>
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 12 }}>
            Each agent role has system instructions and prompt templates. Edit the content below and
            save per role.
          </div>
          {roles.map((role) => (
            <RoleEditor key={`${role.name}-${resetKey}`} role={role} onSave={saveRole} />
          ))}
        </Section>
      )}

      {toast && <div className={`settings-toast ${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}
