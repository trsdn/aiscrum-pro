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

export interface DashboardStore {
  // Connection
  connected: boolean;

  // Sprint
  state: SprintState;
  issues: SprintIssue[];
  activeSprintNumber: number;
  viewingSprintNumber: number;
  availableSprints: { sprintNumber: number }[];
  repoUrl: string | null;

  // Activities & logs
  activities: Activity[];
  logs: LogEntry[];

  // Sessions
  acpSessions: AcpSession[];
  viewingSessionId: string | null;
  sessionOutput: Map<string, string>;

  // Chat
  chatSessions: ChatSession[];
  activeChatId: string | null;
  chatMessages: Record<string, ChatMessage[]>;
  chatStreaming: Record<string, string>;

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
const pendingMessages: ClientMessage[] = [];

// Sprint caches (survive navigation between sprints)
const stateCache = new Map<number, { state: SprintState; issues: SprintIssue[] }>();
const activityCache = new Map<number, Activity[]>();

function createWebSocket(set: SetFn, get: GetFn): void {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    set({ connected: true });
    while (pendingMessages.length > 0) {
      const msg = pendingMessages.shift();
      if (msg) ws?.send(JSON.stringify(msg));
    }
  };

  ws.onclose = () => {
    set({ connected: false });
    ws = null;
    setTimeout(() => createWebSocket(set, get), 2000);
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
      const p = msg.payload as ChatSession | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatSessions: [...prev.chatSessions, p],
          activeChatId: p.id,
          chatMessages: { ...prev.chatMessages, [p.id]: [] },
        }));
      }
      break;
    }

    case "chat:chunk": {
      const p = msg.payload as { sessionId: string; text: string } | undefined;
      if (p) {
        set((prev) => ({
          ...prev,
          chatStreaming: {
            ...prev.chatStreaming,
            [p.sessionId]: (prev.chatStreaming[p.sessionId] ?? "") + p.text,
          },
        }));
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
          delete streaming[p.sessionId];
          return {
            ...prev,
            chatMessages: {
              ...prev.chatMessages,
              [p.sessionId]: [
                ...msgs,
                { role: "assistant", content: p.response },
              ],
            },
            chatStreaming: streaming,
          };
        });
      }
      break;
    }

    case "chat:error": {
      const p = msg.payload as {
        sessionId: string;
        error: string;
      } | undefined;
      if (p) {
        set((prev) => {
          const msgs = prev.chatMessages[p.sessionId] ?? [];
          const streaming = { ...prev.chatStreaming };
          delete streaming[p.sessionId];
          return {
            ...prev,
            chatMessages: {
              ...prev.chatMessages,
              [p.sessionId]: [
                ...msgs,
                { role: "system", content: `Error: ${p.error}` },
              ],
            },
            chatStreaming: streaming,
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
  chatMessages: {},
  chatStreaming: {},
  executionMode: "autonomous",
  sprintLimit: 0,
  backlogPending: new Set<number>(),
  backlogPlanned: new Set<number>(),

  // Actions
  send: (msg: ClientMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      pendingMessages.push(msg);
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
      .then((d: { sprintNumber: number }[]) => {
        if (Array.isArray(d)) set({ availableSprints: d });
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
      Promise.all([
        fetch(`/api/sprints/${n}/state`).then((r) => (r.ok ? r.json() : null)),
        fetch(`/api/sprints/${n}/issues`).then((r) => (r.ok ? r.json() : null)),
      ])
        .then(([stateData, issuesData]) => {
          if (stateData) {
            const s = stateData as SprintState;
            const iss = Array.isArray(issuesData) ? (issuesData as SprintIssue[]) : [];
            stateCache.set(n, { state: s, issues: iss });
            // Only update if still viewing this sprint
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
      .then((d: { sprintNumber: number }[]) => {
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
