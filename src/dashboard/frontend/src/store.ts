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
  availableSprints: { sprintNumber: number; milestoneNumber?: number; phase?: string }[];
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
  backlogPending: Set<number>; // currently being added
  backlogPlanned: Set<number>; // confirmed added (hide from list)

  // Heartbeat
  heartbeat: {
    healthy: boolean;
    staleLock: boolean;
    lastTickAt: string | null;
    staleWarning: boolean;
  };

  // Actions
  send: (msg: ClientMessage) => void;
  connect: () => void;
  disconnect: () => void;

  // Sprint actions
  setViewingSprint: (n: number) => void;
  refreshSprintIssues: () => void;

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
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
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
      activities: [],
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
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      createWebSocket(set, get);
    }, 2000);
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
  partial: Partial<DashboardStore> | ((state: DashboardStore) => Partial<DashboardStore>),
) => void;
type GetFn = () => DashboardStore;

function handleMessage(msg: ServerMessage, set: SetFn, get: GetFn): void {
  switch (msg.type) {
    case "sprint:state": {
      const payload = msg.payload as SprintState;
      const activeSprintNumber = payload.sprintNumber;
      const store = get();
      const viewingSprintNumber =
        store.viewingSprintNumber === 0 ? activeSprintNumber : store.viewingSprintNumber;
      set({
        state: payload,
        activeSprintNumber,
        viewingSprintNumber,
      });
      break;
    }

    case "sprint:issues": {
      const incoming = (msg.payload as SprintIssue[]) || [];
      const current = get().issues;
      // Preserve runtime status/step/failReason from existing issues
      const statusMap = new Map(current.map((i) => [i.number, i]));
      const runtimeStatuses = new Set(["in-progress", "done", "failed", "blocked"]);
      const merged = incoming.map((i) => {
        const prev = statusMap.get(i.number);
        // Preserve runtime status and associated fields if previous status is a runtime status
        if (prev && runtimeStatuses.has(prev.status)) {
          return { ...i, status: prev.status, step: prev.step, failReason: prev.failReason };
        }
        return i;
      });
      set({ issues: merged });
      break;
    }

    case "sprint:switched": {
      const p = msg.payload as { activeSprintNumber?: number } | undefined;
      if (p?.activeSprintNumber) {
        const store = get();
        // Auto-follow: if user is viewing the current active sprint (or 0 = auto),
        // switch viewing to the new active sprint so the dashboard follows along.
        const shouldFollow =
          store.viewingSprintNumber === 0 || store.viewingSprintNumber === store.activeSprintNumber;
        set({
          activeSprintNumber: p.activeSprintNumber,
          ...(shouldFollow ? { viewingSprintNumber: p.activeSprintNumber } : {}),
        });
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
      const p = msg.payload as
        | {
            sessionId: string;
            action: string;
            message?: string;
          }
        | undefined;
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
            activeChatId: prev.activeChatId ?? p.id,
            chatMessages: { ...prev.chatMessages, [p.id]: [] },
          }));
          break;
        }

        const pending = get().pendingChatMessage;
        const initialMessages: ChatMessage[] = pending ? [{ role: "user", content: pending }] : [];
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
      const p = msg.payload as
        | {
            sessionId: string;
            response: string;
          }
        | undefined;
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
              [p.sessionId]: [...msgs, { role: "assistant", content: p.response.trimStart() }],
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
      const p = msg.payload as
        | {
            sessionId: string;
            toolCallId: string;
            title?: string;
            status?: string;
            kind?: string;
            locations?: Array<{ uri?: string; path?: string; line?: number }>;
          }
        | undefined;
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
          const updated =
            idx >= 0 ? existing.map((t, i) => (i === idx ? entry : t)) : [...existing, entry];
          return {
            ...prev,
            chatToolCalls: { ...prev.chatToolCalls, [p.sessionId]: updated },
          };
        });
      }
      break;
    }

    case "chat:usage": {
      const p = msg.payload as
        | {
            sessionId: string;
            used: number;
            size: number;
          }
        | undefined;
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
      const p = msg.payload as
        | {
            sessionId?: string;
            error: string;
          }
        | undefined;
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
              [sid]: [...msgs, { role: "system", content: `Error: ${p.error}` }],
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

function handleSprintEvent(name: string, payload: unknown, set: SetFn, get: GetFn): void {
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
      addActivity(set, get(), "progress", `#${p?.issueNumber} → ${p?.step}`, null, "active");
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
          i.number === failNum ? { ...i, status: "failed", failReason: p?.reason as string } : i,
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

    case "sprint:stopped":
      set((prev) => ({ ...prev, state: { ...prev.state, phase: "stopped" } }));
      addActivity(set, get(), "sprint", "Sprint stopped by user", null, "done");
      break;

    case "sprint:cancelled": {
      const returned = Array.isArray(p?.returnedIssues) ? (p.returnedIssues as number[]) : [];
      set((prev) => ({ ...prev, state: { ...prev.state, phase: "cancelled" } }));
      addActivity(
        set,
        get(),
        "sprint",
        `Sprint cancelled — ${returned.length} issue(s) returned to backlog`,
        returned.length > 0 ? `Issues: ${returned.join(", ")}` : null,
        "done",
      );
      break;
    }

    case "sprint:error":
      set((prev) => ({ ...prev, state: { ...prev.state, phase: "failed" } }));
      addActivity(set, get(), "error", `Sprint error: ${p?.error}`, null, "failed");
      break;

    case "session:start": {
      const role = (p?.role as string) ?? "agent";
      const issueNum = p?.issueNumber as number | undefined;
      const model = (p?.model as string) ?? null;
      const ROLE_DESCRIPTIONS: Record<string, string> = {
        planner: "Planning implementation",
        "test-engineer": "Writing tests (TDD)",
        developer: "Implementing changes",
        reviewer: "Code review",
        "quality-reviewer": "Reviewing acceptance criteria",
        review: "Sprint review",
        retro: "Sprint retrospective",
        "retro-apply": "Applying retro improvements",
        refinement: "Refining backlog issues",
        planning: "Planning sprint scope",
      };
      const desc =
        ROLE_DESCRIPTIONS[role] ?? `${role.charAt(0).toUpperCase() + role.slice(1)} Agent`;
      // Look up issue title from store
      const issueTitle = issueNum
        ? (get().issues.find((i) => i.number === issueNum)?.title ?? null)
        : null;
      const label = issueNum ? `${desc} — #${issueNum}` : desc;
      const detail = [issueTitle, model].filter(Boolean).join(" · ") || null;
      addActivity(set, get(), "session", label, detail, "active");

      // Auto-open ceremony sessions so user sees live streaming immediately
      const sessionId = (p?.sessionId as string) ?? null;
      if (sessionId && !get().viewingSessionId) {
        get().openSession(sessionId);
      }
      break;
    }

    case "session:end": {
      const outcome = (p?.outcome as string) ?? "completed";
      const acts = get().activities;
      const idx = [...acts]
        .reverse()
        .findIndex((a) => a.type === "session" && a.status === "active");
      if (idx >= 0) {
        const realIdx = acts.length - 1 - idx;
        const updated = [...acts];
        const endStatus =
          outcome === "failed" || outcome === "changes_requested" ? "failed" : "done";
        const suffix =
          outcome === "changes_requested"
            ? " — changes requested"
            : outcome === "failed"
              ? " — failed"
              : "";
        updated[realIdx] = {
          ...updated[realIdx]!,
          status: endStatus,
          label: updated[realIdx]!.label + suffix,
        };
        set({ activities: updated });
      }
      break;
    }

    case "sprint:paused":
      set((prev) => ({ ...prev, state: { ...prev.state, phase: "paused" } }));
      addActivity(set, get(), "sprint", "Sprint paused", null, "done");
      break;

    case "sprint:resumed":
      set((prev) => ({
        ...prev,
        state: { ...prev.state, phase: (p?.phase as string) ?? "execute" },
      }));
      addActivity(set, get(), "sprint", `Sprint resumed → ${p?.phase}`, null, "active");
      break;

    case "log": {
      const logMsg = (p?.message as string) ?? "";
      const logLevel = (p?.level as string) ?? "info";
      set((prev) => ({
        ...prev,
        logs: [...prev.logs, { level: logLevel, message: logMsg, time: new Date() }],
      }));
      // Also surface info+ log messages in the activity feed
      if (logLevel !== "debug" && logMsg) {
        addActivity(set, get(), "log", logMsg, null, logLevel === "error" ? "failed" : "done");
      }
      break;
    }

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

    case "heartbeat:tick":
      set({
        heartbeat: {
          healthy: !!p?.healthy,
          staleLock: !!p?.staleLock,
          lastTickAt: (p?.lastTickAt as string) ?? null,
          staleWarning: false,
        },
      });
      break;

    case "heartbeat:stale":
      set((prev) => ({
        heartbeat: { ...prev.heartbeat, staleWarning: true, healthy: false },
      }));
      break;

    case "heartbeat:recovered":
      addActivity(set, get(), "heartbeat", `Recovered: ${p?.action}`, null, "done");
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
  const entry: Activity = { type, label, detail, status, time: new Date() };

  // If viewing a different sprint than the active one, buffer the activity
  // in the cache so it doesn't pollute the viewed sprint's feed.
  if (
    store.activeSprintNumber > 0 &&
    store.viewingSprintNumber > 0 &&
    store.viewingSprintNumber !== store.activeSprintNumber
  ) {
    const cached = activityCache.get(store.activeSprintNumber) ?? [];
    const updated = cached.map((a) =>
      a.status === "active" && a.type === type ? { ...a, status: "done" as const } : a,
    );
    updated.push(entry);
    if (updated.length > 500) updated.splice(0, updated.length - 500);
    activityCache.set(store.activeSprintNumber, updated);
    return;
  }

  const activities = store.activities.map((a) =>
    a.status === "active" && a.type === type ? { ...a, status: "done" as const } : a,
  );
  activities.push(entry);
  // Cap at 500 entries to prevent unbounded memory growth
  if (activities.length > 500) {
    activities.splice(0, activities.length - 500);
  }
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
  heartbeat: { healthy: true, staleLock: false, lastTickAt: null, staleWarning: false },

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
      .then((d: { sprintNumber: number; milestoneNumber?: number; phase?: string }[]) => {
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
      .then((d: { sprintNumber: number; milestoneNumber?: number; phase?: string }[]) => {
        if (Array.isArray(d)) set({ availableSprints: d });
      })
      .catch(() => {});
  },

  refreshSprintIssues: () => {
    const store = get();
    const n = store.viewingSprintNumber || store.activeSprintNumber;
    if (!n) return;
    // Clear frontend cache for this sprint
    stateCache.delete(n);
    // First refresh sprint list (updates milestone state on backend),
    // then fetch state + issues with fresh data
    fetch("/api/sprints?refresh=true")
      .then((r) => (r.ok ? r.json() : null))
      .then((sprintsData) => {
        if (Array.isArray(sprintsData)) {
          set({
            availableSprints: sprintsData as {
              sprintNumber: number;
              milestoneNumber?: number;
              phase?: string;
            }[],
          });
        }
        return Promise.all([
          fetch(`/api/sprints/${n}/state?refresh=true`).then((r) => (r.ok ? r.json() : null)),
          fetch(`/api/sprints/${n}/issues?refresh=true`).then((r) => (r.ok ? r.json() : null)),
        ]);
      })
      .then(([stateData, issuesData]) => {
        if (!stateData) return;
        const s = stateData as SprintState;
        const iss = Array.isArray(issuesData) ? (issuesData as SprintIssue[]) : store.issues;
        stateCache.set(n, { state: s, issues: iss });
        if (get().viewingSprintNumber === n || get().activeSprintNumber === n) {
          set({ state: s, issues: iss });
        }
      })
      .catch(() => {});
  },

  openSession: (id: string) => {
    set({ viewingSessionId: id, activeChatId: `acp:${id}` });
    const store = get();
    store.send({ type: "session:subscribe", sessionId: id });
  },

  closeSession: () => {
    const store = get();
    if (store.viewingSessionId) {
      store.send({ type: "session:unsubscribe", sessionId: store.viewingSessionId });
    }
    set({ viewingSessionId: null, activeChatId: store.generalChatId });
  },
}));
