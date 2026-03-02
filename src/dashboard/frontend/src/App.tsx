import { useEffect, useState, useCallback, useRef } from "react";
import { useDashboardStore } from "./store";
import { Header } from "./components/Header";
import { SprintTab } from "./components/SprintTab";
import { SprintBacklogTab } from "./components/SprintBacklogTab";
import { BacklogTab, BlockedTab, DecisionsTab, IdeasTab } from "./components/Tabs";
import { SidePanel } from "./components/SidePanel";
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

const MIN_SIDE_WIDTH = 320;
const MAX_SIDE_WIDTH = 800;
const DEFAULT_SIDE_WIDTH = 420;

export default function App() {
  const connect = useDashboardStore((s) => s.connect);
  const chatPanelOpen = useDashboardStore((s) => s.chatPanelOpen);
  const [activeTab, setActiveTab] = useState<Tab>("sprint");
  const [sideWidth, setSideWidth] = useState(DEFAULT_SIDE_WIDTH);
  const dragging = useRef(false);

  useEffect(() => {
    connect();
  }, [connect]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = window.innerWidth - ev.clientX;
      setSideWidth(Math.max(MIN_SIDE_WIDTH, Math.min(MAX_SIDE_WIDTH, newWidth)));
    };
    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

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
      <div className="app-layout">
        <div className="app-main">
          {activeTab === "sprint" && <SprintTab />}
          {activeTab === "sprint-backlog" && <SprintBacklogTab />}
          {activeTab === "backlog" && <BacklogTab />}
          {activeTab === "blocked" && <BlockedTab />}
          {activeTab === "decisions" && <DecisionsTab />}
          {activeTab === "ideas" && <IdeasTab />}
        </div>
        {chatPanelOpen && (
          <>
            <div className="app-resize-handle" onMouseDown={onMouseDown} />
            <div className="app-side" style={{ width: sideWidth }}>
              <SidePanel />
            </div>
          </>
        )}
      </div>
    </>
  );
}
