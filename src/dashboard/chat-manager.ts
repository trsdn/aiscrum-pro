/**
 * Chat Manager — manages interactive ACP chat sessions for the web dashboard.
 *
 * Each chat session gets its own ACP session. The agent loads role context
 * from .aiscrum/roles/ automatically via copilot-instructions.md.
 */

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
  onThinkingChunk?: (sessionId: string, text: string) => void;
  onToolCall?: (sessionId: string, toolCall: { toolCallId: string; title: string; status?: string; kind?: string }) => void;
  onUsageUpdate?: (sessionId: string, usage: { used: number; size: number }) => void;
  onModeChange?: (sessionId: string, modeId: string) => void;
  onPlanUpdate?: (sessionId: string, plan: { entries: Array<{ content: string; priority: string; status: string }> }) => void;
  onCommandsUpdate?: (sessionId: string, commands: Array<{ name: string; description: string; hint?: string }>) => void;
  onConfigUpdate?: (sessionId: string, configs: Array<{ id: string; name: string; category?: string; currentValue: string; options: Array<{ value: string; name: string }> }>) => void;
}

export class ChatManager {
  private client: AcpClient | null = null;
  private sessions = new Map<string, ChatSession>();
  private pendingConfigs = new Map<string, Array<{ id: string; name: string; category?: string; currentValue: string; options: Array<{ value: string; name: string }> }>>();
  private readonly options: ChatManagerOptions;
  private connected = false;

  constructor(options: ChatManagerOptions) {
    this.options = options;
  }

  /** Find the chat ID for an ACP session ID. */
  private findChatId(acpSessionId: string): string | undefined {
    for (const [chatId, session] of this.sessions) {
      if (session.acpSessionId === acpSessionId) return chatId;
    }
    return undefined;
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
        const chatId = this.findChatId(acpSessionId);
        if (chatId) this.options.onStreamChunk?.(chatId, text);
      },
      onThinkingChunk: (acpSessionId, text) => {
        const chatId = this.findChatId(acpSessionId);
        if (chatId) this.options.onThinkingChunk?.(chatId, text);
      },
      onToolCall: (acpSessionId, toolCall) => {
        const chatId = this.findChatId(acpSessionId);
        if (chatId) this.options.onToolCall?.(chatId, toolCall);
      },
      onUsageUpdate: (acpSessionId, usage) => {
        const chatId = this.findChatId(acpSessionId);
        if (chatId) this.options.onUsageUpdate?.(chatId, usage);
      },
      onModeChange: (acpSessionId, modeId) => {
        const chatId = this.findChatId(acpSessionId);
        if (chatId) this.options.onModeChange?.(chatId, modeId);
      },
      onPlanUpdate: (acpSessionId, plan) => {
        const chatId = this.findChatId(acpSessionId);
        if (chatId) this.options.onPlanUpdate?.(chatId, plan);
      },
      onCommandsUpdate: (acpSessionId, commands) => {
        const chatId = this.findChatId(acpSessionId);
        if (chatId) this.options.onCommandsUpdate?.(chatId, commands);
      },
      onConfigUpdate: (acpSessionId, configs) => {
        const chatId = this.findChatId(acpSessionId);
        if (chatId) {
          this.options.onConfigUpdate?.(chatId, configs);
        } else {
          // Buffer configs that arrive before session is registered
          this.pendingConfigs.set(acpSessionId, configs);
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
    log.info({ chatId, role, acpSessionId: sessionInfo.sessionId }, "Chat session created");

    // Replay any config events that arrived before session was registered
    const pending = this.pendingConfigs.get(sessionInfo.sessionId);
    if (pending) {
      this.pendingConfigs.delete(sessionInfo.sessionId);
      this.options.onConfigUpdate?.(chatId, pending);
    }

    return session;
  }

  /** Send a message in an existing chat session. Returns the assistant's response. */
  async sendMessage(chatId: string, message: string): Promise<string> {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`Chat session ${chatId} not found`);

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

  /** Set the ACP mode for a chat session. */
  async setMode(chatId: string, modeId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`Chat session ${chatId} not found`);
    const client = await this.ensureClient();
    await client.setMode(session.acpSessionId, modeId);
    log.info({ chatId, modeId }, "Chat session mode changed");
  }

  /** Set a config option for a chat session. */
  async setConfig(chatId: string, optionId: string, value: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`Chat session ${chatId} not found`);
    const client = await this.ensureClient();
    await client.setConfigOption(session.acpSessionId, optionId, value);
    log.info({ chatId, optionId, value }, "Chat session config changed");
  }

  /** Cancel an in-progress prompt turn. */
  async cancelSession(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) throw new Error(`Chat session ${chatId} not found`);
    const client = await this.ensureClient();
    await client.cancelSession(session.acpSessionId);
    log.info({ chatId }, "Chat session cancelled");
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
}
