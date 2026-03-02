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
  const chatMessages = useDashboardStore((s) => s.chatMessages);
  const chatStreaming = useDashboardStore((s) => s.chatStreaming);
  const sidePanelRole = useDashboardStore((s) => s.sidePanelRole);
  const send = useDashboardStore((s) => s.send);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeMessages = activeChatId ? chatMessages[activeChatId] ?? [] : [];
  const streaming = activeChatId ? chatStreaming[activeChatId] : undefined;
  const activeSession = chatSessions.find((s) => s.id === activeChatId);
  const isLoading = !activeSession && activeChatId !== "__global__";

  const role = activeSession?.role ?? sidePanelRole ?? "agent";
  const meta = ROLE_META[role] ?? { icon: "🤖", label: role };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages, streaming]);

  const handleClose = () => {
    const store = useDashboardStore.getState();
    // Don't kill the persistent general session — just hide the panel
    if (activeChatId && activeChatId !== "__global__" && activeChatId !== store.generalChatId) {
      send({ type: "chat:close", sessionId: activeChatId });
    }
    useDashboardStore.setState({ chatPanelOpen: false, activeChatId: null });
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
      <div className="side-panel-header">
        <span className="side-panel-title">
          {meta.icon} {meta.label}
        </span>
        {isLoading && <span className="side-panel-status loading">Connecting…</span>}
        {activeSession && <span className="side-panel-status connected">● Connected</span>}
        {activeSession?.model && (
          <span className="side-panel-model">{activeSession.model}</span>
        )}
        <button className="btn btn-small side-panel-close" onClick={handleClose}>✕</button>
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
        {streaming && (
          <div className="chat-msg chat-assistant">
            <span className="chat-role">{meta.label}</span>
            <div className="chat-content chat-streaming">{streaming}▌</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

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
