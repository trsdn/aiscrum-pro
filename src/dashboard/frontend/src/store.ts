import { create } from "zustand";
import type {
  SprintState,
  SprintIssue,
  AcpSession,
  ChatSession,
  ChatMessage,
  ClientMessage,
  ServerMessage,
} from "./types";
import { notifySprintEvent } from "./notifications";

export interface ChatToolCall {
  toolCallId: string;
  title: string;
  status?: string;
  kind?: string;
  locations?: Array<{ path: string; line?: number }>;
}

export interface ChatPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface ChatCommand {
  name: string;
  description: string;
  hint?: string;
}

export interface ChatConfigOption {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: Array<{ value: string; name: string }>;
}

export interface DashboardStore {
  // Connection
  connected: boolean;

  // Sprint
  state: SprintState;
  issues: SprintIssue[];
  activeSprintNumber: number;
  viewingSprintNumber: number;
  availableSprints: { sprintNumber: number; milestoneNumber?: number }[];
  repoUrl: string | null;

  // Activities & logs
  activities: Activity[];
  logs: LogEntry[];

  // Sessions
  acpSessions: AcpSession[];
  viewingSessionId: string | null;
  sessionOutput: Map<string, string>;

  // Chat / Side panel
  chatSessions: ChatSession[];
  activeChatId: string | null;
  generalChatId: string | null;
  chatMessages: Record<string, ChatMessage[]>;
  chatStreaming: Record<string, string>;
  chatThinking: Record<string, string>;
  chatToolCalls: Record<string, ChatToolCall[]>;
  chatUsage: Record<string, { used: number; size: number }>;
  chatPlan: Record<string, ChatPlanEntry[]>;
  chatCommands: Record<string, ChatCommand[]>;
  chatConfig: Record<string, ChatConfigOption[]>;
  chatPanelOpen: boolean;
  sidePanelRole: string | null;
  pendingChatMessage: string | null;

  // Execution mode
  executionMode: "autonomous" | "hitl";
  sprintLimit: number; // 0 = infinite

  // Backlog planning feedback
  backlogPending: Set<number>;   // currently being added
  backlogPlanned: Set<number>;   // confirmed added (hide from list)

  // Actions
  send: (msg: ClientMessage) => void;
  connect: () => void;
  disconnect: () => void;

  // Sprint actions
  setViewingSprint: (n: number) => void;

  // Session viewer
  openSession: (id: string) => void;
  closeSession: () => void;
}

export interface Activity {
  type: string;
  label: string;
  detail?: string | null;
  status: "active" | "done" | "failed";
  time: Date;
  elapsed?: number;
}

export interface LogEntry {
  level: string;
  message: string;
  time: Date;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const pendingMessages: ClientMessage[] = [];
let pendingGeneralCreate = false;

// Sprint caches (survive navigation between sprints)
const stateCache = new Map<number, { state: SprintState; issues: SprintIssue[] }>();
const activityCache = new Map<number, Activity[]>();
let sprintFetchVersion = 0;

function createWebSocket(set: SetFn, get: GetFn): void {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    set({ connected: true });
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      if (msg) ws?.send(JSON.stringify(msg));
    }
    // Auto-create persistent general session if none exists
    if (!get().generalChatId) {
      pendingGeneralCreate = true;
      ws?.send(JSON.stringify({ type: "chat:create", role: "general" }));
    }
  };

  ws.onclose = () => {
    set({
      connected: false,
      chatSessions: [],
      activeChatId: null,
      generalChatId: null,
      chatMessages: {},
      chatStreaming: {},
      chatThinking: {},
      chatToolCalls: {},
      chatUsage: {},
      chatPlan: {},
      chatCommands: {},
      chatConfig: {},
    });
    ws = null;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; createWebSocket(set, get); }, 2000);
  };

  ws.onmessage = (event) => {
    try {
      const msg: ServerMessage = JSON.parse(event.data);
      handleMessage(msg, set, get);
    } catch {
      /* ignore malformed */
    }
  };
}

type SetFn = (
  partial:
    | Partial<DashboardStore>
    | ((state: DashboardStore) => Partial<DashboardStore>),
) => void;
type GetFn = () => DashboardStore;

