/**
 * Chat Manager — manages interactive ACP chat sessions for the web dashboard.
 *
 * Each chat session gets its own ACP session pre-primed with a role-specific
 * system prompt. Responses stream via callbacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AcpClient, ACP_MODES, type SessionInfo } from "../acp/client.js";
import type { PermissionConfig } from "../acp/permissions.js";
import { logger } from "../logger.js";

const log = logger.child({ component: "chat-manager" });

export type ChatRole = "researcher" | "planner" | "reviewer" | "refiner" | "general";

export interface ChatSession {
  id: string;
  role: ChatRole;
  acpSessionId: string;
  model: string;
  createdAt: Date;
  messages: ChatMessage[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

export interface ChatManagerOptions {
  projectPath: string;
  permissions?: PermissionConfig;
  timeoutMs?: number;
  onStreamChunk?: (sessionId: string, text: string) => void;
}

export class ChatManager {
  private client: AcpClient | null = null;
  private sessions = new Map<string, ChatSession>();
  private primingPromises = new Map<string, Promise<void>>();
  private readonly options: ChatManagerOptions;
  private connected = false;

  constructor(options: ChatManagerOptions) {
    this.options = options;
  }

  /** Ensure ACP client is connected. Lazy-connects on first use. */
  private async ensureClient(): Promise<AcpClient> {
    if (this.client && this.connected) return this.client;

    this.client = new AcpClient({
      timeoutMs: this.options.timeoutMs ?? 600_000,
      permissions: this.options.permissions ?? {
        autoApprove: true,
        allowPatterns: [],
      },
      onStreamChunk: (acpSessionId, text) => {
        // Find our chat session by ACP session ID and relay chunk
        for (const [chatId, session] of this.sessions) {
          if (session.acpSessionId === acpSessionId) {
            this.options.onStreamChunk?.(chatId, text);
            break;
          }
        }
      },
    });

    await this.client.connect();
    this.connected = true;
    log.info("Chat ACP client connected");
    return this.client;
  }

  /** Create a new chat session with a specific role. */
  async createSession(role: ChatRole): Promise<ChatSession> {
    const client = await this.ensureClient();

    const sessionInfo: SessionInfo = await client.createSession({
      cwd: this.options.projectPath,
    });

    // Set to agent mode
    await client.setMode(sessionInfo.sessionId, ACP_MODES.AGENT);

    const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const session: ChatSession = {
      id: chatId,
      role,
      acpSessionId: sessionInfo.sessionId,
      model: sessionInfo.currentModel,
      createdAt: new Date(),
      messages: [],
    };

    this.sessions.set(chatId, session);

    // Prime with role system prompt in background — don't block session creation
    const systemPrompt = this.buildSystemPrompt(role);
    log.info({ chatId, role, acpSessionId: sessionInfo.sessionId }, "Chat session created, priming in background");

    const primingPromise = client.sendPrompt(sessionInfo.sessionId, systemPrompt, 120_000)
      .then(() => { this.primingPromises.delete(chatId); })
      .catch((err) => {
        log.error({ chatId, err }, "Failed to prime chat session with system prompt");
        this.primingPromises.delete(chatId);
      });
    this.primingPromises.set(chatId, primingPromise);

    return session;
  }

  /** Send a message in an existing chat session. Returns the assistant's response. */
  async sendMessage(chatId: string, message: string): Promise<string> {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`Chat session ${chatId} not found`);

    // Wait for system prompt priming to finish before sending user message
    const priming = this.primingPromises.get(chatId);
    if (priming) {
      log.info({ chatId }, "Waiting for system prompt priming to complete");
      await priming;
    }

    const client = await this.ensureClient();

    session.messages.push({
      role: "user",
      content: message,
      timestamp: new Date(),
    });

    log.info({ chatId, messageLength: message.length }, "Sending chat message");

    const result = await client.sendPrompt(
      session.acpSessionId,
      message,
      this.options.timeoutMs ?? 600_000,
    );

    session.messages.push({
      role: "assistant",
      content: result.response,
      timestamp: new Date(),
    });

    return result.response;
  }

  /** Close a chat session. */
  async closeSession(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;

    if (this.client) {
      await this.client.endSession(session.acpSessionId);
    }

    this.sessions.delete(chatId);
    log.info({ chatId }, "Chat session closed");
  }

  /** Get a chat session by ID. */
  getSession(chatId: string): ChatSession | undefined {
    return this.sessions.get(chatId);
  }

  /** List all active chat sessions. */
  listSessions(): ChatSession[] {
    return Array.from(this.sessions.values());
  }

  /** Disconnect the ACP client and close all sessions. */
  async shutdown(): Promise<void> {
    for (const [chatId] of this.sessions) {
      await this.closeSession(chatId);
    }
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
      this.connected = false;
    }
    log.info("Chat manager shut down");
  }

  private buildSystemPrompt(role: ChatRole): string {
    const roleDir = path.join(this.options.projectPath, ".aiscrum", "roles", role);
    const roleContext = this.loadRoleContext(roleDir);

    if (!roleContext) {
      return `You are a ${role} assistant. Respond helpfully and concisely.`;
    }

    return `${roleContext}\n\nYou are in an interactive chat session. Respond helpfully and concisely.`;
  }

  /** Recursively load all .md files from a role directory. */
  private loadRoleContext(dir: string): string | null {
    try {
      if (!fs.existsSync(dir)) return null;

      const parts: string[] = [];
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "log") return;
            walk(full);
          } else if (entry.name.endsWith(".md")) {
            parts.push(fs.readFileSync(full, "utf-8"));
          }
        }
      };
      walk(dir);

      if (parts.length === 0) return null;
      log.info({ dir, fileCount: parts.length }, "Loaded role context");
      return parts.join("\n\n---\n\n");
    } catch {
      return null;
    }
  }
}
