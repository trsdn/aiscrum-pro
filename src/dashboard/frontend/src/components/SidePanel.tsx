import { useState, useRef, useEffect } from "react";
import { useDashboardStore } from "../store";
import type { ChatCommand } from "../store";
import { Markdown } from "./Markdown";
import "./SidePanel.css";

const ROLE_META: Record<string, { icon: string; label: string }> = {
  refiner:   { icon: "🔬", label: "Refinement Agent" },
  planner:   { icon: "📐", label: "Planning Agent" },
  reviewer:  { icon: "🔍", label: "Review Agent" },
  researcher:{ icon: "🔎", label: "Research Agent" },
  general:   { icon: "💬", label: "General Agent" },
  challenger:{ icon: "⚔️", label: "Challenger Agent" },
};

const MODE_LABELS: Record<string, { short: string; icon: string }> = {
  "https://agentclientprotocol.com/protocol/session-modes#agent": { short: "Agent", icon: "🤖" },
  "https://agentclientprotocol.com/protocol/session-modes#plan": { short: "Plan", icon: "📋" },
  "https://agentclientprotocol.com/protocol/session-modes#autopilot": { short: "Autopilot", icon: "🚀" },
};

const MODE_CYCLE = [
  "https://agentclientprotocol.com/protocol/session-modes#agent",
  "https://agentclientprotocol.com/protocol/session-modes#plan",
  "https://agentclientprotocol.com/protocol/session-modes#autopilot",
];

const TOOL_KIND_ICONS: Record<string, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑️",
  move: "📁",
  search: "🔍",
  execute: "▶️",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🔄",
  other: "🔧",
};

const DEFAULT_COMMANDS: ChatCommand[] = [
  { name: "help", description: "Show available commands and capabilities" },
  { name: "compact", description: "Summarize conversation to save context" },
  { name: "code-review", description: "Structured code review checklist" },
  { name: "create-pr", description: "Create a PR with conventional title format" },
  { name: "direction-gate", description: "Structured review before strategic direction changes" },
  { name: "sprint-planning", description: "Quick sprint planning for manual use" },
  { name: "tdd-workflow", description: "Test-driven development cycle" },
  { name: "copilot-authoring", description: "Reference for creating Copilot customization artifacts" },
];

