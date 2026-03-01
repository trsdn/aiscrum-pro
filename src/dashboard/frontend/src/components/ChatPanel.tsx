import { useState, useRef, useEffect } from "react";
import { useDashboardStore } from "../store";
import { Markdown } from "./Markdown";
import "./ChatPanel.css";

export function ChatPanel() {
  const chatSessions = useDashboardStore((s) => s.chatSessions);
  const activeChatId = useDashboardStore((s) => s.activeChatId);
  const chatMessages = useDashboardStore((s) => s.chatMessages);
  const chatStreaming = useDashboardStore((s) => s.chatStreaming);
  const send = useDashboardStore((s) => s.send);

  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [role, setRole] = useState("general");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeMessages = activeChatId ? chatMessages[activeChatId] ?? [] : [];
  const streaming = activeChatId ? chatStreaming[activeChatId] : undefined;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeMessages, streaming]);

  const handleSend = () => {
    if (!input.trim()) return;
    if (!activeChatId) {
      send({ type: "chat:create", role });
    }
    // Wait a tick for session creation, then send
    setTimeout(() => {
      const store = useDashboardStore.getState();
      const chatId = store.activeChatId;
      if (chatId) {
        send({ type: "chat:send", sessionId: chatId, message: input.trim() });
        // Optimistically add user message
        const msgs = store.chatMessages[chatId] ?? [];
        useDashboardStore.setState({
          chatMessages: {
            ...store.chatMessages,
            [chatId]: [...msgs, { role: "user", content: input.trim() }],
          },
        });
      }
    }, activeChatId ? 0 : 500);
    setInput("");
  };

  return (
    <>
      <button className="chat-toggle" onClick={() => setIsOpen(!isOpen)}>
        💬 {isOpen ? "Close" : "Chat"}
      </button>

      {isOpen && (
        <div className="chat-panel">
          <div className="chat-header">
            <span>💬 Chat</span>
            <div className="chat-tabs">
              {chatSessions.map((s) => (
                <button
                  key={s.id}
                  className={`chat-tab ${s.id === activeChatId ? "chat-tab-active" : ""}`}
                  onClick={() => useDashboardStore.setState({ activeChatId: s.id })}
                >
                  {s.role}
                </button>
              ))}
            </div>
            {!activeChatId && (
              <select
                className="btn btn-small"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="general">General</option>
                <option value="code-review">Code Review</option>
                <option value="planner">Planner</option>
                <option value="challenger">Challenger</option>
              </select>
            )}
          </div>

          <div className="chat-messages">
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

          <div className="chat-input-row">
            <input
              className="chat-input"
              placeholder="Ask something..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
            />
            <button className="btn btn-primary btn-small" onClick={handleSend}>
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