function handleMessage(msg: ServerMessage, set: SetFn, get: GetFn): void {
  switch (msg.type) {
    case "sprint:state": {
      const payload = msg.payload as SprintState;
      const activeSprintNumber = payload.sprintNumber;
      const store = get();
      const viewingSprintNumber =
        store.viewingSprintNumber === 0
          ? activeSprintNumber
          : store.viewingSprintNumber;
      set({
        state: payload,
        activeSprintNumber,
        viewingSprintNumber,
      });
      break;
    }

    case "sprint:issues":
      set({ issues: (msg.payload as SprintIssue[]) || [] });
      break;

    case "sprint:switched": {
      const p = msg.payload as { activeSprintNumber?: number } | undefined;
      if (p?.activeSprintNumber) {
        set({ activeSprintNumber: p.activeSprintNumber });
      }
      break;
    }

    case "sprint:event":
      handleSprintEvent(msg.eventName ?? "", msg.payload, set, get);
      break;

    case "session:list":
      set({ acpSessions: (msg.payload as AcpSession[]) || [] });
      break;

    case "session:output": {
      const p = msg.payload as { sessionId: string; text: string } | undefined;
      if (p) {
        const store = get();
        const output = new Map(store.sessionOutput);
        output.set(p.sessionId, (output.get(p.sessionId) ?? "") + p.text);
        set({ sessionOutput: output });
      }
      break;
    }

    case "session:status": {
      const p = msg.payload as {
        sessionId: string;
        action: string;
        message?: string;
      } | undefined;
      if (p) {
        const store = get();
        const output = new Map(store.sessionOutput);
        const marker = `\n--- ${p.action}${p.message ? ": " + p.message : ""} ---\n`;
        output.set(p.sessionId, (output.get(p.sessionId) ?? "") + marker);
        set({ sessionOutput: output });
      }
      break;
    }

    case "chat:created": {
      const raw = msg.payload as { sessionId: string; role: string; model?: string } | undefined;
      if (raw) {
        const p: ChatSession = { id: raw.sessionId, role: raw.role, model: raw.model };

        // Background general session — store silently, don't open panel
        if (pendingGeneralCreate && raw.role === "general") {
          pendingGeneralCreate = false;
          set((prev) => ({
            ...prev,
            chatSessions: [...prev.chatSessions, p],
            generalChatId: p.id,
            chatMessages: { ...prev.chatMessages, [p.id]: [] },
          }));
          break;
        }

        const pending = get().pendingChatMessage;
        const initialMessages: ChatMessage[] = pending
          ? [{ role: "user", content: pending }]
          : [];
        set((prev) => ({
          ...prev,
          chatSessions: [...prev.chatSessions, p],
          activeChatId: p.id,
          chatMessages: { ...prev.chatMessages, [p.id]: initialMessages },
          pendingChatMessage: null,
        }));
        // Auto-send the pending message to the agent
        if (pending) {
          const sendFn = get().send;
          sendFn({ type: "chat:send", sessionId: p.id, message: pending });
        }
      }
      break;
    }

    case "chat:chunk": {
      const p = msg.payload as { sessionId: string; text: string } | undefined;
      if (p) {
        set((prev) => {
          const current = prev.chatStreaming[p.sessionId] ?? "";
          const updated = current + p.text;
          return {
            ...prev,
            chatStreaming: {
              ...prev.chatStreaming,
              [p.sessionId]: current === "" ? updated.trimStart() : updated,
            },
          };
        });
      }
      break;
    }

    case "chat:done": {
      const p = msg.payload as {
        sessionId: string;
        response: string;
      } | undefined;
      if (p) {
        set((prev) => {
          const msgs = prev.chatMessages[p.sessionId] ?? [];
          const streaming = { ...prev.chatStreaming };
          const thinking = { ...prev.chatThinking };
          const toolCalls = { ...prev.chatToolCalls };
          delete streaming[p.sessionId];
          delete thinking[p.sessionId];
          delete toolCalls[p.sessionId];
          return {
            ...prev,
            chatMessages: {
              ...prev.chatMessages,
              [p.sessionId]: [
                ...msgs,
                { role: "assistant", content: p.response.trimStart() },
              ],
            },
            chatStreaming: streaming,
            chatThinking: thinking,
            chatToolCalls: toolCalls,
          };
        });
      }
      break;
    }

    case "chat:thinking": {
      const p = msg.payload as { sessionId: string; text: string } | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatThinking: {
            ...prev.chatThinking,
            [p.sessionId]: (prev.chatThinking[p.sessionId] ?? "") + p.text,
          },
        }));
      }
      break;
    }

    case "chat:tool-call": {
      const p = msg.payload as {
        sessionId: string;
        toolCallId: string;
        title?: string;
        status?: string;
        kind?: string;
        locations?: Array<{ uri?: string; path?: string; line?: number }>;
      } | undefined;
      if (p) {
        set((prev) => {
          const existing = prev.chatToolCalls[p.sessionId] ?? [];
          const idx = existing.findIndex((t) => t.toolCallId === p.toolCallId);
          const prev_entry = idx >= 0 ? existing[idx] : undefined;
          const locs = p.locations?.map((l) => ({
            path: l.path ?? l.uri?.replace("file://", "") ?? "",
            line: l.line,
          }));
          const entry: ChatToolCall = {
            toolCallId: p.toolCallId,
            title: p.title || prev_entry?.title || "",
            status: p.status ?? prev_entry?.status,
            kind: p.kind ?? prev_entry?.kind,
            locations: locs ?? prev_entry?.locations,
          };
          const updated = idx >= 0
            ? existing.map((t, i) => (i === idx ? entry : t))
            : [...existing, entry];
          return {
            ...prev,
            chatToolCalls: { ...prev.chatToolCalls, [p.sessionId]: updated },
          };
        });
      }
      break;
    }

    case "chat:usage": {
      const p = msg.payload as {
        sessionId: string;
        used: number;
        size: number;
      } | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatUsage: { ...prev.chatUsage, [p.sessionId]: { used: p.used, size: p.size } },
        }));
      }
      break;
    }

    case "chat:mode": {
      const p = msg.payload as { sessionId: string; modeId: string } | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatSessions: prev.chatSessions.map((s) =>
            s.id === p.sessionId ? { ...s, modeId: p.modeId } : s,
          ),
        }));
      }
      break;
    }

    case "chat:plan": {
      const p = msg.payload as { sessionId: string; entries: ChatPlanEntry[] } | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatPlan: { ...prev.chatPlan, [p.sessionId]: p.entries },
        }));
      }
      break;
    }

    case "chat:commands": {
      const p = msg.payload as { sessionId: string; commands: ChatCommand[] } | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatCommands: { ...prev.chatCommands, [p.sessionId]: p.commands },
        }));
      }
      break;
    }

    case "chat:config": {
      const p = msg.payload as { sessionId: string; configs: ChatConfigOption[] } | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatConfig: { ...prev.chatConfig, [p.sessionId]: p.configs },
        }));
      }
      break;
    }

    case "chat:error": {
      const p = msg.payload as {
        sessionId?: string;
        error: string;
      } | undefined;
      if (p) {
        const sid = p.sessionId ?? "__global__";
        set((prev) => {
          const msgs = prev.chatMessages[sid] ?? [];
          const streaming = { ...prev.chatStreaming };
          delete streaming[sid];
          return {
            ...prev,
            chatMessages: {
              ...prev.chatMessages,
              [sid]: [
                ...msgs,
                { role: "system", content: `Error: ${p.error}` },
              ],
            },
            chatStreaming: streaming,
            // Show error in side panel even if no session was created
            ...(!p.sessionId ? { activeChatId: sid, chatPanelOpen: true } : {}),
          };
        });
      }
      break;
    }

    case "backlog:planned": {
      const p = msg.payload as { issueNumber: number } | undefined;
      if (p) {
        const store = get();
        const pendNext = new Set(store.backlogPending);
        pendNext.delete(p.issueNumber);
        const plannedNext = new Set(store.backlogPlanned);
        plannedNext.add(p.issueNumber);
        set({ backlogPending: pendNext, backlogPlanned: plannedNext });
        addActivity(set, store, "backlog", `#${p.issueNumber} added to sprint`, null, "done");
      }
      break;
    }

    case "backlog:removed": {
      const p = msg.payload as { issueNumber: number } | undefined;
      if (p) {
        const store = get();
        addActivity(set, store, "backlog", `#${p.issueNumber} removed from sprint`, null, "done");
      }
      break;
    }

    case "backlog:error": {
      const p = msg.payload as { issueNumber?: number; error: string } | undefined;
      if (p) {
        const store = get();
        if (p.issueNumber) {
          const next = new Set(store.backlogPending);
          next.delete(p.issueNumber);
          set({ backlogPending: next });
        }
        addActivity(set, store, "error", `Backlog error: ${p.error}`, null, "failed");
      }
      break;
    }
  }
}

