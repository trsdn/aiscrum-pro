import { useEffect, useState } from "react";
import { useDashboardStore } from "./store";
import { Header } from "./components/Header";
import { SprintTab } from "./components/SprintTab";
import { SprintBacklogTab } from "./components/SprintBacklogTab";
import { BacklogTab, BlockedTab, DecisionsTab, IdeasTab } from "./components/Tabs";
import { ChatPanel } from "./components/ChatPanel";
import "./index.css";

type Tab = "sprint" | "sprint-backlog" | "backlog" | "blocked" | "decisions" | "ideas";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "sprint", label: "Sprint", icon: "🏃" },
  { id: "sprint-backlog", label: "Sprint Backlog", icon: "📦" },
  { id: "backlog", label: "Backlog", icon: "📋" },
  { id: "blocked", label: "Blocked", icon: "🚧" },
  { id: "decisions", label: "Decisions", icon: "⚖️" },
  { id: "ideas", label: "Ideas", icon: "💡" },
];

export default function App() {
  const connect = useDashboardStore((s) => s.connect);
  const [activeTab, setActiveTab] = useState<Tab>("sprint");

  useEffect(() => {
    connect();
  }, [connect]);

  return (
    <>
      <Header />
      <nav className="tab-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab-btn ${activeTab === t.id ? "tab-active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </nav>
      {activeTab === "sprint" && <SprintTab />}
      {activeTab === "sprint-backlog" && <SprintBacklogTab />}
      {activeTab === "backlog" && <BacklogTab />}
      {activeTab === "blocked" && <BlockedTab />}
      {activeTab === "decisions" && <DecisionsTab />}
      {activeTab === "ideas" && <IdeasTab />}
      <ChatPanel />
    </>
  );
}
