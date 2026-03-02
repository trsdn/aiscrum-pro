/** Messages sent from server to browser. */
export interface ServerMessage {
  type:
    | "sprint:event"
    | "sprint:state"
    | "sprint:issues"
    | "sprint:switched"
    | "backlog:planned"
    | "backlog:removed"
    | "backlog:error"
    | "session:list"
    | "session:output"
    | "session:status"
    | "chat:chunk"
    | "chat:done"
    | "chat:created"
    | "chat:error"
    | "chat:thinking"
    | "chat:tool-call"
    | "chat:usage"
    | "pong";
  eventName?: string;
  payload?: unknown;
}

/** Messages sent from browser to server. */
export interface ClientMessage {
  type:
    | "sprint:start"
    | "sprint:stop"
    | "sprint:pause"
    | "sprint:resume"
    | "sprint:switch"
    | "sprint:set-limit"
    | "mode:set"
    | "backlog:plan-issue"
    | "backlog:remove-issue"
    | "session:subscribe"
    | "session:unsubscribe"
    | "session:send-message"
    | "session:stop"
    | "chat:create"
    | "chat:send"
    | "chat:close"
    | "blocked:comment"
    | "blocked:unblock"
    | "decisions:approve"
    | "decisions:reject"
    | "decisions:comment"
    | "ping";
  sprintNumber?: number;
  issueNumber?: number;
  sessionId?: string;
  role?: string;
  message?: string;
  mode?: string;
  body?: string;
  limit?: number;
}

/** Sprint state from server. */
export interface SprintState {
  phase: string;
  sprintNumber: number;
  startedAt?: string | null;
  finalElapsed?: number | null;
  phaseBeforePause?: string | null;
}

/** Issue in current sprint. */
export interface SprintIssue {
  number: number;
  title: string;
  status: string;
  points?: number;
  step?: string;
  failReason?: string;
  duration_ms?: number;
}

/** ACP session info. */
export interface AcpSession {
  sessionId: string;
  role: string;
  issueNumber?: number;
  model?: string;
  startedAt: string;
  endedAt?: string | null;
}

/** Chat session. */
export interface ChatSession {
  id: string;
  role: string;
  model?: string;
}

/** Chat message. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Backlog/Blocked/Decision item from REST API. */
export interface GhIssueItem {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  state?: string;
  blockedReason?: string;
}