function handleSprintEvent(
  name: string,
  payload: unknown,
  set: SetFn,
  get: GetFn,
): void {
  const p = payload as Record<string, unknown> | undefined;
  const store = get();

  // Trigger browser notification (only when tab is hidden)
  notifySprintEvent(name, p);

  switch (name) {
    case "sprint:start":
      set({
        activities: [],
        state: {
          ...store.state,
          sprintNumber: (p?.sprintNumber as number) ?? store.state.sprintNumber,
          phase: "plan",
          startedAt: new Date().toISOString(),
        },
        activeSprintNumber: (p?.sprintNumber as number) ?? store.activeSprintNumber,
        viewingSprintNumber: (p?.sprintNumber as number) ?? store.viewingSprintNumber,
      });
      addActivity(set, get(), "sprint", `Sprint ${p?.sprintNumber} started`, null, "active");
      break;

    case "phase:change":
      set((prev) => ({ ...prev, state: { ...prev.state, phase: p?.to as string } }));
      addActivity(set, get(), "phase", `Phase: ${p?.to}`, (p?.agent as string) ?? null, "active");
      break;

    case "sprint:planned": {
      const issues = (p?.issues as Array<{ number: number; title: string }>) ?? [];
      addActivity(set, get(), "plan", `Planned ${issues.length} issues`, null, "done");
      break;
    }

    case "issue:start": {
      const issue = p?.issue as Record<string, unknown> | undefined;
      const num = issue?.number ?? p?.issueNumber;
      const model = (p?.model as string) ?? null;
      if (num != null) {
        // Update issue status to in-progress
        const issues = get().issues.map((i) =>
          i.number === Number(num) ? { ...i, status: "in-progress" } : i,
        );
        set({ issues });
      }
      addActivity(set, get(), "issue", `#${num} started`, model, "active");
      break;
    }

    case "issue:progress": {
      const issues = get().issues.map((i) =>
        i.number === (p?.issueNumber as number) ? { ...i, step: p?.step as string } : i,
      );
      set({ issues });
      break;
    }

    case "issue:done": {
      const doneNum = p?.issueNumber as number | undefined;
      if (doneNum != null) {
        const issues = get().issues.map((i) =>
          i.number === doneNum
            ? { ...i, status: "done", duration_ms: p?.duration_ms as number }
            : i,
        );
        set({ issues });
      }
      addActivity(set, get(), "issue", `#${doneNum} done`, null, "done");
      break;
    }

    case "issue:fail": {
      const failNum = p?.issueNumber as number | undefined;
      if (failNum != null) {
        const issues = get().issues.map((i) =>
          i.number === failNum
            ? { ...i, status: "failed", failReason: p?.reason as string }
            : i,
        );
        set({ issues });
      }
      addActivity(set, get(), "issue", `#${failNum} failed`, p?.reason as string, "failed");
      break;
    }

    case "sprint:complete":
      set((prev) => ({ ...prev, state: { ...prev.state, phase: "complete" } }));
      addActivity(set, get(), "sprint", "Sprint complete", null, "done");
      break;

    case "sprint:error":
      set((prev) => ({ ...prev, state: { ...prev.state, phase: "failed" } }));
      addActivity(set, get(), "error", `Sprint error: ${p?.error}`, null, "failed");
      break;

    case "log":
      set((prev) => ({
        ...prev,
        logs: [
          ...prev.logs,
          { level: (p?.level as string) ?? "info", message: (p?.message as string) ?? "", time: new Date() },
        ],
      }));
      break;

    case "mode:changed":
      if (p?.mode === "autonomous" || p?.mode === "hitl") {
        set({ executionMode: p.mode });
      }
      break;

    case "sprint:limit-changed":
      if (typeof p?.limit === "number") {
        set({ sprintLimit: p.limit });
      }
      break;

    case "decisions:approved":
    case "decisions:rejected":
    case "decisions:commented":
      // Handled by component-level refetch
      break;
  }
}

