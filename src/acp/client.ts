import { spawn, type ChildProcess } from "node:child_process";
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type McpServer,
} from "@agentclientprotocol/sdk";
import { logger as defaultLogger, type Logger } from "../logger.js";
import {
  createPermissionHandler,
  type PermissionConfig,
  DEFAULT_PERMISSION_CONFIG,
} from "./permissions.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const ACP_MAX_RETRIES = 3;

/** Check if an ACP error is transient and worth retrying. */
function isTransientAcpError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  // Process exit is NOT transient — the connection is gone
  if (msg.includes("process exited")) return false;
  return msg.includes("timeout") || msg.includes("timed out") ||
         msg.includes("econnreset") || msg.includes("econnrefused");
}

export interface AcpClientOptions {
  /** Path to the copilot CLI binary. Defaults to "copilot". */
  command?: string;
  /** Additional CLI args passed before --acp --stdio. */
  args?: string[];
  /** Permission handling configuration. */
  permissions?: PermissionConfig;
  /** Default session timeout in ms. */
  timeoutMs?: number;
  /** Logger instance. */
  logger?: Logger;
  /** Callback for streaming text chunks from ACP sessions. */
  onStreamChunk?: (sessionId: string, text: string) => void;
  /** Callback for agent thinking/reasoning chunks. */
  onThinkingChunk?: (sessionId: string, text: string) => void;
  /** Callback for tool call events. */
  onToolCall?: (sessionId: string, toolCall: AcpToolCallEvent) => void;
  /** Callback for usage/token updates. */
  onUsageUpdate?: (sessionId: string, usage: AcpUsageEvent) => void;
}

export interface AcpToolCallEvent {
  toolCallId: string;
  title: string;
  status?: string;
  kind?: string;
  locations?: Array<{ uri?: string; range?: unknown }>;
}

export interface AcpUsageEvent {
  used: number;
  size: number;
  cost?: { amount?: number; currency?: string } | null;
}

export interface CreateSessionOptions {
  /** Absolute working directory for the session. */
  cwd: string;
  /** MCP servers to connect in the session. */
  mcpServers?: McpServer[];
}

export interface PromptResult {
  /** Concatenated text from agent_message_chunk updates. */
  response: string;
  /** The stop reason from the prompt response. */
  stopReason: string;
}

export interface SessionInfo {
  sessionId: string;
  availableModes: string[];
  currentMode: string;
  availableModels: string[];
  currentModel: string;
}

/** Well-known ACP session mode IDs. */
export const ACP_MODES = {
  AGENT: "https://agentclientprotocol.com/protocol/session-modes#agent",
  PLAN: "https://agentclientprotocol.com/protocol/session-modes#plan",
  AUTOPILOT: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
} as const;

