import { useState, useRef, useEffect } from "react";
import { useDashboardStore } from "../store";
import { Markdown } from "./Markdown";
import "./SidePanel.css";

export function SidePanel() {
  const chatSessions = useDashboardStore((s) => s.chatSessions);
  const activeChatId = useDashboardStore((s) => s.activeChatId);
  const chatMessages = useDashboardStore((s) => s.chatMessages);
  const chatStreaming = useDashboardStore((s) => s.chatStreaming);
  const send = useDashboardStore((s) => s.send);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeMessages = activeChatId ? chatMessages[activeChatId] ?? [] : [];
  const streaming = activeChatId ? chatStreaming[activeChatId] : undefined;
  const activeSession = chatSessions.find((s) => s.id === activeChatId);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages, streaming]);

  const handleClose = () => {
    if (activeChatId) {
      send({ type: "chat:close", sessionId: activeChatId });
    }
    useDashboardStore.setState({ chatPanelOpen: false, activeChatId: null });
  };

  const handleSend = () => {
    if (!input.trim() || !activeChatId) return;
    send({ type: "chat:send", sessionId: activeChatId, message: input.trim() });
    const store = useDashboardStore.getState();
    const msgs = store.chatMessages[activeChatId] ?? [];
    useDashboardStore.setState({
      chatMessages: {
        ...store.chatMessages,
        [activeChatId]: [...msgs, { role: "user", content: input.trim() }],
      },
    });
    setInput("");
  };

  return (
    <div className="side-panel">
      <div className="side-panel-header">
        <span className="side-panel-title">
          🔬 {activeSession?.role ?? "Session"}
        </span>
        {chatSessions.length > 1 && (
          <div className="side-panel-tabs">
            {chatSessions.map((s) => (
              <button
                key={s.id}
                className={`side-panel-tab ${s.id === activeChatId ? "side-panel-tab-active" : ""}`}
                onClick={() => useDashboardStore.setState({ activeChatId: s.id })}
              >
                {s.role}
              </button>
            ))}
          </div>
        )}
        <button className="btn btn-small side-panel-close" onClick={handleClose}>✕</button>
      </div>

      <div className="side-panel-messages">
        {activeMessages.length === 0 && !streaming && (
          <div className="side-panel-empty">
            Session ready. Send a message to start.
          </div>
        )}
        {activeMessages.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            <span className="chat-role">{m.role}</span>
            <div className="chat-content"><Markdown text={m.content} /></div>
          </div>
        ))}
        {streaming && (
          <div className="chat-msg chat-assistant">
            <span className="chat-role">assistant</span>
            <div className="chat-content chat-streaming">{streaming}▌</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="side-panel-input-row">
        <input
          className="side-panel-input"
          placeholder="Ask something..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          autoFocus
        />
        <button className="btn btn-primary btn-small" onClick={handleSend}>
          Send
        </button>
      </div>
    </div>
  );
}