function addActivity(
  set: SetFn,
  store: DashboardStore,
  type: string,
  label: string,
  detail: string | null,
  status: Activity["status"],
): void {
  const activities = store.activities.map((a) =>
    a.status === "active" && a.type === type ? { ...a, status: "done" as const } : a,
  );
  activities.push({ type, label, detail, status, time: new Date() });
  set({ activities });
}

export const useDashboardStore = create<DashboardStore>()((set, get) => ({
  // Initial state
  connected: false,
  state: { phase: "init", sprintNumber: 0 },
  issues: [],
  activeSprintNumber: 0,
  viewingSprintNumber: 0,
  availableSprints: [],
  repoUrl: null,
  activities: [],
  logs: [],
  acpSessions: [],
  viewingSessionId: null,
  sessionOutput: new Map(),
  chatSessions: [],
  activeChatId: null,
  generalChatId: null,
  chatMessages: {},
  chatStreaming: {},
  chatThinking: {},
  chatToolCalls: {},
  chatUsage: {},
  chatPlan: {},
  chatCommands: {},
  chatConfig: {},
  chatPanelOpen: false,
  sidePanelRole: null,
  pendingChatMessage: null,
  executionMode: "autonomous",
  sprintLimit: 0,
  backlogPending: new Set<number>(),
  backlogPlanned: new Set<number>(),

  // Actions
  send: (msg: ClientMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      if (pendingMessages.length < 100) pendingMessages.push(msg);
    }
  },

  connect: () => {
    if (!ws) createWebSocket(set, get);
    // Fetch repo URL + sprint list
    fetch("/api/repo")
      .then((r) => r.json())
      .then((d: { url?: string }) => set({ repoUrl: d.url ?? null }))
      .catch(() => {});
    fetch("/api/sprints")
      .then((r) => r.json())
      .then((d: { sprintNumber: number; milestoneNumber?: number }[]) => {
        if (Array.isArray(d)) {
          set({ availableSprints: d });
          // Auto-navigate to latest sprint if none is active
          const store = get();
          if (store.viewingSprintNumber === 0 && d.length > 0) {
            const latest = Math.max(...d.map((s) => s.sprintNumber));
            store.setViewingSprint(latest);
          }
        }
      })
      .catch(() => {});
  },

  disconnect: () => {
    ws?.close();
    ws = null;
  },

  setViewingSprint: (n: number) => {
    if (n < 1) return;
    const store = get();

    // Save current sprint to cache before switching
    if (store.viewingSprintNumber > 0) {
      stateCache.set(store.viewingSprintNumber, {
        state: { ...store.state },
        issues: [...store.issues],
      });
      activityCache.set(store.viewingSprintNumber, [...store.activities]);
    }

    const isActive = n === store.activeSprintNumber;
    set({ viewingSprintNumber: n });

    // Check cache first
    const cached = stateCache.get(n);
    const cachedAct = activityCache.get(n);
    if (cached) {
      set({
        state: { ...cached.state },
        issues: [...cached.issues],
        activities: cachedAct ? [...cachedAct] : [],
      });
    }

    if (isActive) {
      // Request fresh state from server
      store.send({ type: "sprint:switch", sprintNumber: n });
    } else if (!cached) {
      // Historical sprint — load from API
      const fetchId = ++sprintFetchVersion;
      Promise.all([
        fetch(`/api/sprints/${n}/state`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/sprints/${n}/issues`).then((r) => (r.ok ? r.json() : null)),
      ])
        .then(([stateData, issuesData]) => {
          if (stateData && fetchId === sprintFetchVersion) {
            const s = stateData as SprintState;
            const iss = Array.isArray(issuesData) ? (issuesData as SprintIssue[]) : [];
            stateCache.set(n, { state: s, issues: iss });
            if (get().viewingSprintNumber === n) {
              set({ state: s, issues: iss });
            }
          }
        })
        .catch(() => {});
    }

    // Refresh sprint list
    fetch("/api/sprints")
      .then((r) => r.json())
      .then((d: { sprintNumber: number; milestoneNumber?: number }[]) => {
        if (Array.isArray(d)) set({ availableSprints: d });
      })
      .catch(() => {});
  },

  openSession: (id: string) => {
    set({ viewingSessionId: id });
    const store = get();
    store.send({ type: "session:subscribe", sessionId: id });
  },

  closeSession: () => {
    const store = get();
    if (store.viewingSessionId) {
      store.send({ type: "session:unsubscribe", sessionId: store.viewingSessionId });
    }
    set({ viewingSessionId: null });
  },
}));