export class AcpClient {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private connecting: Promise<void> | null = null;
  private readonly log: Logger;
  private readonly command: string;
  private readonly extraArgs: string[];
  private readonly permissionHandler: (
    params: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  private readonly defaultTimeoutMs: number;
  private readonly onStreamChunk?: (sessionId: string, text: string) => void;
  private readonly onThinkingChunk?: (sessionId: string, text: string) => void;
  private readonly onToolCall?: (sessionId: string, toolCall: AcpToolCallEvent) => void;
  private readonly onUsageUpdate?: (sessionId: string, usage: AcpUsageEvent) => void;

  // Accumulate streamed chunks per session
  private sessionChunks = new Map<string, string[]>();

  // Track in-flight prompt promises so we can reject them if the process exits
  private inFlightPromises = new Set<{ reject: (err: Error) => void }>();

  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private static readonly CIRCUIT_FAILURE_THRESHOLD = 3;
  private static readonly CIRCUIT_RESET_MS = 60_000; // 1 minute

  constructor(options: AcpClientOptions = {}) {
    this.log = options.logger ?? defaultLogger.child({ component: "acp-client" });
    this.command = options.command ?? "copilot";
    this.extraArgs = options.args ?? [];
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onStreamChunk = options.onStreamChunk;
    this.onThinkingChunk = options.onThinkingChunk;
    this.onToolCall = options.onToolCall;
    this.onUsageUpdate = options.onUsageUpdate;
    this.permissionHandler = createPermissionHandler(
      options.permissions ?? DEFAULT_PERMISSION_CONFIG,
      this.log,
    );
  }

  /**
   * Spawn the Copilot CLI as an ACP server and establish the connection.
   */
  async connect(): Promise<void> {
    // If already connecting, reuse the in-flight promise
    if (this.connecting) {
      return this.connecting;
    }

    if (this.connection) {
      throw new Error("AcpClient is already connected");
    }

    this.connecting = (async () => {
      const args = [...this.extraArgs, "--acp", "--stdio"];
      this.log.info({ command: this.command, args }, "spawning copilot ACP server");

      this.process = spawn(this.command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      const proc = this.process;

      // Forward stderr for diagnostics
      proc.stderr?.on("data", (chunk: Buffer) => {
        this.log.debug({ stderr: chunk.toString().trimEnd() }, "copilot stderr");
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          const msg = `copilot CLI not found at '${this.command}'. Install GitHub Copilot CLI: https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line`;
          this.log.error(msg);
          this.rejectAllInFlight(new Error(msg));
        } else {
          this.log.error({ err }, "copilot process error");
          this.rejectAllInFlight(new Error(`ACP process error: ${err.message}`));
        }
      });

      proc.on("exit", (code, signal) => {
        this.log.info({ code, signal }, "copilot process exited");
        this.connection = null;
        this.process = null;
        this.rejectAllInFlight(
          new Error(`ACP process exited unexpectedly (code=${code}, signal=${signal})`),
        );
      });

      if (!proc.stdin || !proc.stdout) {
        throw new Error("Failed to access copilot process stdio streams");
      }

      // Convert Node streams to web streams for the ACP SDK
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            const ok = proc.stdin!.write(chunk, (err) => {
              if (err) reject(err);
            });
            if (ok) resolve();
            else proc.stdin!.once("drain", resolve);
          });
        },
        close() {
          proc.stdin!.end();
        },
      });

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          proc.stdout!.on("data", (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          proc.stdout!.on("end", () => controller.close());
          proc.stdout!.on("error", (err) => controller.error(err));
        },
      });

      const stream = ndJsonStream(writable, readable);

      const permissionHandler = this.permissionHandler;
      const sessionChunks = this.sessionChunks;
      const log = this.log;
      const onChunk = this.onStreamChunk;
      const onThinking = this.onThinkingChunk;
      const onTool = this.onToolCall;
      const onUsage = this.onUsageUpdate;

      this.connection = new ClientSideConnection(
        (_agent) => {
          const client: Client = {
            async requestPermission(
              params: RequestPermissionRequest,
            ): Promise<RequestPermissionResponse> {
              return permissionHandler(params);
            },
            async sessionUpdate(params: SessionNotification): Promise<void> {
              const update = params.update;
              const sid = params.sessionId;

              if (update.sessionUpdate === "agent_message_chunk") {
                const content = update.content;
                if (content.type === "text") {
                  const chunks = sessionChunks.get(sid) ?? [];
                  chunks.push(content.text);
                  sessionChunks.set(sid, chunks);
                  onChunk?.(sid, content.text);
                }
              } else if (update.sessionUpdate === "agent_thought_chunk") {
                const content = (update as Record<string, unknown>).content as { type?: string; text?: string } | undefined;
                if (content?.type === "text" && content.text) {
                  onThinking?.(sid, content.text);
                }
              } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
                const tc = update as Record<string, unknown>;
                onTool?.(sid, {
                  toolCallId: String(tc.toolCallId ?? ""),
                  title: String(tc.title ?? ""),
                  status: tc.status as string | undefined,
                  kind: tc.kind as string | undefined,
                  locations: tc.locations as Array<{ uri?: string; range?: unknown }> | undefined,
                });
              } else if (update.sessionUpdate === "usage_update") {
                const u = update as Record<string, unknown>;
                onUsage?.(sid, {
                  used: Number(u.used ?? 0),
                  size: Number(u.size ?? 0),
                  cost: u.cost as AcpUsageEvent["cost"],
                });
              }

              log.debug(
                { sessionId: sid, type: update.sessionUpdate },
                "session update",
              );
            },
          };
          return client;
        },
        stream,
      );

      // Initialize the connection
      await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "sprint-runner", version: "0.1.0" },
        capabilities: {},
      });

      this.log.info("ACP connection established");
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Create a new ACP session.
   */
  async createSession(options: CreateSessionOptions): Promise<SessionInfo> {
    const conn = this.requireConnection();

    this.log.info({ cwd: options.cwd }, "creating ACP session");

    const response = await conn.newSession({
      cwd: options.cwd,
      mcpServers: options.mcpServers ?? [],
    });

    const sessionId = response.sessionId;
    this.sessionChunks.set(sessionId, []);

    const modes = response.modes;
    const models = response.models;

    const info: SessionInfo = {
      sessionId,
      availableModes: modes?.availableModes.map((m: { id: string }) => m.id) ?? [],
      currentMode: modes?.currentModeId ?? "",
      availableModels: models?.availableModels.map((m: { modelId: string }) => m.modelId) ?? [],
      currentModel: models?.currentModelId ?? "",
    };

    this.log.info(
      { sessionId, mode: info.currentMode, model: info.currentModel },
      "ACP session created",
    );

    return info;
  }

  /**
   * Switch the session to a different mode (agent, plan, autopilot).
   */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    const conn = this.requireConnection();
    this.log.info({ sessionId, modeId }, "setting session mode");
    await conn.setSessionMode({ sessionId, modeId });
  }

  /**
   * Switch the session to a different model.
   */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    const conn = this.requireConnection();
    this.log.info({ sessionId, modelId }, "setting session model");
    await conn.unstable_setSessionModel({ sessionId, modelId });
  }

  /**
   * Send a prompt and collect the full streamed response.
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    timeoutMs?: number,
  ): Promise<PromptResult> {
    this.checkCircuitBreaker();

    const conn = this.requireConnection();
    const timeout = timeoutMs ?? this.defaultTimeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt <= ACP_MAX_RETRIES; attempt++) {
      try {
        // Reset chunk buffer for this turn
        this.sessionChunks.set(sessionId, []);

        this.log.info(
          { sessionId, promptLength: prompt.length },
          "sending prompt",
        );

        const promptPromise = conn.prompt({
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });

        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`Prompt timed out after ${timeout}ms`));
          }, timeout);
          // Allow the process to exit even if the timer is still active
          if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
          }
        });

        // Track this promise so process exit can reject it
        const tracker = { reject: (_err: Error) => {} };
        const processExitPromise = new Promise<never>((_resolve, reject) => {
          tracker.reject = reject;
        });
        this.inFlightPromises.add(tracker);

        try {
          const result = await Promise.race([promptPromise, timeoutPromise, processExitPromise]);

          const chunks = this.sessionChunks.get(sessionId) ?? [];
          const response = chunks.join("");

          this.log.info(
            { sessionId, stopReason: result.stopReason, responseLength: response.length },
            "prompt completed",
          );

          this.consecutiveFailures = 0;

          return {
            response,
            stopReason: result.stopReason,
          };
        } finally {
          this.inFlightPromises.delete(tracker);
        }
      } catch (err) {
        this.consecutiveFailures++;
        this.circuitOpenUntil = Date.now() + AcpClient.CIRCUIT_RESET_MS;
        lastError = err;
        if (attempt < ACP_MAX_RETRIES && isTransientAcpError(err)) {
          const delay = 1000 * Math.pow(2, attempt);
          this.log.warn(
            { sessionId, attempt: attempt + 1, maxRetries: ACP_MAX_RETRIES, delay, error: err instanceof Error ? err.message : String(err) },
            "transient ACP error, retrying",
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }
    // Should never reach here, but TypeScript needs this
    throw lastError;
  }

  /**
   * Get the last N lines of output from a session.
   * Must be called before endSession() which clears the chunks.
   */
  getSessionOutput(sessionId: string, lastNLines = 50): string[] {
    const chunks = this.sessionChunks.get(sessionId);
    if (!chunks || chunks.length === 0) {
      return [];
    }
    const fullText = chunks.join("");
    const lines = fullText.split("\n").filter((line) => line.trim() !== "");
    return lines.slice(-lastNLines);
  }

  /**
   * End an ACP session cleanly.
   */
  async endSession(sessionId: string): Promise<void> {
    this.log.info({ sessionId }, "ending session");
    this.sessionChunks.delete(sessionId);
    // The ACP spec doesn't have an explicit session/end method;
    // cleanup is handled by the agent when the connection closes
    // or when a new session replaces the old one.
  }

  /**
   * Kill the copilot process and clean up.
   */
  async disconnect(): Promise<void> {
    // If a connect() is in progress, wait for it before tearing down
    if (this.connecting) {
      try {
        await this.connecting;
      } catch {
        // connect() failed — proceed with cleanup
      }
    }

    this.log.info("disconnecting ACP client");

    this.sessionChunks.clear();
    this.inFlightPromises.clear();

    if (this.process) {
      const proc = this.process;
      this.process = null;
      this.connection = null;

      // Give the process a moment to exit gracefully
      const exitPromise = new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(() => resolve(), 3000).unref();
      });

      proc.kill("SIGTERM");
      await exitPromise;

      // Force kill if still running
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
    }

    this.connection = null;
    this.log.info("ACP client disconnected");
  }

  /** Returns whether the client has an active connection. */
  get connected(): boolean {
    return this.connection !== null && this.process !== null;
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new Error("AcpClient is not connected — call connect() first");
    }
    return this.connection;
  }

  private checkCircuitBreaker(): void {
    if (
      this.consecutiveFailures >= AcpClient.CIRCUIT_FAILURE_THRESHOLD &&
      Date.now() < this.circuitOpenUntil
    ) {
      throw new Error(
        `ACP circuit breaker open — ${this.consecutiveFailures} consecutive failures. Retry after ${new Date(this.circuitOpenUntil).toISOString()}`,
      );
    }
    if (Date.now() >= this.circuitOpenUntil) {
      this.consecutiveFailures = 0;
    }
  }

  private rejectAllInFlight(err: Error): void {
    for (const tracker of this.inFlightPromises) {
      tracker.reject(err);
    }
    this.inFlightPromises.clear();
  }
}
