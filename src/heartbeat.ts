/**
 * HeartbeatSupervisor — background polling loop that monitors sprint state,
 * detects orphaned locks, and emits health status to the dashboard.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger.js";
import { SprintEventBus } from "./events.js";
import type { SprintPhase } from "./runner.js";

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  staleThresholdMs: number;
  /** Directory containing sprint state files (e.g. docs/sprints/) */
  stateDir: string;
  /** Sprint slug prefix for state file names (e.g. "sprint") */
  sprintSlug: string;
}

interface TickResult {
  sprintNumber: number | null;
  phase: SprintPhase | null;
  healthy: boolean;
  staleLock: boolean;
}

export class HeartbeatSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly log = logger.child({ component: "heartbeat" });
  private readonly config: HeartbeatConfig;
  private readonly events: SprintEventBus;
  private lastPhaseChangeAt: number = Date.now();
  private lastPhase: SprintPhase | null = null;

  constructor(config: HeartbeatConfig, events: SprintEventBus) {
    this.config = config;
    this.events = events;
  }

  start(): void {
    if (!this.config.enabled) {
      this.log.info("Heartbeat disabled by config");
      return;
    }
    if (this.timer) return;

    this.log.info({ intervalMs: this.config.intervalMs }, "Heartbeat supervisor started");
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.log.warn({ err: String(err) }, "Heartbeat tick error");
      });
    }, this.config.intervalMs);

    // Initial tick
    this.tick().catch((err) => {
      this.log.warn({ err: String(err) }, "Heartbeat initial tick error");
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info("Heartbeat supervisor stopped");
    }
  }

  /** Single heartbeat tick — reads state, checks locks, emits events */
  async tick(): Promise<TickResult> {
    const result = this.checkState();
    const staleLock = this.checkAndCleanOrphanedLocks();

    const healthy = !staleLock && result.phase !== "failed" && result.phase !== "stopped";

    // Detect phase changes to reset stale timer
    if (result.phase !== this.lastPhase) {
      this.lastPhaseChangeAt = Date.now();
      this.lastPhase = result.phase;
    }

    // Check for stale sprint (phase hasn't changed in threshold time)
    const staleSinceMs = Date.now() - this.lastPhaseChangeAt;
    const isStale = result.phase !== null
      && result.phase !== "complete"
      && result.phase !== "failed"
      && result.phase !== "stopped"
      && result.phase !== "init"
      && staleSinceMs > this.config.staleThresholdMs;

    if (isStale && result.sprintNumber !== null && result.phase !== null) {
      this.events.emitTyped("heartbeat:stale", {
        sprintNumber: result.sprintNumber,
        phase: result.phase,
        staleSinceMs,
      });
    }

    this.events.emitTyped("heartbeat:tick", {
      sprintNumber: result.sprintNumber,
      phase: result.phase,
      healthy: healthy && !isStale,
      staleLock,
      lastTickAt: new Date().toISOString(),
    });

    return { ...result, healthy: healthy && !isStale, staleLock };
  }

  /** Read the latest sprint state file to determine current sprint + phase */
  private checkState(): { sprintNumber: number | null; phase: SprintPhase | null } {
    try {
      const stateDir = this.config.stateDir;
      if (!fs.existsSync(stateDir)) {
        return { sprintNumber: null, phase: null };
      }

      // Find the highest-numbered state file
      const files = fs.readdirSync(stateDir)
        .filter((f) => f.startsWith(this.config.sprintSlug + "-") && f.endsWith("-state.json") && !f.endsWith(".lock"));

      if (files.length === 0) {
        return { sprintNumber: null, phase: null };
      }

      // Extract sprint numbers and sort descending
      const numbered = files.map((f) => {
        const match = f.match(/-(\d+)-state\.json$/);
        return match ? { file: f, num: parseInt(match[1], 10) } : null;
      }).filter(Boolean) as { file: string; num: number }[];

      numbered.sort((a, b) => b.num - a.num);
      if (numbered.length === 0) {
        return { sprintNumber: null, phase: null };
      }

      const latest = numbered[0]!;
      const content = fs.readFileSync(path.join(stateDir, latest.file), "utf-8");
      const state = JSON.parse(content) as { sprintNumber?: number; phase?: string };

      return {
        sprintNumber: state.sprintNumber ?? latest.num,
        phase: (state.phase as SprintPhase) ?? null,
      };
    } catch (err) {
      this.log.debug({ err: String(err) }, "Failed to read sprint state");
      return { sprintNumber: null, phase: null };
    }
  }

  /** Check for orphaned lock files and clean them up. Returns true if any were found. */
  private checkAndCleanOrphanedLocks(): boolean {
    try {
      const stateDir = this.config.stateDir;
      if (!fs.existsSync(stateDir)) return false;

      const lockFiles = fs.readdirSync(stateDir).filter((f) => f.endsWith(".lock"));
      let foundOrphaned = false;

      for (const lockFile of lockFiles) {
        const lockPath = path.join(stateDir, lockFile);
        try {
          const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
          if (isNaN(pid)) {
            // Invalid lock file content — remove it
            fs.unlinkSync(lockPath);
            this.log.info({ lockFile }, "Removed invalid lock file");
            foundOrphaned = true;
            continue;
          }

          // Check if PID is alive
          try {
            process.kill(pid, 0);
            // Process is alive — lock is valid
          } catch {
            // Process is dead — orphaned lock
            fs.unlinkSync(lockPath);
            this.log.info({ lockFile, pid }, "Cleaned orphaned lock file");
            foundOrphaned = true;

            // Extract sprint number for recovery event
            const match = lockFile.match(/-(\d+)-state\.json\.lock$/);
            if (match) {
              this.events.emitTyped("heartbeat:recovered", {
                sprintNumber: parseInt(match[1], 10),
                action: "orphaned_lock_cleaned",
              });
            }
          }
        } catch {
          // Can't read lock file — remove it
          try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
          foundOrphaned = true;
        }
      }

      return foundOrphaned;
    } catch (err) {
      this.log.debug({ err: String(err) }, "Failed to check lock files");
      return false;
    }
  }
}
