import { useState, useRef, useEffect } from "react";
import { useDashboardStore } from "../store";
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

export function SidePanel() {
  const activeChatId = useDashboardStore((s) => s.activeChatId);
  const chatSessions = useDashboardStore((s) => s.chatSessions);
  const generalChatId = useDashboardStore((s) => s.generalChatId);
  const chatMessages = useDashboardStore((s) => s.chatMessages);
  const chatStreaming = useDashboardStore((s) => s.chatStreaming);
  const chatThinking = useDashboardStore((s) => s.chatThinking);
  const chatToolCalls = useDashboardStore((s) => s.chatToolCalls);
  const chatUsage = useDashboardStore((s) => s.chatUsage);
  const sidePanelRole = useDashboardStore((s) => s.sidePanelRole);
  const send = useDashboardStore((s) => s.send);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeMessages = activeChatId ? chatMessages[activeChatId] ?? [] : [];
  const streaming = activeChatId ? chatStreaming[activeChatId] : undefined;
  const thinking = activeChatId ? chatThinking[activeChatId] : undefined;
  const toolCalls = activeChatId ? chatToolCalls[activeChatId] : undefined;
  const usage = activeChatId ? chatUsage[activeChatId] : undefined;
  const activeSession = chatSessions.find((s) => s.id === activeChatId);
  const isLoading = !activeSession && activeChatId !== "__global__" && activeChatId !== null;

  const role = activeSession?.role ?? sidePanelRole ?? "agent";
  const meta = ROLE_META[role] ?? { icon: "🤖", label: role };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages, streaming, thinking, toolCalls]);

  const handleClosePanel = () => {
    useDashboardStore.setState({ chatPanelOpen: false });
  };

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
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

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
        <button className="btn btn-small side-panel-close" onClick={handleClosePanel} title="Hide panel">◀</button>
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
                <span className="chat-tool-title">{tc.title}</span>
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

      <div className="side-panel-input-row">
        <textarea
          className="side-panel-input"
          placeholder="Ask something… (Enter to send, Shift+Enter for new line)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          autoFocus
        />
        <button className="btn btn-primary btn-small" onClick={handleSend}>
          Send
        </button>
      </div>
    </div>
  );
}
