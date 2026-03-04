/**
 * Dashboard WebSocket Server
 *
 * HTTP server for static files + WebSocket for real-time sprint event streaming.
 * Bridges SprintEventBus events to connected browser clients.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import type { SprintEventBus, SprintEngineEvents } from "../events.js";
import type { SprintState } from "../runner.js";
import type { ConfigFile } from "../config.js";
import { logger, appendErrorLog, getErrorLogDir } from "../logger.js";
import { ChatManager, type ChatRole } from "./chat-manager.js";
import { writeSessionLog } from "./session-logger.js";
import { sessionController } from "./session-control.js";
import { loadSprintHistory } from "./sprint-history.js";
import { SprintIssueCache } from "./issue-cache.js";
import { listSprintMilestones } from "../github/milestones.js";

const log = logger.child({ component: "ws-server" });

export interface IssueEntry {
  number: number;
  title: string;
  status: "planned" | "in-progress" | "done" | "failed";
}

/** Message sent from server to browser clients. */
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
    | "chat:mode"
    | "chat:plan"
    | "chat:commands"
    | "chat:config"
    | "pong";
  eventName?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
}

/** Message sent from browser client to server. */
export interface ClientMessage {
  type:
    | "sprint:start"
    | "sprint:stop"
    | "sprint:cancel"
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
    | "chat:cancel"
    | "chat:set-mode"
    | "chat:set-config"
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
  optionId?: string;
  value?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface DashboardServerOptions {
  port: number;
  host: string;
  eventBus: SprintEventBus;
  getState: () => SprintState;
  getIssues: () => IssueEntry[];
  onStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  onCancel?: () => void | Promise<void>;
  onSwitchSprint?: (sprintNumber: number) => void | Promise<void>;
  onModeChange?: (mode: "autonomous" | "hitl") => void;
  onSetSprintLimit?: (limit: number) => void;
  /** Project root for loading sprint state files. */
  projectPath?: string;
  /** Currently active sprint number (the one being executed). */
  activeSprintNumber?: number;
  /** Sprint prefix for milestone titles (default: "Sprint"). */
  sprintPrefix?: string;
  /** Sprint slug for file naming (default: "sprint"). */
  sprintSlug?: string;
  /** Max issues per sprint for capacity display (default: 8). */
  maxIssuesPerSprint?: number;
  /** Full config for the settings page. */
  config?: ConfigFile;
}

export interface TrackedSession {
  sessionId: string;
  role: string;
  issueNumber?: number;
  model?: string;
  startedAt: number;
  endedAt?: number;
  outcome?: "completed" | "approved" | "changes_requested" | "failed";
  output: string[];
}

/** Max events to buffer for replay on sprint switch. */
const EVENT_BUFFER_MAX = 200;

interface BufferedEvent {
  eventName: string;
  payload: unknown;
}

export class DashboardWebServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private chatManager: ChatManager | null = null;
  private issueCache: SprintIssueCache | null = null;
  private repoUrl: string | null = null;
  private sessions = new Map<string, TrackedSession>();
  private sessionSubscribers = new Map<string, Set<WebSocket>>();
  private readonly options: DashboardServerOptions;
  private readonly publicDir: string;
  private eventBuffer: BufferedEvent[] = [];
  private knownMilestones: {
    sprintNumber: number;
    milestoneNumber: number;
    title: string;
    state: string;
  }[] = [];
  private executionMode: "autonomous" | "hitl" = "autonomous";
  private activeSprintNumberOverride: number | undefined;
  public sprintLimit = 0;

  constructor(options: DashboardServerOptions) {
    this.options = options;
    // Prefer React build in dist/; fall back to co-located public/ (legacy dev)
    const thisDir = path.dirname(new URL(import.meta.url).pathname);
    const distPublic = path.resolve(thisDir, "..", "..", "dist", "dashboard", "public");
    const localPublic = path.join(thisDir, "public");
    this.publicDir = fs.existsSync(distPublic) ? distPublic : localPublic;
  }

  /** Update the active sprint number (called when sprint loop advances). */
  setActiveSprintNumber(n: number): void {
    this.activeSprintNumberOverride = n;
    // Clear event buffer for new sprint
    this.eventBuffer = [];
    // Broadcast sprint switch to all clients
    this.broadcast({
      type: "sprint:switched",
      payload: { sprintNumber: n, activeSprintNumber: n },
    });
  }

  getExecutionMode(): "autonomous" | "hitl" {
    return this.executionMode;
  }

  /** Effective active sprint number (override takes precedence over options). */
  private get activeSprintNumber(): number | undefined {
    return this.activeSprintNumberOverride ?? this.options.activeSprintNumber;
  }

  async start(): Promise<void> {
    const { port, host } = this.options;

    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on("connection", (ws) => {
      log.info("Dashboard client connected");

      // Send current state immediately on connect
      this.sendTo(ws, {
        type: "sprint:state",
        payload: this.options.getState(),
      });
      this.sendTo(ws, {
        type: "sprint:issues",
        payload: this.options.getIssues(),
      });
      // Send active sprint info so client knows which sprint is running
      this.sendTo(ws, {
        type: "sprint:switched",
        payload: {
          sprintNumber: this.activeSprintNumber,
          activeSprintNumber: this.activeSprintNumber,
        },
      });
      // Send current execution mode so client dropdown syncs
      this.sendTo(ws, {
        type: "sprint:event",
        eventName: "mode:changed",
        payload: { mode: this.executionMode },
      });
      // Send sprint limit
      this.sendTo(ws, {
        type: "sprint:event",
        eventName: "sprint:limit-changed",
        payload: { limit: this.sprintLimit },
      });
      // Send active session list
      if (this.sessions.size > 0) {
        const sessions = Array.from(this.sessions.values()).map((s) => ({
          sessionId: s.sessionId,
          role: s.role,
          issueNumber: s.issueNumber,
          model: s.model,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          outputLength: s.output.length,
        }));
        this.sendTo(ws, { type: "session:list", payload: sessions });

        // Auto-subscribe to all active sessions so output streams immediately
        for (const s of this.sessions.values()) {
          if (!s.endedAt) {
            let subs = this.sessionSubscribers.get(s.sessionId);
            if (!subs) {
              subs = new Set();
              this.sessionSubscribers.set(s.sessionId, subs);
            }
            subs.add(ws);
            // Send buffered output history
            if (s.output.length > 0) {
              this.sendTo(ws, {
                type: "session:output",
                payload: { sessionId: s.sessionId, text: s.output.join(""), isHistory: true },
              });
            }
          }
        }
      }

      // Replay buffered events so new clients see activity history
      if (this.eventBuffer.length > 0) {
        for (const buffered of this.eventBuffer) {
          this.sendTo(ws, {
            type: "sprint:event",
            eventName: buffered.eventName,
            payload: buffered.payload,
          });
        }
      }

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage;
          this.handleClientMessage(msg, ws);
        } catch {
          log.warn("Invalid WebSocket message from client");
        }
      });

