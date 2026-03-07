/**
 * Sprint Issue Cache
 *
 * In-memory cache for sprint issues. Preloads on start, serves instantly,
 * refreshes in the background on a configurable interval.
 */

import { listIssues, type GitHubIssue } from "../github/issues.js";
import { logger } from "../logger.js";
import type { SprintState } from "../runner.js";

const log = logger.child({ component: "issue-cache" });

export interface CachedIssue {
  number: number;
  title: string;
  status: "planned" | "in-progress" | "done" | "failed";
}

export interface IssueCacheOptions {
  /** How often to refresh from GitHub (ms). Default: 60_000 (1 min). */
  refreshIntervalMs?: number;
  /** Maximum sprint number to preload. */
  maxSprint: number;
  /** Function to load saved sprint state from disk. */
  loadState?: (sprintNumber: number) => SprintState | null;
  /** Sprint prefix for milestone queries (default: "Sprint"). */
  sprintPrefix?: string;
}

export class SprintIssueCache {
  private cache = new Map<number, CachedIssue[]>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly options: IssueCacheOptions;
  private loading = new Set<number>();

  constructor(options: IssueCacheOptions) {
    this.options = options;
  }

  /** Get cached issues for a sprint. Returns [] if not cached yet. */
  get(sprintNumber: number): CachedIssue[] {
    return this.cache.get(sprintNumber) ?? [];
  }

  /** Check if a sprint's issues are cached. */
  has(sprintNumber: number): boolean {
    return this.cache.has(sprintNumber);
  }

  /** Set issues for a sprint (used by active sprint tracking). */
  set(sprintNumber: number, issues: CachedIssue[]): void {
    this.cache.set(sprintNumber, issues);
  }

  /** Preload issues for all sprints from 1 to maxSprint. */
  async preload(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let i = 1; i <= this.options.maxSprint; i++) {
      promises.push(this.loadSprint(i));
    }
    await Promise.allSettled(promises);
    log.info({ sprints: this.cache.size }, "Issue cache preloaded");
  }

  /** Start background refresh timer. */
  startRefresh(): void {
    const interval = this.options.refreshIntervalMs ?? 60_000;
    this.refreshTimer = setInterval(() => {
      this.refreshAll().catch((err) => {
        log.warn({ err }, "Background issue cache refresh failed");
      });
    }, interval);
    // Don't keep process alive just for refresh
    if (this.refreshTimer && "unref" in this.refreshTimer) {
      this.refreshTimer.unref();
    }
  }

  /** Stop background refresh. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Refresh all cached sprints from GitHub (ignores saved state). */
  private async refreshAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let i = 1; i <= this.options.maxSprint; i++) {
      promises.push(this.refreshFromGitHub(i));
    }
    await Promise.allSettled(promises);
  }

  /** Load issues for a single sprint. Tries saved state first, then GitHub. */
  private async loadSprint(sprintNumber: number): Promise<void> {
    // Prevent concurrent loads for the same sprint
    if (this.loading.has(sprintNumber)) return;
    this.loading.add(sprintNumber);

    try {
      // Try saved state first (instant, no API call) — only for initial preload
      if (this.options.loadState) {
        const state = this.options.loadState(sprintNumber);
        if (state?.result?.results && state.result.results.length > 0) {
          this.cache.set(
            sprintNumber,
            state.result.results.map((r) => ({
              number: r.issueNumber,
              title: `Issue #${r.issueNumber}`,
              status: (r.status === "completed" ? "done" : "failed") as CachedIssue["status"],
            })),
          );
          return;
        }
        if (state?.plan?.sprint_issues && state.plan.sprint_issues.length > 0) {
          this.cache.set(
            sprintNumber,
            state.plan.sprint_issues.map((i) => ({
              number: i.number,
              title: i.title,
              status: "planned" as const,
            })),
          );
          return;
        }
      }

      await this.fetchFromGitHub(sprintNumber);
    } catch (err: unknown) {
      log.debug({ err, sprintNumber }, "Failed to load issues for sprint");
      // Don't overwrite existing cache on failure
      if (!this.cache.has(sprintNumber)) {
        this.cache.set(sprintNumber, []);
      }
    } finally {
      this.loading.delete(sprintNumber);
    }
  }

  /** Refresh a single sprint from GitHub (for background refresh — skips saved state). */
  private async refreshFromGitHub(sprintNumber: number): Promise<void> {
    if (this.loading.has(sprintNumber)) return;
    this.loading.add(sprintNumber);
    try {
      await this.fetchFromGitHub(sprintNumber);
    } catch (err: unknown) {
      log.debug({ err, sprintNumber }, "Failed to refresh issues for sprint");
    } finally {
      this.loading.delete(sprintNumber);
    }
  }

  /** Fetch issues from GitHub milestone and update cache. */
  private async fetchFromGitHub(sprintNumber: number): Promise<void> {
    const ghIssues = await listIssues({
      milestone: `${this.options.sprintPrefix ?? "Sprint"} ${sprintNumber}`,
      state: "all",
    });

    if (ghIssues.length > 0) {
      this.cache.set(
        sprintNumber,
        ghIssues.map((i: GitHubIssue) => ({
          number: i.number,
          title: i.title,
          status: (i.state.toLowerCase() === "closed"
            ? "done"
            : "planned") as CachedIssue["status"],
        })),
      );
    } else {
      this.cache.set(sprintNumber, []);
    }
  }
}