export function SidePanel() {
  const activeChatId = useDashboardStore((s) => s.activeChatId);
  const chatSessions = useDashboardStore((s) => s.chatSessions);
  const generalChatId = useDashboardStore((s) => s.generalChatId);
  const chatMessages = useDashboardStore((s) => s.chatMessages);
  const chatStreaming = useDashboardStore((s) => s.chatStreaming);
  const chatThinking = useDashboardStore((s) => s.chatThinking);
  const chatToolCalls = useDashboardStore((s) => s.chatToolCalls);
  const chatUsage = useDashboardStore((s) => s.chatUsage);
  const chatPlan = useDashboardStore((s) => s.chatPlan);
  const chatCommands = useDashboardStore((s) => s.chatCommands);
  const chatConfig = useDashboardStore((s) => s.chatConfig);
  const sidePanelRole = useDashboardStore((s) => s.sidePanelRole);
  const send = useDashboardStore((s) => s.send);

  const [input, setInput] = useState("");
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeMessages = activeChatId ? chatMessages[activeChatId] ?? [] : [];
  const streaming = activeChatId ? chatStreaming[activeChatId] : undefined;
  const thinking = activeChatId ? chatThinking[activeChatId] : undefined;
  const toolCalls = activeChatId ? chatToolCalls[activeChatId] : undefined;
  const usage = activeChatId ? chatUsage[activeChatId] : undefined;
  const plan = activeChatId ? chatPlan[activeChatId] : undefined;
  const agentCommands = activeChatId ? chatCommands[activeChatId] : undefined;
  // Merge default commands with agent-provided ones (agent commands take priority)
  const allCommands = (() => {
    const agentNames = new Set((agentCommands ?? []).map((c) => c.name));
    const defaults = DEFAULT_COMMANDS.filter((c) => !agentNames.has(c.name));
    return [...(agentCommands ?? []), ...defaults];
  })();
  const configs = activeChatId ? chatConfig[activeChatId] : undefined;
  const activeSession = chatSessions.find((s) => s.id === activeChatId);
  const isLoading = !activeSession && activeChatId !== "__global__" && activeChatId !== null;

  const role = activeSession?.role ?? sidePanelRole ?? "agent";
  const meta = ROLE_META[role] ?? { icon: "🤖", label: role };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages, streaming, thinking, toolCalls, plan]);

  const switchToSession = (sessionId: string) => {
    const session = chatSessions.find((s) => s.id === sessionId);
    useDashboardStore.setState({
      activeChatId: sessionId,
      sidePanelRole: session?.role ?? null,
    });
  };

  const closeSession = (sessionId: string) => {
    if (sessionId === generalChatId) return;
    send({ type: "chat:close", sessionId });
    const store = useDashboardStore.getState();
    const remaining = store.chatSessions.filter((s) => s.id !== sessionId);
    const nextActive = sessionId === activeChatId
      ? (generalChatId ?? remaining[0]?.id ?? null)
      : activeChatId;
    useDashboardStore.setState({
      chatSessions: remaining,
      activeChatId: nextActive,
      sidePanelRole: remaining.find((s) => s.id === nextActive)?.role ?? null,
    });
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    const chatId = useDashboardStore.getState().activeChatId;
    if (!chatId || chatId === "__global__") return;
    send({ type: "chat:send", sessionId: chatId, message: trimmed });
    const store = useDashboardStore.getState();
    const msgs = store.chatMessages[chatId] ?? [];
    useDashboardStore.setState({
      chatMessages: {
        ...store.chatMessages,
        [chatId]: [...msgs, { role: "user", content: trimmed }],
      },
    });
    setInput("");
    setShowSlashMenu(false);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    if (val.startsWith("/")) {
      setShowSlashMenu(true);
      setSlashFilter(val.slice(1).toLowerCase());
    } else {
      setShowSlashMenu(false);
    }
  };

  const selectCommand = (cmd: ChatCommand) => {
    const text = `/${cmd.name} `;
    setInput(text);
    setShowSlashMenu(false);
    inputRef.current?.focus();
  };

  const toggleMode = () => {
    if (!activeSession) return;
    const currentMode = activeSession.modeId ?? MODE_CYCLE[0]!;
    const idx = MODE_CYCLE.indexOf(currentMode);
    const nextMode = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length]!;
    send({ type: "chat:set-mode", sessionId: activeSession.id, mode: nextMode });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      toggleMode();
    }
  };

  const filteredCommands = allCommands.filter((c) =>
    c.name.toLowerCase().includes(slashFilter) || c.description.toLowerCase().includes(slashFilter),
  );

  return (
    <div className="side-panel">
      {/* Session tabs */}
      <div className="session-tabs">
        {chatSessions.map((s) => {
          const m = ROLE_META[s.role] ?? { icon: "🤖", label: s.role };
          const isActive = s.id === activeChatId;
          return (
            <div
              key={s.id}
              className={`session-tab${isActive ? " session-tab-active" : ""}`}
              onClick={() => switchToSession(s.id)}
            >
              <span className="session-tab-label">{m.icon} {m.label}</span>
              {s.id !== generalChatId && (
                <button
                  className="session-tab-close"
                  onClick={(e) => { e.stopPropagation(); closeSession(s.id); }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Status bar */}
      <div className="side-panel-header">
        <span className="side-panel-title">
          {meta.icon} {meta.label}
        </span>
        {isLoading && <span className="side-panel-status loading">Connecting…</span>}
        {activeSession && <span className="side-panel-status connected">● Connected</span>}
        {activeSession?.model && (
          <span className="side-panel-model">{activeSession.model}</span>
        )}
        {configs && configs.filter((c) => c.category !== "mode").length > 0 && (
          <div className="side-panel-config-wrapper">
            <button
              className="side-panel-settings-btn"
              onClick={() => setShowSettings(!showSettings)}
              title="Session settings"
            >
              ⚙️
            </button>
            {showSettings && (
              <div className="side-panel-settings-panel">
                {configs.filter((c) => c.category !== "mode").map((cfg) => (
                  <div key={cfg.id} className="settings-group">
                    <label className="settings-label">{cfg.name}</label>
                    <select
                      className="settings-select"
                      value={cfg.currentValue}
                      onChange={(e) => {
                        if (activeChatId) {
                          send({ type: "chat:set-config", sessionId: activeChatId, optionId: cfg.id, value: e.target.value });
                        }
                      }}
                    >
                      {cfg.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.name}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="side-panel-messages">
        {activeMessages.length === 0 && !streaming && !isLoading && (
          <div className="side-panel-empty">
            Session ready. Send a message to start.
          </div>
        )}
        {isLoading && activeMessages.length === 0 && (
          <div className="side-panel-empty">
            Loading {meta.label} agent…
          </div>
        )}
        {activeMessages.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            <span className="chat-role">
              {m.role === "assistant" ? meta.label : m.role === "user" ? "You" : m.role}
            </span>
            <div className="chat-content"><Markdown text={m.content} /></div>
          </div>
        ))}

        {/* Thinking indicator */}
        {thinking && !streaming && (
          <div className="chat-thinking">
            <span className="chat-thinking-label">💭 Thinking…</span>
            <div className="chat-thinking-content">{thinking.slice(-200)}</div>
          </div>
        )}

        {/* Active tool calls */}
        {toolCalls && toolCalls.length > 0 && (
          <div className="chat-tool-calls">
            {toolCalls.map((tc) => (
              <div key={tc.toolCallId} className={`chat-tool-call chat-tool-${tc.status ?? "running"}`}>
                <span className="chat-tool-icon">
                  {tc.status === "completed" ? "✓" : tc.status === "failed" ? "✗" : "⟳"}
                </span>
                <span className="chat-tool-kind">{TOOL_KIND_ICONS[tc.kind ?? ""] ?? "🔧"}</span>
                <span className="chat-tool-title">{tc.title}</span>
                {tc.locations && tc.locations.length > 0 && (
                  <span className="chat-tool-locations">
                    {tc.locations.map((l, i) => (
                      <span key={i} className="chat-tool-location">
                        {l.path.split("/").pop()}{l.line ? `:${l.line}` : ""}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Plan progress */}
        {plan && plan.length > 0 && (
          <div className="chat-plan">
            <div className="chat-plan-header">
              📋 Plan ({plan.filter((e) => e.status === "completed").length}/{plan.length})
            </div>
            {plan.map((entry, i) => (
              <div key={i} className={`chat-plan-entry chat-plan-${entry.status}`}>
                <span className="chat-plan-check">
                  {entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "⟳" : "○"}
                </span>
                <span className="chat-plan-text">{entry.content}</span>
              </div>
            ))}
          </div>
        )}

        {streaming && (
          <div className="chat-msg chat-assistant">
            <span className="chat-role">{meta.label}</span>
            <div className="chat-content chat-streaming">
              <Markdown text={streaming} />
              <span className="streaming-cursor">▌</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Usage bar */}
      {usage && (
        <div className="chat-usage-bar">
          <span className="chat-usage-tokens">
            Tokens: {usage.used.toLocaleString()} / {usage.size.toLocaleString()}
          </span>
          <div className="chat-usage-meter">
            <div
              className="chat-usage-fill"
              style={{ width: `${Math.min(100, (usage.used / usage.size) * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Slash command menu */}
      {showSlashMenu && filteredCommands.length > 0 && (
        <div className="slash-menu">
          {filteredCommands.map((cmd) => (
            <button
              key={cmd.name}
              className="slash-menu-item"
              onClick={() => selectCommand(cmd)}
            >
              <span className="slash-menu-name">/{cmd.name}</span>
              <span className="slash-menu-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}

      <div className="side-panel-input-row">
        <textarea
          ref={inputRef}
          className="side-panel-input"
          placeholder="Type / for commands, or ask something…"
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={() => setTimeout(() => setShowSlashMenu(false), 200)}
          rows={2}
          autoFocus
        />
        <button className="btn btn-primary btn-small" onClick={handleSend}>
          Send
        </button>
      </div>

      {/* Mode selector */}
      {activeSession && (
        <div className="side-panel-mode-bar">
          <div className="mode-selector-wrapper">
            <button
              className="mode-selector-btn"
              onClick={() => setShowModeMenu(!showModeMenu)}
            >
              {(() => {
                const m = MODE_LABELS[activeSession.modeId ?? ""] ?? MODE_LABELS[MODE_CYCLE[0]!]!;
                return `${m.icon} ${m.short}`;
              })()}
              <span className="mode-selector-arrow">▲</span>
            </button>
            {showModeMenu && (
              <div className="mode-selector-menu">
                {MODE_CYCLE.map((modeId) => {
                  const m = MODE_LABELS[modeId]!;
                  const isActive = (activeSession.modeId ?? MODE_CYCLE[0]) === modeId;
                  return (
                    <button
                      key={modeId}
                      className={`mode-selector-option${isActive ? " active" : ""}`}
                      onClick={() => {
                        send({ type: "chat:set-mode", sessionId: activeSession.id, mode: modeId });
                        setShowModeMenu(false);
                      }}
                    >
                      {m.icon} {m.short}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <span className="mode-hint">Shift+Tab</span>
        </div>
      )}
    </div>
  );
}
