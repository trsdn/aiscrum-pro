// Typed event system for SprintRunner → TUI communication.

import { EventEmitter } from "node:events";
import type { SprintPhase } from "./runner.js";
import type { SprintIssue, QualityResult } from "./types.js";

export interface SprintEngineEvents {
  "phase:change": { from: SprintPhase; to: SprintPhase; model?: string; agent?: string };
  "issue:start": { issue: SprintIssue; model?: string };
  "issue:progress": { issueNumber: number; step: string };
  "issue:done": { issueNumber: number; quality: QualityResult; duration_ms: number };
  "issue:fail": { issueNumber: number; reason: string; duration_ms: number };
  "worker:output": { sessionId: string; text: string };
  "session:start": { sessionId: string; role: string; issueNumber?: number; model?: string };
  "session:end": { sessionId: string };
  "sprint:start": { sprintNumber: number; resumed?: boolean };
  "sprint:planned": { issues: { number: number; title: string }[] };
  "sprint:complete": { sprintNumber: number };
  "sprint:stopped": { sprintNumber: number };
  "sprint:error": { error: string };
  "sprint:paused": Record<string, never>;
  "sprint:resumed": { phase: SprintPhase };
  "log": { level: "info" | "warn" | "error"; message: string };
}

type EventKey = keyof SprintEngineEvents;

/**
 * Type-safe event bus for SprintRunner ↔ UI communication.
 *
 * Wraps Node's EventEmitter with typed `emitTyped` / `onTyped` methods
 * so callers get compile-time safety on event names and payloads.
 */
export class SprintEventBus extends EventEmitter {
  /** Emit an event with a type-checked payload. */
  emitTyped<K extends EventKey>(event: K, payload: SprintEngineEvents[K]): void {
    this.emit(event, payload);
  }

  /** Subscribe to an event with a type-checked listener. */
  onTyped<K extends EventKey>(event: K, listener: (payload: SprintEngineEvents[K]) => void): this {
    return this.on(event, listener as (...args: unknown[]) => void);
  }
}