      ws.on("close", () => {
        log.info("Dashboard client disconnected");
        // Clean up session subscriptions
        for (const subs of this.sessionSubscribers.values()) {
          subs.delete(ws);
        }
      });
    });

    this.bridgeEvents();

    // Discover sprints from GitHub milestones (async, non-blocking)
    const prefix = this.options.sprintPrefix ?? "Sprint";
    const activeNum = this.activeSprintNumber ?? 1;
    listSprintMilestones(prefix)
      .then((milestones) => {
        this.knownMilestones = milestones;
        // Determine max sprint from both milestones and active sprint
        const maxFromMilestones =
          milestones.length > 0 ? Math.max(...milestones.map((m) => m.sprintNumber)) : 0;
        const maxSprint = Math.max(activeNum, maxFromMilestones);
        log.info({ milestones: milestones.length, maxSprint }, "Sprint milestones discovered");

        // Initialize issue cache with full range
        this.issueCache = new SprintIssueCache({
          maxSprint,
          loadState: (n) => this.loadSprintState(n),
          sprintPrefix: prefix,
        });
        this.issueCache
          .preload()
          .then(() => {
            this.issueCache!.startRefresh();
          })
          .catch((err) => {
            log.warn({ err }, "Issue cache preload failed");
          });
      })
      .catch((err) => {
        log.warn({ err }, "Milestone discovery failed, falling back to active sprint only");
        this.issueCache = new SprintIssueCache({
          maxSprint: activeNum,
          loadState: (n) => this.loadSprintState(n),
          sprintPrefix: prefix,
        });
        this.issueCache
          .preload()
          .then(() => {
            this.issueCache!.startRefresh();
          })
          .catch((e) => {
            log.warn({ err: e }, "Issue cache preload failed");
          });
      });

    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        log.info({ port, host }, "Dashboard server started");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.issueCache) {
      this.issueCache.stop();
      this.issueCache = null;
    }
    if (this.chatManager) {
      await this.chatManager.shutdown();
      this.chatManager = null;
    }
    // Remove all event bus listeners to prevent accumulation on restart
    const bus = this.options.eventBus;
    bus.removeAllListeners();

    if (this.wss) {
      for (const ws of this.wss.clients) {
        ws.close();
      }
      this.wss.close();
    }
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  private broadcast(msg: ServerMessage): void {
    if (!this.wss) return;
    const data = JSON.stringify(msg);
    for (const ws of this.wss.clients) {
      if (ws.readyState === 1 && ws.bufferedAmount < 1_048_576) {
        ws.send(data);
      }
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === 1 && ws.bufferedAmount < 1_048_576) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcastSessionList(): void {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      role: s.role,
      issueNumber: s.issueNumber,
      model: s.model,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      outcome: s.outcome,
      outputLength: s.output.length,
    }));
    this.broadcast({ type: "session:list", payload: sessions });
  }

  /** Subscribe to all SprintEventBus events and relay to WebSocket clients. */
  private bridgeEvents(): void {
    const bus = this.options.eventBus;
    const eventNames: (keyof SprintEngineEvents)[] = [
      "phase:change",
      "issue:start",
      "issue:progress",
      "issue:done",
      "issue:fail",
      "worker:output",
      "session:start",
      "session:end",
      "sprint:start",
      "sprint:planned",
      "sprint:complete",
      "sprint:stopped",
      "sprint:cancelled",
      "sprint:error",
      "sprint:paused",
      "sprint:resumed",
      "log",
      "heartbeat:tick",
      "heartbeat:stale",
      "heartbeat:recovered",
    ];

    for (const eventName of eventNames) {
      bus.onTyped(eventName, (payload) => {
        const msg = { type: "sprint:event" as const, eventName, payload };
        this.broadcast(msg);
        // Buffer for replay on sprint switch
        this.eventBuffer.push({ eventName, payload });
        if (this.eventBuffer.length > EVENT_BUFFER_MAX) {
          this.eventBuffer.shift();
        }
        // Write errors and warnings to daily log file
        if (eventName === "sprint:error" || eventName === "issue:fail") {
          const p = payload as Record<string, unknown>;
          appendErrorLog("error", `${eventName}: ${p.message ?? p.error ?? JSON.stringify(p)}`, {
            event: eventName,
          });
        }
        if (eventName === "log") {
          const p = payload as { level: string; message: string };
          if (p.level === "error" || p.level === "warn") {
            appendErrorLog(p.level as "error" | "warn", p.message, { event: eventName });
          }
        }
      });
    }

    // Push updated issue list when planning completes
    bus.onTyped("sprint:planned", () => {
      // Small delay to let index.ts update currentIssues first
      setTimeout(() => {
        this.broadcast({ type: "sprint:issues", payload: this.options.getIssues() });
        // Also update the issue cache
        const sprintNum = this.activeSprintNumber ?? 1;
        if (this.issueCache) {
          this.issueCache.set(
            sprintNum,
            this.options.getIssues().map((i) => ({
              number: i.number,
              title: i.title,
              status: i.status as "planned" | "in-progress" | "done" | "failed",
            })),
          );
        }
      }, 500);
    });

    // Track ACP sessions for the session viewer
    bus.onTyped("session:start", (payload) => {
      this.sessions.set(payload.sessionId, {
        sessionId: payload.sessionId,
        role: payload.role,
        issueNumber: payload.issueNumber,
        model: payload.model,
        startedAt: Date.now(),
        output: [],
      });
      this.broadcastSessionList();
      // Auto-subscribe all connected clients to the new session
      if (this.wss) {
        const subs = new Set<WebSocket>();
        for (const ws of this.wss.clients) {
          if (ws.readyState === ws.OPEN) subs.add(ws);
        }
        if (subs.size > 0) this.sessionSubscribers.set(payload.sessionId, subs);
      }
    });

    bus.onTyped("session:end", (payload) => {
      const session = this.sessions.get(payload.sessionId);
      if (session) {
        session.endedAt = Date.now();
        session.outcome = payload.outcome;
        this.broadcastSessionList();
        this.sessionSubscribers.delete(payload.sessionId);
        // Prune ended session after 5 minutes to prevent memory leak
        setTimeout(
          () => {
            const s = this.sessions.get(payload.sessionId);
            if (s?.endedAt) {
              this.sessions.delete(payload.sessionId);
            }
          },
          5 * 60 * 1000,
        );
      }
    });

    bus.onTyped("worker:output", (payload) => {
      const session = this.sessions.get(payload.sessionId);
      if (session) {
        session.output.push(payload.text);
        // Cap stored output to prevent memory bloat (keep last 2000 chunks)
        if (session.output.length > 2000) {
          session.output = session.output.slice(-1800);
        }
      }
      // Send to subscribers of this session
      const subs = this.sessionSubscribers.get(payload.sessionId);
      if (subs) {
        const msg: ServerMessage = {
          type: "session:output",
          payload: { sessionId: payload.sessionId, text: payload.text },
        };
        for (const ws of subs) {
          this.sendTo(ws, msg);
        }
      }
    });
  }

  private handleClientMessage(msg: ClientMessage, ws: WebSocket): void {
    switch (msg.type) {
      case "sprint:start":
        log.info("Dashboard client requested sprint start");
        this.options.onStart?.();
        break;
      case "sprint:switch":
        if (msg.sprintNumber && typeof msg.sprintNumber === "number" && msg.sprintNumber > 0) {
          log.info({ sprintNumber: msg.sprintNumber }, "Dashboard client switched sprint");
          const sprintNum = msg.sprintNumber;
          // Await async callback before re-sending state
          Promise.resolve(this.options.onSwitchSprint?.(sprintNum))
            .then(() => {
              // Load state for the requested sprint
              const state = this.loadSprintState(sprintNum);
              this.sendTo(ws, {
                type: "sprint:state",
                payload: state ?? this.options.getState(),
              });
              // For active sprint use live issues; for historical use cache
              const isActive = sprintNum === this.activeSprintNumber;
              if (isActive) {
                this.sendTo(ws, {
                  type: "sprint:issues",
                  payload: this.options.getIssues(),
                });
              } else if (this.issueCache?.has(sprintNum)) {
                this.sendTo(ws, {
                  type: "sprint:issues",
                  payload: this.issueCache.get(sprintNum),
                });
              } else {
                // Cache miss — load from GitHub async
                this.loadHistoricalIssues(sprintNum)
                  .then((issues) => {
                    this.sendTo(ws, {
                      type: "sprint:issues",
                      payload: issues,
                    });
                  })
                  .catch(() => {});
              }
              this.sendTo(ws, {
                type: "sprint:switched",
                payload: { sprintNumber: sprintNum, activeSprintNumber: this.activeSprintNumber },
              });
            })
            .catch((err: unknown) => {
              log.warn({ err }, "Sprint switch failed");
            });
        }
        break;
      case "sprint:pause":
        log.info("Dashboard client requested sprint pause");
        this.options.onPause?.();
        break;
      case "sprint:resume":
        log.info("Dashboard client requested sprint resume");
        this.options.onResume?.();
        break;
      case "sprint:stop":
        log.info("Dashboard client requested sprint stop");
        this.options.onStop?.();
        break;
      case "sprint:cancel":
        log.info("Dashboard client requested sprint cancel");
        this.options.onCancel?.();
        break;
      case "mode:set":
        if (msg.mode === "autonomous" || msg.mode === "hitl") {
          this.executionMode = msg.mode;
          log.info({ mode: msg.mode }, "Dashboard client changed execution mode");
          this.options.onModeChange?.(msg.mode);
          this.broadcast({
            type: "sprint:event",
            eventName: "mode:changed",
            payload: { mode: msg.mode },
          });
        }
        break;
      case "sprint:set-limit": {
        const limit = typeof msg.limit === "number" ? Math.max(0, Math.floor(msg.limit)) : 0;
        log.info({ limit }, "Dashboard client set sprint limit");
        this.sprintLimit = limit;
        this.options.onSetSprintLimit?.(limit);
        this.broadcast({
          type: "sprint:event",
          eventName: "sprint:limit-changed",
          payload: { limit },
        });
        break;
      }
      case "backlog:plan-issue":
        if (msg.issueNumber) {
          this.handlePlanIssue(msg.issueNumber, ws, msg.sprintNumber as number | undefined);
        }
        break;
      case "backlog:remove-issue":
        if (msg.issueNumber) {
          this.handleRemoveFromSprint(msg.issueNumber, ws);
        }
        break;
      case "chat:create":
        this.handleChatCreate(msg.role as ChatRole | undefined, ws);
        break;
      case "chat:send":
        if (msg.sessionId && msg.message) {
          this.handleChatSend(msg.sessionId, msg.message, ws);
        }
        break;
      case "chat:close":
        if (msg.sessionId) {
          this.handleChatClose(msg.sessionId);
        }
        break;
      case "chat:cancel":
        if (msg.sessionId) {
          this.handleChatCancel(msg.sessionId, ws);
        }
        break;
      case "chat:set-mode":
        if (msg.sessionId && msg.mode) {
          this.handleChatSetMode(msg.sessionId, msg.mode, ws);
        }
        break;
      case "chat:set-config":
        if (msg.sessionId && msg.optionId && msg.value != null) {
          this.handleChatSetConfig(msg.sessionId, msg.optionId, msg.value, ws);
        }
        break;
      case "session:subscribe":
        if (msg.sessionId) {
          let subs = this.sessionSubscribers.get(msg.sessionId);
          if (!subs) {
            subs = new Set();
            this.sessionSubscribers.set(msg.sessionId, subs);
          }
          subs.add(ws);
          // Send existing output history
          const session = this.sessions.get(msg.sessionId);
          if (session) {
            this.sendTo(ws, {
              type: "session:output",
              payload: { sessionId: msg.sessionId, text: session.output.join(""), isHistory: true },
            });
          }
        }
        break;
      case "session:unsubscribe":
        if (msg.sessionId) {
          this.sessionSubscribers.get(msg.sessionId)?.delete(ws);
        }
        break;
      case "session:send-message":
        if (msg.sessionId && msg.message) {
          const targetSession = this.sessions.get(msg.sessionId);
          if (targetSession && !targetSession.endedAt) {
            sessionController.enqueue(msg.sessionId, msg.message);
            this.sendTo(ws, {
              type: "session:status",
              payload: { sessionId: msg.sessionId, action: "message-queued", message: msg.message },
            });
            log.info({ sessionId: msg.sessionId }, "user message queued for session");
          } else {
            this.sendTo(ws, {
              type: "session:status",
              payload: { sessionId: msg.sessionId, action: "error", error: "Session not active" },
            });
          }
        }
        break;
      case "session:stop":
        if (msg.sessionId) {
          const stopSession = this.sessions.get(msg.sessionId);
          if (stopSession && !stopSession.endedAt) {
            sessionController.requestStop(msg.sessionId);
            this.sendTo(ws, {
              type: "session:status",
              payload: { sessionId: msg.sessionId, action: "stop-requested" },
            });
            log.warn({ sessionId: msg.sessionId }, "user requested session stop");
          }
        }
        break;
      case "ping":
        break;
      case "blocked:comment":
        if (msg.issueNumber && msg.body) {
          this.handleBlockedComment(msg.issueNumber, msg.body, ws);
        }
        break;
      case "blocked:unblock":
        if (msg.issueNumber) {
          this.handleBlockedUnblock(msg.issueNumber, ws);
        }
        break;
      case "decisions:approve":
        if (msg.issueNumber) {
          this.handleDecisionApprove(msg.issueNumber, ws);
        }
        break;
      case "decisions:reject":
        if (msg.issueNumber) {
          this.handleDecisionReject(msg.issueNumber, ws);
        }
        break;
      case "decisions:comment":
        if (msg.issueNumber && msg.body) {
          this.handleDecisionComment(msg.issueNumber, msg.body, ws);
        }
        break;
    }
  }

  /** Lazy-initialize chat manager. */
  private getChatManager(): ChatManager {
    if (!this.chatManager) {
      this.chatManager = new ChatManager({
        projectPath: this.options.projectPath ?? process.cwd(),
        onStreamChunk: (chatId, text) => {
          this.broadcast({
            type: "chat:chunk",
            payload: { sessionId: chatId, text },
          });
        },
        onThinkingChunk: (chatId, text) => {
          this.broadcast({
            type: "chat:thinking",
            payload: { sessionId: chatId, text },
          });
        },
        onToolCall: (chatId, toolCall) => {
          this.broadcast({
            type: "chat:tool-call",
            payload: { sessionId: chatId, ...toolCall },
          });
        },
        onUsageUpdate: (chatId, usage) => {
          this.broadcast({
            type: "chat:usage",
            payload: { sessionId: chatId, ...usage },
          });
        },
        onModeChange: (chatId, modeId) => {
          this.broadcast({
            type: "chat:mode",
            payload: { sessionId: chatId, modeId },
          });
        },
        onPlanUpdate: (chatId, plan) => {
          this.broadcast({
            type: "chat:plan",
            payload: { sessionId: chatId, entries: plan.entries },
          });
        },
        onCommandsUpdate: (chatId, commands) => {
          this.broadcast({
            type: "chat:commands",
            payload: { sessionId: chatId, commands },
          });
        },
        onConfigUpdate: (chatId, configs) => {
          this.broadcast({
            type: "chat:config",
            payload: { sessionId: chatId, configs },
          });
        },
      });
    }
    return this.chatManager;
  }

  private async handleChatCreate(role: ChatRole | undefined, ws: WebSocket): Promise<void> {
    const validRole = role ?? "general";
    try {
      const session = await this.getChatManager().createSession(validRole);
      this.sendTo(ws, {
        type: "chat:created",
        payload: {
          sessionId: session.id,
          role: session.role,
          model: session.model,
        },
      });
      log.info({ chatId: session.id, role: validRole }, "Chat session created via dashboard");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, role: validRole }, "Failed to create chat session");
      this.sendTo(ws, {
        type: "chat:error",
        payload: { error: `Failed to create session: ${msg}` },
      });
    }
  }

  private async handleChatSend(sessionId: string, message: string, ws: WebSocket): Promise<void> {
    try {
      const response = await this.getChatManager().sendMessage(sessionId, message);
      this.sendTo(ws, {
        type: "chat:done",
        payload: { sessionId, response },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId }, "Chat message failed");
      this.sendTo(ws, {
        type: "chat:error",
        payload: { sessionId, error: msg },
      });
    }
  }

  private async handleChatClose(sessionId: string): Promise<void> {
    try {
      const session = this.getChatManager().getSession(sessionId);
      if (session) {
        writeSessionLog(session, {
          projectPath: this.options.projectPath ?? process.cwd(),
          sprintNumber: this.activeSprintNumber ?? 1,
        });
      }
      await this.getChatManager().closeSession(sessionId);
    } catch (err: unknown) {
      log.warn({ err, sessionId }, "Failed to close chat session");
    }
  }

  private async handleChatSetMode(sessionId: string, modeId: string, ws: WebSocket): Promise<void> {
    try {
      await this.getChatManager().setMode(sessionId, modeId);
      this.broadcast({
        type: "chat:mode",
        payload: { sessionId, modeId },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId, modeId }, "Failed to set chat mode");
      this.sendTo(ws, {
        type: "chat:error",
        payload: { sessionId, error: `Failed to set mode: ${msg}` },
      });
    }
  }

  private async handleChatSetConfig(
    sessionId: string,
    optionId: string,
    value: string,
    ws: WebSocket,
  ): Promise<void> {
    try {
      log.info({ sessionId, optionId, value }, "Setting chat config option");
      await this.getChatManager().setConfig(sessionId, optionId, value);
      log.info({ sessionId, optionId, value }, "Chat config option set successfully");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId, optionId, value }, "Failed to set chat config");
      this.sendTo(ws, {
        type: "chat:error",
        payload: { sessionId, error: `Failed to set config: ${msg}` },
      });
    }
  }

  private async handleChatCancel(sessionId: string, ws: WebSocket): Promise<void> {
    try {
      await this.getChatManager().cancelSession(sessionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, sessionId }, "Failed to cancel chat session");
      this.sendTo(ws, {
        type: "chat:error",
        payload: { sessionId, error: `Failed to cancel: ${msg}` },
      });
    }
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // API routes
    if (url.pathname.startsWith("/api/")) {
      try {
        this.handleApi(url, req, res);
      } catch (err) {
        appendErrorLog("error", `API error: ${url.pathname} — ${String(err)}`, {
          path: url.pathname,
        });
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
      return;
    }

    let filePath = path.join(this.publicDir, url.pathname === "/" ? "index.html" : url.pathname);

    // Prevent directory traversal
    if (!filePath.startsWith(this.publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.publicDir, "index.html");
    }

    try {
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  /** Handle REST API requests. */
  private handleApi(url: URL, req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = url.pathname;
    res.setHeader("Content-Type", "application/json");

    if (pathname === "/api/repo") {
      this.handleRepoInfo(res);
      return;
    }

    if (pathname === "/api/sessions") {
      const sessions = Array.from(this.sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        role: s.role,
        issueNumber: s.issueNumber,
        model: s.model,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        outputLength: s.output.length,
      }));
      res.writeHead(200);
      res.end(JSON.stringify(sessions));
      return;
    }

    if (pathname === "/api/sprints") {
      const sprints = this.listSprints();
      res.writeHead(200);
      res.end(JSON.stringify(sprints));
      return;
    }

    if (pathname === "/api/sprints/history") {
      const projectPath = this.options.projectPath ?? process.cwd();
      const velocityPath = path.join(projectPath, "docs", "sprints", "velocity.md");
      const history = loadSprintHistory(velocityPath);
      res.writeHead(200);
      res.end(JSON.stringify(history));
      return;
    }

    // /api/sprints/:number/issues — fetch issues from GitHub milestone
    const issuesMatch = pathname.match(/^\/api\/sprints\/(\d+)\/issues$/);
    if (issuesMatch) {
      const num = parseInt(issuesMatch[1], 10);
      this.handleSprintIssues(num, res);
      return;
    }

    // /api/sprints/:number/state
    const stateMatch = pathname.match(/^\/api\/sprints\/(\d+)\/state$/);
    if (stateMatch) {
      const num = parseInt(stateMatch[1], 10);
      const sprintState = this.loadSprintState(num);
      if (sprintState) {
        res.writeHead(200);
        res.end(JSON.stringify(sprintState));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ sprintNumber: num, phase: "init", startedAt: null }));
      }
      return;
    }

    // /api/backlog — refined issues not in any open sprint milestone
    if (pathname === "/api/backlog") {
      this.handleBacklogRequest(res);
      return;
    }

    // /api/ideas — type:idea issues awaiting refinement
    if (pathname === "/api/ideas") {
      this.handleIdeasRequest(res);
      return;
    }

    // /api/blocked — issues with status:blocked label
    if (pathname === "/api/blocked") {
      this.handleBlockedRequest(res);
      return;
    }

    // /api/decisions — issues with human-decision-needed label
    if (pathname === "/api/decisions") {
      this.handleDecisionsRequest(res);
      return;
    }

    // /api/sprint-capacity — current sprint capacity info
    if (pathname === "/api/sprint-capacity") {
      const sprintNum = this.activeSprintNumber ?? 1;
      const maxIssues = this.options.maxIssuesPerSprint ?? 8;
      const plannedCount = this.options.getIssues().length;
      res.writeHead(200);
      res.end(JSON.stringify({ sprintNumber: sprintNum, maxIssues, plannedCount }));
      return;
    }

    // /api/sprint-backlog — issues in the active or requested sprint with full body
    if (pathname === "/api/sprint-backlog") {
      const requestedSprint = url.searchParams.get("sprint");
      const sprintNum = requestedSprint ? parseInt(requestedSprint, 10) : undefined;
      if (sprintNum !== undefined && (isNaN(sprintNum) || sprintNum < 1)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid sprint number" }));
        return;
      }
      this.handleSprintBacklogRequest(res, sprintNum);
      return;
    }

    // /api/config — full project config for the settings page
    if (pathname === "/api/config") {
      if (req.method === "PUT" || req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const newConfig = JSON.parse(body);
            const projectPath = this.options.projectPath ?? process.cwd();
            const configPath = path.join(projectPath, ".aiscrum", "config.yaml");
            // Dynamic import to avoid top-level dep
            import("yaml")
              .then(({ stringify }) => {
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                fs.writeFileSync(configPath, stringify(newConfig, { lineWidth: 120 }), "utf-8");
                this.options.config = newConfig;
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
              })
              .catch((err) => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: String(err) }));
              });
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }
      const config = this.options.config ?? null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(config));
      return;
    }

    // /api/roles — list agent roles with instructions and prompts
    if (pathname === "/api/roles") {
      const projectPath = this.options.projectPath ?? process.cwd();
      const rolesDir = path.join(projectPath, ".aiscrum", "roles");
      const phases = this.options.config?.copilot?.phases ?? {};
      if (req.method === "PUT" || req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const {
              name,
              instructions,
              prompts,
              model,
              mode,
              skills,
              mcp_servers: mcpServers,
            } = JSON.parse(body) as {
              name: string;
              instructions?: string;
              prompts?: Record<string, string>;
              model?: string;
              mode?: string;
              skills?: Record<string, string>;
              mcp_servers?: Array<{
                name: string;
                type: string;
                command?: string;
                args?: string[];
                url?: string;
              }>;
            };
            const roleDir = path.join(rolesDir, name);
            if (!fs.existsSync(roleDir)) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: "Role not found" }));
              return;
            }
            if (instructions !== undefined) {
              fs.writeFileSync(
                path.join(roleDir, "copilot-instructions.md"),
                instructions,
                "utf-8",
              );
            }
            if (prompts) {
              const promptsDir = path.join(roleDir, "prompts");
              for (const [fname, content] of Object.entries(prompts)) {
                const target = path.join(promptsDir, fname);
                if (fs.existsSync(target)) fs.writeFileSync(target, content, "utf-8");
              }
            }
            // Save skills content
            if (skills) {
              const skillsDir = path.join(roleDir, "skills");
              for (const [skillName, content] of Object.entries(skills)) {
                const skillFile = path.join(skillsDir, skillName, "SKILL.md");
                if (fs.existsSync(skillFile)) fs.writeFileSync(skillFile, content, "utf-8");
              }
            }
            // Save model/mode/mcp to config phases
            if (model !== undefined || mode !== undefined || mcpServers !== undefined) {
              const configPath = path.join(projectPath, ".aiscrum", "config.yaml");
              if (fs.existsSync(configPath)) {
                import("yaml")
                  .then(({ parse: parseYaml, stringify }) => {
                    const raw = fs.readFileSync(configPath, "utf-8");
                    const cfg = parseYaml(raw) as Record<string, unknown>;
                    const copilot = (cfg.copilot ?? {}) as Record<string, unknown>;
                    const phasesObj = (copilot.phases ?? {}) as Record<
                      string,
                      Record<string, unknown>
                    >;
                    if (!phasesObj[name]) phasesObj[name] = {};
                    if (model !== undefined) phasesObj[name].model = model || undefined;
                    if (mode !== undefined) phasesObj[name].mode = mode || undefined;
                    if (mcpServers !== undefined)
                      phasesObj[name].mcp_servers = mcpServers.length > 0 ? mcpServers : undefined;
                    if (!phasesObj[name].model) delete phasesObj[name].model;
                    if (!phasesObj[name].mode) delete phasesObj[name].mode;
                    if (
                      !phasesObj[name].mcp_servers ||
                      (phasesObj[name].mcp_servers as unknown[]).length === 0
                    )
                      delete phasesObj[name].mcp_servers;
                    if (Object.keys(phasesObj[name]).length === 0) delete phasesObj[name];
                    copilot.phases = phasesObj;
                    cfg.copilot = copilot;
                    fs.writeFileSync(configPath, stringify(cfg, { lineWidth: 120 }), "utf-8");
                    res.writeHead(200);
                    res.end(JSON.stringify({ ok: true }));
                  })
                  .catch((err) => {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: String(err) }));
                  });
                return;
              }
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }
      // GET: list all roles with model/mode/skills/mcp from phases config
      try {
        const roles: Array<{
          name: string;
          instructions: string;
          prompts: Record<string, string>;
          model?: string;
          mode?: string;
          skills: Array<{ name: string; description: string; content: string; dirName: string }>;
          mcp_servers: Array<{
            name: string;
            type: string;
            command?: string;
            url?: string;
            args?: string[];
          }>;
        }> = [];
        if (fs.existsSync(rolesDir)) {
          for (const entry of fs.readdirSync(rolesDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const roleDir = path.join(rolesDir, entry.name);
            const instrPath = path.join(roleDir, "copilot-instructions.md");
            const instructions = fs.existsSync(instrPath)
              ? fs.readFileSync(instrPath, "utf-8")
              : "";
            const prompts: Record<string, string> = {};
            const promptsDir = path.join(roleDir, "prompts");
            if (fs.existsSync(promptsDir)) {
              for (const pf of fs.readdirSync(promptsDir)) {
                if (pf.endsWith(".md"))
                  prompts[pf] = fs.readFileSync(path.join(promptsDir, pf), "utf-8");
              }
            }
            // Read skills with full content
            const skills: Array<{
              name: string;
              description: string;
              content: string;
              dirName: string;
            }> = [];
            const skillsDir = path.join(roleDir, "skills");
            if (fs.existsSync(skillsDir)) {
              for (const sd of fs.readdirSync(skillsDir, { withFileTypes: true })) {
                if (!sd.isDirectory()) continue;
                const skillFile = path.join(skillsDir, sd.name, "SKILL.md");
                if (fs.existsSync(skillFile)) {
                  const raw = fs.readFileSync(skillFile, "utf-8");
                  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
                  let skillName = sd.name;
                  let desc = "";
                  if (fmMatch) {
                    const nameMatch = fmMatch[1].match(/name:\s*["']?(.+?)["']?\s*$/m);
                    const descMatch = fmMatch[1].match(/description:\s*["']?(.+?)["']?\s*$/m);
                    skillName = nameMatch?.[1] ?? sd.name;
                    desc = descMatch?.[1] ?? "";
                  }
                  skills.push({
                    name: skillName,
                    description: desc,
                    content: raw,
                    dirName: sd.name,
                  });
                }
              }
            }
            const phaseConfig = phases[entry.name] as Record<string, unknown> | undefined;
            const phaseMcp = (phaseConfig?.mcp_servers as Array<Record<string, string>>) ?? [];
            roles.push({
              name: entry.name,
              instructions,
              prompts,
              model: (phaseConfig?.model as string) ?? undefined,
              mode: (phaseConfig?.mode as string) ?? undefined,
              skills,
              mcp_servers: phaseMcp.map((m) => ({
                name: m.name ?? "",
                type: m.type ?? "stdio",
                command: m.command,
                url: m.url,
              })),
            });
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify(roles));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // /api/quality-gates — read/write quality-gates.yaml
    if (pathname === "/api/quality-gates") {
      const projectPath = this.options.projectPath ?? process.cwd();
      const qgPath = path.join(projectPath, ".aiscrum", "quality-gates.yaml");
      if (req.method === "PUT" || req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            import("yaml")
              .then(({ stringify }) => {
                fs.mkdirSync(path.dirname(qgPath), { recursive: true });
                fs.writeFileSync(qgPath, stringify(data, { lineWidth: 120 }), "utf-8");
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
              })
              .catch((err) => {
                res.writeHead(500);
                res.end(JSON.stringify({ error: String(err) }));
              });
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: String(err) }));
          }
        });
        return;
      }
      // GET
      try {
        if (fs.existsSync(qgPath)) {
          const raw = fs.readFileSync(qgPath, "utf-8");
          import("yaml")
            .then(({ parse: parseYaml }) => {
              res.writeHead(200);
              res.end(JSON.stringify(parseYaml(raw)));
            })
            .catch((err) => {
              res.writeHead(500);
              res.end(JSON.stringify({ error: String(err) }));
            });
        } else {
          res.writeHead(200);
          res.end(JSON.stringify(null));
        }
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // /api/logs — list log files and read log content
    if (pathname === "/api/logs") {
      const logsDir = getErrorLogDir();
      if (!logsDir || !fs.existsSync(logsDir)) {
        res.writeHead(200);
        res.end(JSON.stringify({ files: [], entries: [] }));
        return;
      }
      const file = url.searchParams.get("file");
      const tail = parseInt(url.searchParams.get("tail") ?? "200", 10);
      if (file) {
        // Read specific log file
        const safeName = path.basename(file);
        const filePath = path.join(logsDir, safeName);
        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Log file not found" }));
          return;
        }
        const raw = fs.readFileSync(filePath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const entries = lines.slice(-tail).map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { time: "", level: "info", message: line };
          }
        });
        res.writeHead(200);
        res.end(JSON.stringify({ file: safeName, entries }));
      } else {
        // List log files
        const files = fs
          .readdirSync(logsDir)
          .filter((f) => f.endsWith(".log"))
          .sort()
          .reverse()
          .map((f) => {
            const stat = fs.statSync(path.join(logsDir, f));
            return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
          });
        res.writeHead(200);
        res.end(JSON.stringify({ files }));
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /** Fetch issues for a sprint — serves from cache, loads on demand if needed. */
  private handleSprintIssues(sprintNumber: number, res: http.ServerResponse): void {
    // Active sprint: always return live tracked issues
    if (sprintNumber === this.activeSprintNumber) {
      const issues = this.options.getIssues();
      if (this.issueCache) {
        this.issueCache.set(sprintNumber, issues);
      }
      res.writeHead(200);
      res.end(JSON.stringify(issues));
      return;
    }

    // Check cache — if hit, serve immediately
    if (this.issueCache?.has(sprintNumber)) {
      const cached = this.issueCache.get(sprintNumber);
      res.writeHead(200);
      res.end(JSON.stringify(cached));
      return;
    }

    // Cache miss — load on demand from GitHub
    const prefix = this.options.sprintPrefix ?? "Sprint";
    import("../github/issues.js")
      .then(async ({ listIssues }) => {
        try {
          const ghIssues = await listIssues({
            milestone: `${prefix} ${sprintNumber}`,
            state: "all",
          });
          const mapped = ghIssues.map((i) => ({
            number: i.number,
            title: i.title,
            status: (i.state === "closed" ? "done" : "planned") as "planned" | "done",
          }));
          this.issueCache?.set(sprintNumber, mapped);
          res.writeHead(200);
          res.end(JSON.stringify(mapped));
        } catch {
          res.writeHead(200);
          res.end(JSON.stringify([]));
        }
      })
      .catch((err) => {
        log.debug({ err: String(err) }, "non-critical dashboard operation failed");
        res.writeHead(200);
        res.end(JSON.stringify([]));
      });
  }

  /** Load historical sprint issues from GitHub (for sprint:switch cache misses). */
  private async loadHistoricalIssues(sprintNumber: number): Promise<IssueEntry[]> {
    const prefix = this.options.sprintPrefix ?? "Sprint";
    try {
      const { listIssues } = await import("../github/issues.js");
      const ghIssues = await listIssues({
        milestone: `${prefix} ${sprintNumber}`,
        state: "all",
      });
      const mapped: IssueEntry[] = ghIssues.map((i) => ({
        number: i.number,
        title: i.title,
        status: (i.state === "closed" ? "done" : "planned") as "planned" | "done",
      }));
      this.issueCache?.set(sprintNumber, mapped);
      return mapped;
    } catch (err: unknown) {
      log.warn({ err, sprintNumber }, "Failed to load historical issues from GitHub");
      return [];
    }
  }

  /** Return backlog issues (open, no milestone, excluding ideas). */
  private handleBacklogRequest(res: http.ServerResponse): void {
    import("../github/issues.js")
      .then(async ({ listIssues }) => {
        try {
          const ghIssues = await listIssues({ state: "open" });
          // Backlog = open issues without a sprint milestone, excluding ideas
          const backlog = ghIssues
            .filter((i) => {
              if (i.milestone) return false;
              if (i.labels.some((l) => l.name === "type:idea")) return false;
              return true;
            })
            .map((i) => ({
              number: i.number,
              title: i.title,
              body: i.body ?? "",
              labels: i.labels.map((l) => l.name),
            }));
          res.writeHead(200);
          res.end(JSON.stringify(backlog));
        } catch {
          res.writeHead(200);
          res.end(JSON.stringify([]));
        }
      })
      .catch(() => {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      });
  }

  /** Return issues planned in the active sprint with full body for detail view. */
  private handleSprintBacklogRequest(res: http.ServerResponse, requestedSprint?: number): void {
    const prefix = this.options.sprintPrefix ?? "Sprint";
    const sprintNum =
      requestedSprint && requestedSprint > 0 ? requestedSprint : (this.activeSprintNumber ?? 1);
    const milestoneName = `${prefix} ${sprintNum}`;
    import("../github/issues.js")
      .then(async ({ listIssues }) => {
        try {
          const ghIssues = await listIssues({ milestone: milestoneName, state: "open" });
          const items = ghIssues.map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body ?? "",
            labels: i.labels.map((l) => l.name),
          }));
          res.writeHead(200);
          res.end(JSON.stringify({ sprintNumber: sprintNum, items }));
        } catch {
          res.writeHead(200);
          res.end(JSON.stringify({ sprintNumber: sprintNum, items: [] }));
        }
      })
      .catch(() => {
        res.writeHead(200);
        res.end(JSON.stringify({ sprintNumber: sprintNum, items: [] }));
      });
  }

  /** Return idea issues (type:idea, awaiting refinement). */
  private handleIdeasRequest(res: http.ServerResponse): void {
    import("../github/issues.js")
      .then(async ({ listIssues }) => {
        try {
          const ghIssues = await listIssues({ state: "open", labels: ["type:idea"] });
          const ideas = ghIssues.map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body ?? "",
            labels: i.labels.map((l) => l.name),
          }));
          res.writeHead(200);
          res.end(JSON.stringify(ideas));
        } catch {
          res.writeHead(200);
          res.end(JSON.stringify([]));
        }
      })
      .catch(() => {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      });
  }

  /** Return blocked issues (status:blocked label) with block reason from comments. */
  private handleBlockedRequest(res: http.ServerResponse): void {
    import("../github/issues.js")
      .then(async ({ listIssues, getComments }) => {
        try {
          const ghIssues = await listIssues({ state: "open", labels: ["status:blocked"] });
          const blocked = await Promise.all(
            ghIssues.map(async (i) => {
              // Extract block reason from the latest "Block reason:" comment
              let blockedReason: string | undefined;
              try {
                const comments = await getComments(i.number, 5);
                const reasonComment = comments.find((c) => c.body.startsWith("**Block reason:**"));
                if (reasonComment) {
                  blockedReason = reasonComment.body.replace("**Block reason:** ", "").trim();
                }
              } catch {
                /* best-effort */
              }
              return {
                number: i.number,
                title: i.title,
                body: (i.body ?? "").slice(0, 500),
                labels: i.labels.map((l) => l.name),
                blockedReason,
              };
            }),
          );
          res.writeHead(200);
          res.end(JSON.stringify(blocked));
        } catch {
          res.writeHead(200);
          res.end(JSON.stringify([]));
        }
      })
      .catch(() => {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      });
  }

  /** Add a comment to a blocked issue. */
  private async handleBlockedComment(
    issueNumber: number,
    body: string,
    ws: WebSocket,
  ): Promise<void> {
    try {
      const { addComment } = await import("../github/issues.js");
      await addComment(issueNumber, body);
      this.sendTo(ws, {
        type: "sprint:event",
        eventName: "blocked:commented",
        payload: { issueNumber },
      });
    } catch (err: unknown) {
      log.error({ err: String(err), issueNumber }, "Failed to add comment to blocked issue");
    }
  }

  /** Remove status:blocked label from an issue. */
  private async handleBlockedUnblock(issueNumber: number, ws: WebSocket): Promise<void> {
    try {
      const { removeLabel } = await import("../github/labels.js");
      await removeLabel(issueNumber, "status:blocked");
      this.sendTo(ws, {
        type: "sprint:event",
        eventName: "blocked:unblocked",
        payload: { issueNumber },
      });
    } catch (err: unknown) {
      log.error({ err: String(err), issueNumber }, "Failed to unblock issue");
    }
  }

  /** Return issues with human-decision-needed label. */
  private handleDecisionsRequest(res: http.ServerResponse): void {
    import("../github/issues.js")
      .then(async ({ listIssues }) => {
        try {
          const ghIssues = await listIssues({ state: "open", labels: ["human-decision-needed"] });
          const decisions = ghIssues.map((i) => ({
            number: i.number,
            title: i.title,
            body: (i.body ?? "").slice(0, 500),
            labels: i.labels.map((l) => l.name),
          }));
          res.writeHead(200);
          res.end(JSON.stringify(decisions));
        } catch {
          res.writeHead(200);
          res.end(JSON.stringify([]));
        }
      })
      .catch(() => {
        res.writeHead(200);
        res.end(JSON.stringify([]));
      });
  }

  /** Approve a decision: remove human-decision-needed label, add status:refined. */
  private async handleDecisionApprove(issueNumber: number, _ws: WebSocket): Promise<void> {
    try {
      const { removeLabel, setLabel } = await import("../github/labels.js");
      await removeLabel(issueNumber, "human-decision-needed");
      await setLabel(issueNumber, "status:refined");
      this.broadcast({
        type: "sprint:event",
        eventName: "decisions:approved",
        payload: { issueNumber },
      });
    } catch (err: unknown) {
      log.error({ err: String(err), issueNumber }, "Failed to approve decision");
    }
  }

  /** Reject a decision: close the issue. */
  private async handleDecisionReject(issueNumber: number, _ws: WebSocket): Promise<void> {
    try {
      const { closeIssue } = await import("../github/issues.js");
      await closeIssue(issueNumber);
      this.broadcast({
        type: "sprint:event",
        eventName: "decisions:rejected",
        payload: { issueNumber },
      });
    } catch (err: unknown) {
      log.error({ err: String(err), issueNumber }, "Failed to reject decision");
    }
  }

  /** Add a comment to a decision issue. */
  private async handleDecisionComment(
    issueNumber: number,
    body: string,
    _ws: WebSocket,
  ): Promise<void> {
    try {
      const { addComment } = await import("../github/issues.js");
      await addComment(issueNumber, body);
      this.broadcast({
        type: "sprint:event",
        eventName: "decisions:commented",
        payload: { issueNumber },
      });
    } catch (err: unknown) {
      log.error({ err: String(err), issueNumber }, "Failed to comment on decision");
    }
  }

  /** Add an issue to the current sprint (set milestone + status:planned label). */
  private async handlePlanIssue(
    issueNumber: number,
    ws: WebSocket,
    targetSprint?: number,
  ): Promise<void> {
    const sprintNum = targetSprint ?? this.activeSprintNumber ?? 1;
    const prefix = this.options.sprintPrefix ?? "Sprint";
    const milestoneTitle = `${prefix} ${sprintNum}`;
    try {
      const { setLabel, removeLabel } = await import("../github/labels.js");
      const { setMilestone, createMilestone, getMilestone } =
        await import("../github/milestones.js");
      // Ensure milestone exists
      const existing = await getMilestone(milestoneTitle);
      if (!existing) {
        await createMilestone(milestoneTitle);
      }
      await setMilestone(issueNumber, milestoneTitle);
      await setLabel(issueNumber, "status:planned");
      try {
        await removeLabel(issueNumber, "status:refined");
      } catch {
        /* may not have it */
      }
      log.info({ issueNumber, milestoneTitle }, "Issue added to sprint");
      this.sendTo(ws, {
        type: "backlog:planned",
        payload: { issueNumber, sprintNumber: sprintNum },
      } as ServerMessage);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, issueNumber }, "Failed to plan issue");
      this.sendTo(ws, {
        type: "backlog:error",
        payload: { issueNumber, error: msg },
      } as ServerMessage);
    }
  }

  /** Remove an issue from the sprint (remove milestone + planned label). */
  private async handleRemoveFromSprint(issueNumber: number, ws: WebSocket): Promise<void> {
    try {
      const { setLabel, removeLabel } = await import("../github/labels.js");
      const { removeMilestone } = await import("../github/milestones.js");
      await removeLabel(issueNumber, "status:planned");
      await setLabel(issueNumber, "status:refined");
      await removeMilestone(issueNumber);
      log.info({ issueNumber }, "Issue removed from sprint");
      this.sendTo(ws, { type: "backlog:removed", payload: { issueNumber } } as ServerMessage);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, issueNumber }, "Failed to remove issue from sprint");
      this.sendTo(ws, {
        type: "backlog:error",
        payload: { issueNumber, error: msg },
      } as ServerMessage);
    }
  }

  /** Return repo info (URL cached after first detection). */
  private async handleRepoInfo(res: http.ServerResponse): Promise<void> {
    if (!this.repoUrl) {
      this.repoUrl = await this.detectRepoUrl();
    }
    res.writeHead(200);
    res.end(JSON.stringify({ url: this.repoUrl }));
  }

  /** Detect GitHub repo URL from git remote. */
  private async detectRepoUrl(): Promise<string | null> {
    const execFileAsync = promisify(execFile);
    try {
      const cwd = this.options.projectPath ?? process.cwd();
      const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd });
      const raw = stdout.trim();
      // Convert SSH URLs: git@github.com:owner/repo.git → https://github.com/owner/repo
      if (raw.startsWith("git@")) {
        const match = raw.match(/git@([^:]+):(.+?)(?:\.git)?$/);
        if (match) return `https://${match[1]}/${match[2]}`;
      }
      // HTTPS URLs: strip .git suffix
      return raw.replace(/\.git$/, "");
    } catch {
      log.debug("Could not detect repo URL from git remote");
      return null;
    }
  }

  /** List available sprints by scanning state files, log files, and filling gaps. */
  private listSprints(): {
    sprintNumber: number;
    milestoneNumber?: number;
    phase: string;
    isActive: boolean;
  }[] {
    const projectPath = this.options.projectPath ?? process.cwd();
    const sprintsDir = path.join(projectPath, "docs", "sprints");
    const sprintMap = new Map<
      number,
      { milestoneNumber?: number; phase: string; isActive: boolean }
    >();
    const slug = this.options.sprintSlug ?? "sprint";
    const stateRegex = new RegExp(`^${slug}-(\\d+)-state\\.json$`);
    const logRegex = new RegExp(`^${slug}-(\\d+)-log\\.md$`);

    // Scan for state files ({slug}-N-state.json)
    try {
      const files = fs.readdirSync(sprintsDir);
      for (const file of files) {
        // Match state files
        const stateMatch = file.match(stateRegex);
        if (stateMatch) {
          const num = parseInt(stateMatch[1], 10);
          try {
            const raw = fs.readFileSync(path.join(sprintsDir, file), "utf-8");
            const state = JSON.parse(raw) as { phase?: string };
            sprintMap.set(num, {
              phase: state.phase ?? "unknown",
              isActive: num === this.activeSprintNumber,
            });
          } catch {
            sprintMap.set(num, { phase: "unknown", isActive: false });
          }
        }

        // Match log files ({slug}-N-log.md) — sprints that ran but may not have state files
        const logMatch = file.match(logRegex);
        if (logMatch) {
          const num = parseInt(logMatch[1], 10);
          if (!sprintMap.has(num)) {
            sprintMap.set(num, { phase: "complete", isActive: false });
          }
        }
      }
    } catch {
      // No sprints dir yet
    }

    // Ensure active sprint is in the list
    const activeNum = this.activeSprintNumber;
    if (activeNum && !sprintMap.has(activeNum)) {
      const currentState = this.options.getState();
      sprintMap.set(activeNum, { phase: currentState.phase, isActive: true });
    }

    // Include sprints discovered from GitHub milestones
    for (const ms of this.knownMilestones) {
      if (!sprintMap.has(ms.sprintNumber)) {
        sprintMap.set(ms.sprintNumber, {
          milestoneNumber: ms.milestoneNumber,
          phase: ms.state === "closed" ? "complete" : "init",
          isActive: ms.sprintNumber === activeNum,
        });
      } else {
        // Enrich existing entry with milestoneNumber
        const existing = sprintMap.get(ms.sprintNumber)!;
        if (!existing.milestoneNumber) {
          existing.milestoneNumber = ms.milestoneNumber;
        }
      }
    }

    // Fill gaps: if we have sprint 3, ensure 1 and 2 exist too
    if (sprintMap.size > 0) {
      const maxSprint = Math.max(...sprintMap.keys());
      for (let i = 1; i < maxSprint; i++) {
        if (!sprintMap.has(i)) {
          sprintMap.set(i, { phase: "complete", isActive: false });
        }
      }
    }

    return Array.from(sprintMap.entries())
      .map(([num, data]) => ({ sprintNumber: num, ...data }))
      .sort((a, b) => a.sprintNumber - b.sprintNumber);
  }

  /** Load sprint state from disk. */
  private loadSprintState(sprintNumber: number): SprintState | null {
    // If this is the active sprint, return live state
    if (sprintNumber === this.activeSprintNumber) {
      return this.options.getState();
    }

    const projectPath = this.options.projectPath ?? process.cwd();
    const slug = this.options.sprintSlug ?? "sprint";
    const filePath = path.join(
      projectPath,
      "docs",
      "sprints",
      `${slug}-${sprintNumber}-state.json`,
    );
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const state = JSON.parse(raw) as SprintState;
      state.startedAt = new Date(state.startedAt);
      return state;
    } catch {
      // No state file — check for log file to infer completed sprint
      const logPath = path.join(projectPath, "docs", "sprints", `${slug}-${sprintNumber}-log.md`);
      try {
        if (fs.existsSync(logPath)) {
          return {
            version: "1",
            sprintNumber,
            phase: "complete",
            startedAt: new Date(),
          } as SprintState;
        }
      } catch {
        // ignore
      }
      return null;
    }
  }
}
