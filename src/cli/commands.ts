/**
 * CLI command definitions — all 13 commands registered on the Commander program.
 */

import type { Command } from "commander";
import * as path from "node:path";
import { prefixToSlug } from "../config.js";
import { runSprintPlanning } from "../ceremonies/planning.js";
import { executeIssue } from "../ceremonies/execution.js";
import { runParallelExecution } from "../ceremonies/parallel-dispatcher.js";
import { runRefinement } from "../ceremonies/refinement.js";
import { runSprintReview } from "../ceremonies/review.js";
import { runSprintRetro } from "../ceremonies/retro.js";
import { runQualityGate, type QualityGateConfig } from "../enforcement/quality-gate.js";
import { getIssue, listIssues } from "../github/issues.js";
import { readSprintLog } from "../documentation/sprint-log.js";
import { holisticDriftCheck } from "../enforcement/drift-control.js";
import { getNextOpenMilestone } from "../github/milestones.js";
import { SprintRunner } from "../runner.js";
import { SprintEventBus } from "../events.js";
import { attachSprintNotifications } from "../notifications/sprint-notifications.js";
import { logger, redirectLogToFile, initErrorLogFile } from "../logger.js";
import type { SprintIssue } from "../types.js";
import {
  buildSprintConfig,
  createConnectedClient,
  loadConfigFromOpts,
  parseSprintNumber,
  parseIssueNumber,
} from "./helpers.js";
import { validateConfig, formatReport } from "../validation/config-validator.js";
import { initProject } from "./init.js";

/** Register all CLI commands on the given Commander program. */
export function registerCommands(program: Command): void {
  registerPlan(program);
  registerExecuteIssue(program);
  registerCheckQuality(program);
  registerRefine(program);
  registerFullCycle(program);
  registerWeb(program);
  registerReview(program);
  registerRetro(program);
  registerStatus(program);
  registerPause(program);
  registerResume(program);
  registerMetrics(program);
  registerDriftReport(program);
  registerInit(program);
  registerValidate(program);
}

// --- plan ---
function registerPlan(program: Command): void {
  program
    .command("plan")
    .description("Run sprint planning")
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .option("--dry-run", "Plan without executing", false)
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        const sprintConfig = buildSprintConfig(config, opts.sprint);
        logger.info({ sprint: opts.sprint, dryRun: opts.dryRun }, "Starting sprint planning");

        const client = await createConnectedClient(config);
        try {
          const plan = await runSprintPlanning(client, sprintConfig);
          console.log("\n✅ Sprint plan created:");
          console.log(`  Sprint: ${plan.sprintNumber}`);
          console.log(`  Issues: ${plan.sprint_issues.length}`);
          console.log(`  Estimated points: ${plan.estimated_points}`);
          console.log(`  Rationale: ${plan.rationale}`);
          for (const issue of plan.sprint_issues) {
            console.log(
              `    #${issue.number} — ${issue.title} (${issue.points}pt, ICE=${issue.ice_score})`,
            );
          }
        } finally {
          await client.disconnect();
        }
      } catch (err: unknown) {
        logger.error({ err }, "Sprint planning failed");
        console.error("❌ Sprint planning failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- execute-issue ---
function registerExecuteIssue(program: Command): void {
  program
    .command("execute-issue")
    .description("Execute a single issue")
    .requiredOption("--issue <number>", "Issue number", parseIssueNumber)
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        const sprintConfig = buildSprintConfig(config, opts.sprint);
        logger.info({ issue: opts.issue, sprint: opts.sprint }, "Executing issue");

        // Fetch issue details from GitHub
        const ghIssue = await getIssue(opts.issue);
        const sprintIssue: SprintIssue = {
          number: ghIssue.number,
          title: ghIssue.title,
          ice_score: 0,
          depends_on: [],
          acceptanceCriteria: ghIssue.body ?? "",
          expectedFiles: [],
          points: 1,
        };

        const client = await createConnectedClient(config);
        try {
          const result = await executeIssue(client, sprintConfig, sprintIssue);
          console.log(
            `\n${result.status === "completed" ? "✅" : "❌"} Issue #${result.issueNumber}: ${result.status}`,
          );
          console.log(`  Quality gate: ${result.qualityGatePassed ? "passed" : "failed"}`);
          console.log(`  Branch: ${result.branch}`);
          console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
          console.log(`  Files changed: ${result.filesChanged.length}`);
          console.log(`  Retries: ${result.retryCount}`);
          if (!result.qualityGatePassed) {
            for (const check of result.qualityDetails.checks.filter((c) => !c.passed)) {
              console.log(`    ✗ ${check.name}: ${check.detail}`);
            }
          }
        } finally {
          await client.disconnect();
        }
      } catch (err: unknown) {
        logger.error({ err }, "Issue execution failed");
        console.error("❌ Issue execution failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- check-quality ---
function registerCheckQuality(program: Command): void {
  program
    .command("check-quality")
    .description("Run quality gates on a branch")
    .requiredOption("--branch <name>", "Branch name")
    .option("--base <branch>", "Base branch for diff comparison")
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        const baseBranch = opts.base ?? config.project.base_branch;
        logger.info({ branch: opts.branch, baseBranch }, "Running quality gate");

        const gateConfig: QualityGateConfig = {
          requireTests: config.quality_gates.require_tests,
          requireLint: config.quality_gates.require_lint,
          requireTypes: config.quality_gates.require_types,
          requireBuild: config.quality_gates.require_build,
          maxDiffLines: config.quality_gates.max_diff_lines,
          testCommand: config.quality_gates.test_command,
          lintCommand: config.quality_gates.lint_command,
          typecheckCommand: config.quality_gates.typecheck_command,
          buildCommand: config.quality_gates.build_command,
          customGates: config.quality_gates.custom_gates,
        };

        const result = await runQualityGate(gateConfig, process.cwd(), opts.branch, baseBranch);
        console.log(
          `\n${result.passed ? "✅" : "❌"} Quality gate: ${result.passed ? "PASSED" : "FAILED"}`,
        );
        for (const check of result.checks) {
          console.log(`  ${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`);
        }
        if (!result.passed) process.exit(1);
      } catch (err: unknown) {
        logger.error({ err }, "Quality gate check failed");
        console.error("❌ Quality gate check failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- refine ---
function registerRefine(program: Command): void {
  program
    .command("refine")
    .description("Run backlog refinement on type:idea issues")
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        const sprintConfig = buildSprintConfig(config, opts.sprint);
        logger.info({ sprint: opts.sprint }, "Starting refinement");

        const client = await createConnectedClient(config);
        try {
          const refined = await runRefinement(client, sprintConfig);
          console.log(`\n✅ Refinement complete: ${refined.length} issues refined`);
          for (const issue of refined) {
            console.log(`  #${issue.number} — ${issue.title} (ICE=${issue.ice_score})`);
          }
        } finally {
          await client.disconnect();
        }
      } catch (err: unknown) {
        logger.error({ err }, "Refinement failed");
        console.error("❌ Refinement failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- full-cycle ---
function registerFullCycle(program: Command): void {
  program
    .command("full-cycle")
    .description("Run a full sprint cycle: plan → execute → review → retro")
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        const sprintConfig = buildSprintConfig(config, opts.sprint);
        logger.info({ sprint: opts.sprint }, "Starting full sprint cycle");

        const client = await createConnectedClient(config);
        try {
          // Step 1: Plan
          console.log("\n🔄 Phase 1/4: Planning...");
          const plan = await runSprintPlanning(client, sprintConfig);
          console.log(
            `  Planned ${plan.sprint_issues.length} issues (${plan.estimated_points} points)`,
          );

          // Handle empty plan — no actionable issues
          if (plan.sprint_issues.length === 0) {
            console.log("\n⏭️  No actionable issues found — skipping sprint.");
            return;
          }

          // Step 2: Execute all issues (with parallel dispatch, merge, pre-merge verification)
          console.log("\n🔄 Phase 2/4: Execution...");
          const sprintResult = await runParallelExecution(client, sprintConfig, plan);
          const results = sprintResult.results;
          for (const r of results) {
            console.log(
              `  ${r.status === "completed" ? "✅" : "❌"} #${r.issueNumber} — ${r.status}`,
            );
          }

          // Step 3: Review
          console.log("\n🔄 Phase 3/4: Review...");
          const review = await runSprintReview(client, sprintConfig, sprintResult);
          console.log(
            `  ${review.demoItems.length} demo items, ${review.openItems.length} open items`,
          );

          // Step 4: Retro
          console.log("\n🔄 Phase 4/4: Retrospective...");
          const retro = await runSprintRetro(client, sprintConfig, sprintResult, review);
          console.log(`  ${retro.wentWell.length} went well, ${retro.wentBadly.length} went badly`);
          console.log(`  ${retro.improvements.length} improvements identified`);

          // Summary
          const completed = results.filter((r) => r.status === "completed").length;
          console.log(`\n✅ Sprint ${opts.sprint} full cycle complete`);
          console.log(`  ${completed}/${results.length} issues completed`);
          console.log(`  ${review.summary}`);
        } finally {
          await client.disconnect();
        }
      } catch (err: unknown) {
        logger.error({ err }, "Full cycle failed");
        console.error("❌ Full cycle failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- web dashboard ---
function registerWeb(program: Command): void {
  program
    .command("web")
    .description("Launch web dashboard — browser-based sprint monitor on localhost")
    .option("--sprint <number>", "Override sprint number (skip auto-detection)", parseSprintNumber)
    .option(
      "--port <number>",
      "Dashboard server port (default: 9100)",
      (v) => parseInt(v, 10),
      9100,
    )
    .option("--run", "Start sprint execution immediately")
    .option("--once", "Run only one sprint instead of looping (implies --run)")
    .option(
      "--max-sprints <number>",
      "Number of sprints to run (0=infinite, default: from config)",
      (v) => parseInt(v, 10),
    )
    .option("--log-file <path>", "Log file path (default: aiscrum.log)", "aiscrum.log")
    .option("--no-open", "Don't auto-open browser")
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);

        // Auto-detect sprint
        let initialSprint = opts.sprint as number | undefined;
        if (!initialSprint) {
          const next = await getNextOpenMilestone(config.sprint.prefix);
          if (next) {
            initialSprint = next.sprintNumber;
          } else {
            initialSprint = 1;
            console.warn(`⚠️  No open sprint milestones found — defaulting to Sprint 1.`);
          }
        }

        redirectLogToFile(opts.logFile as string);
        initErrorLogFile(process.cwd());
        logger.info({ sprint: initialSprint }, "Launching web dashboard");

        const eventBus = new SprintEventBus();
        const sprintConfig = buildSprintConfig(config, initialSprint);
        attachSprintNotifications(eventBus, sprintConfig.ntfy);
        const runner = new SprintRunner(sprintConfig, eventBus);

        // Load saved state
        runner.loadSavedState();

        // Load initial issues
        let currentIssues: {
          number: number;
          title: string;
          status: "planned" | "in-progress" | "done" | "failed";
        }[] = [];
        try {
          const milestoneIssues = await listIssues({
            milestone: `${config.sprint.prefix} ${initialSprint}`,
            state: "all",
          });

          const savedState = runner.getState();
          const completedIssues = new Set<number>();
          const failedIssues = new Set<number>();
          if (savedState?.result) {
            for (const r of savedState.result.results) {
              if (r.status === "completed") completedIssues.add(r.issueNumber);
              else failedIssues.add(r.issueNumber);
            }
          }

          currentIssues = milestoneIssues.map((i) => {
            const labels = ((i.labels ?? []) as Array<string | { name: string }>).map((l) =>
              typeof l === "string" ? l : l.name,
            );
            let status: "planned" | "in-progress" | "done" | "failed" = "planned";
            if (completedIssues.has(i.number) || i.state === "closed") status = "done";
            else if (failedIssues.has(i.number)) status = "failed";
            else if (labels.includes("status:in-progress")) status = "in-progress";
            return { number: i.number, title: i.title, status };
          });
        } catch {
          // Non-critical
        }

        // Update issues from events
        eventBus.onTyped("sprint:planned", ({ issues: plannedIssues }) => {
          try {
            currentIssues = plannedIssues.map((i) => ({
              number: i.number,
              title: i.title,
              status: "planned" as const,
            }));
          } catch (err) {
            logger.warn({ err }, "event handler error: sprint:planned");
          }
        });
        eventBus.onTyped("issue:start", ({ issue }) => {
          try {
            const existing = currentIssues.find((i) => i.number === issue.number);
            if (existing) {
              existing.status = "in-progress";
            } else {
              currentIssues.push({
                number: issue.number,
                title: issue.title,
                status: "in-progress",
              });
            }
          } catch (err) {
            logger.warn({ err }, "event handler error: issue:start");
          }
        });
        eventBus.onTyped("issue:done", ({ issueNumber }) => {
          try {
            const issue = currentIssues.find((i) => i.number === issueNumber);
            if (issue) issue.status = "done";
          } catch (err) {
            logger.warn({ err }, "event handler error: issue:done");
          }
        });
        eventBus.onTyped("issue:fail", ({ issueNumber }) => {
          try {
            const issue = currentIssues.find((i) => i.number === issueNumber);
            if (issue) issue.status = "failed";
          } catch (err) {
            logger.warn({ err }, "event handler error: issue:fail");
          }
        });

        // Start/loop functions
        let sprintLimit = (opts.maxSprints as number | undefined) ?? config.sprint.max_sprints ?? 0;
        let activeRunner: SprintRunner = runner;

        // Create a fresh runner for each start (the previous one may be aborted/stopped)
        const createFreshRunner = () => {
          const fresh = new SprintRunner(buildSprintConfig(config, initialSprint), eventBus);
          fresh.loadSavedState();
          activeRunner = fresh;
          return fresh;
        };

        const startLoop = () => {
          SprintRunner.sprintLoop(
            (sprintNumber) => buildSprintConfig(config, sprintNumber),
            eventBus,
            () => sprintLimit,
            (r) => {
              activeRunner = r;
            },
          ).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            eventBus.emitTyped("sprint:error", { error: msg });
            eventBus.emitTyped("log", { level: "error", message: `Sprint loop crashed: ${msg}` });
          });
        };

        const startOnce = () => {
          const fresh = createFreshRunner();
          fresh.fullCycle().catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            eventBus.emitTyped("sprint:error", { error: msg });
            eventBus.emitTyped("log", { level: "error", message: `Sprint crashed: ${msg}` });
          });
        };

        const onStart = opts.once ? startOnce : startLoop;

        // Sprint switching: reload issues for the new sprint
        const switchToSprint = async (sprintNumber: number) => {
          logger.info({ sprintNumber }, "switching dashboard to sprint");
          try {
            const milestoneIssues = await listIssues({
              milestone: `${config.sprint.prefix} ${sprintNumber}`,
              state: "all",
            });
            currentIssues = milestoneIssues.map((i) => ({
              number: i.number,
              title: i.title,
              status: i.state === "closed" ? ("done" as const) : ("planned" as const),
            }));
          } catch {
            currentIssues = [];
          }
        };

        // Launch WebSocket server
        const { DashboardWebServer } = await import("../dashboard/ws-server.js");
        const dashboardServer = new DashboardWebServer({
          port: opts.port as number,
          host: "localhost",
          eventBus,
          getState: () => activeRunner.getState(),
          getIssues: () => currentIssues,
          onStart,
          onPause: () => activeRunner.pause(),
          onResume: () => activeRunner.resume(),
          onStop: () => activeRunner.stop(),
          onCancel: async () => {
            const result = await activeRunner.cancel();
            logger.info({ returnedIssues: result.returnedIssues }, "Sprint cancelled");
          },
          onSwitchSprint: switchToSprint,
          onModeChange: (mode) => {
            activeRunner.setHitlMode(mode === "hitl");
            logger.info({ mode }, "execution mode changed");
          },
          onSetSprintLimit: (limit) => {
            sprintLimit = limit;
            logger.info({ limit }, "sprint limit changed from dashboard");
          },
          projectPath: process.cwd(),
          activeSprintNumber: initialSprint,
          sprintPrefix: config.sprint.prefix,
          sprintSlug: prefixToSlug(config.sprint.prefix),
          maxIssuesPerSprint: config.sprint.max_issues,
          config,
        });
        dashboardServer.sprintLimit = sprintLimit;

        await dashboardServer.start();
        const url = `http://localhost:${opts.port as number}`;
        console.log(`\n  🌐 Dashboard running at ${url}\n`);

        // Track sprint transitions for continuous loop mode
        eventBus.onTyped("sprint:start", ({ sprintNumber }) => {
          try {
            dashboardServer.setActiveSprintNumber(sprintNumber);
            currentIssues = [];
          } catch (err) {
            logger.warn({ err }, "event handler error: sprint:start");
          }
        });

        // Auto-open browser
        if (opts.open !== false) {
          const { exec } = await import("node:child_process");
          const openCmd =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          exec(`${openCmd} ${url}`);
        }

        // Start heartbeat supervisor
        const { HeartbeatSupervisor } = await import("../heartbeat.js");
        const heartbeat = new HeartbeatSupervisor(
          {
            enabled: config.heartbeat?.enabled ?? true,
            intervalMs: config.heartbeat?.interval_ms ?? 30000,
            staleThresholdMs: config.heartbeat?.stale_threshold_ms ?? 300000,
            stateDir: path.join(process.cwd(), "docs", "sprints"),
            sprintSlug: prefixToSlug(config.sprint.prefix),
          },
          eventBus,
        );
        heartbeat.start();

        // Graceful shutdown
        let cleaningUp = false;
        const cleanup = async () => {
          if (cleaningUp) return;
          cleaningUp = true;
          heartbeat.stop();
          await dashboardServer.stop();
          process.exit(0);
        };
        process.on("SIGINT", () => {
          void cleanup();
        });
        process.on("SIGTERM", () => {
          void cleanup();
        });

        // Catch unhandled errors
        process.on("unhandledRejection", (reason: unknown) => {
          const msg = reason instanceof Error ? reason.message : String(reason);
          eventBus.emitTyped("sprint:error", { error: msg });
          eventBus.emitTyped("log", { level: "error", message: `Unhandled error: ${msg}` });
        });

        // Auto-start if flags set
        if (opts.run || opts.once) {
          onStart();
        }
      } catch (err: unknown) {
        logger.error({ err }, "Web dashboard failed");
        console.error("❌ Web dashboard failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- review ---
function registerReview(program: Command): void {
  program
    .command("review")
    .description("Run sprint review ceremony")
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        logger.info(
          { sprint: opts.sprint, project: config.project.name },
          "Starting sprint review",
        );

        // Attempt to load sprint log for context
        let logContent: string;
        try {
          logContent = readSprintLog(opts.sprint, undefined, prefixToSlug(config.sprint.prefix));
        } catch {
          console.error(`❌ No sprint log found for ${config.sprint.prefix} ${opts.sprint}.`);
          console.error("   Run the full-cycle or execute issues first to generate sprint data.");
          process.exit(1);
        }

        console.log(
          `📋 ${config.sprint.prefix} ${opts.sprint} log loaded (${logContent.length} chars)`,
        );
        console.log("⚠️  Sprint review requires a SprintResult from execution.");
        console.log("   Use 'full-cycle' for an end-to-end run, or provide sprint state.");
        console.log("   Sprint log preview:\n");
        console.log(logContent.slice(0, 500));
      } catch (err: unknown) {
        logger.error({ err }, "Sprint review failed");
        console.error("❌ Sprint review failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- retro ---
function registerRetro(program: Command): void {
  program
    .command("retro")
    .description("Run sprint retrospective ceremony")
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        logger.info(
          { sprint: opts.sprint, project: config.project.name },
          "Starting sprint retrospective",
        );

        // Attempt to load sprint log for context
        let logContent: string;
        try {
          logContent = readSprintLog(opts.sprint, undefined, prefixToSlug(config.sprint.prefix));
        } catch {
          console.error(`❌ No sprint log found for ${config.sprint.prefix} ${opts.sprint}.`);
          console.error("   Run the full-cycle or execute issues first to generate sprint data.");
          process.exit(1);
        }

        console.log(
          `📋 ${config.sprint.prefix} ${opts.sprint} log loaded (${logContent.length} chars)`,
        );
        console.log(
          "⚠️  Sprint retro requires SprintResult and ReviewResult from prior ceremonies.",
        );
        console.log("   Use 'full-cycle' for an end-to-end run, or provide sprint state.");
        console.log("   Sprint log preview:\n");
        console.log(logContent.slice(0, 500));
      } catch (err: unknown) {
        logger.error({ err }, "Sprint retrospective failed");
        console.error("❌ Sprint retrospective failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- status ---
function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Show status of running workers")
    .action(async () => {
      console.log("📊 Worker Status");
      console.log("  No active workers.");
      console.log("  (Worker status tracking is not yet implemented.)");
    });
}

// --- pause ---
function registerPause(program: Command): void {
  program
    .command("pause")
    .description("Pause running sprint execution")
    .action(async () => {
      console.log("⏸️  Pause");
      console.log("  Sprint pause/resume is not yet implemented.");
      console.log("  To stop execution, terminate the process (Ctrl+C).");
    });
}

// --- resume ---
function registerResume(program: Command): void {
  program
    .command("resume")
    .description("Resume paused sprint execution")
    .action(async () => {
      console.log("▶️  Resume");
      console.log("  Sprint pause/resume is not yet implemented.");
      console.log("  Re-run the command to restart execution.");
    });
}

// --- metrics ---
function registerMetrics(program: Command): void {
  program
    .command("metrics")
    .description("Show sprint metrics from sprint log")
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        logger.info(
          { sprint: opts.sprint, project: config.project.name },
          "Loading sprint metrics",
        );

        let logContent: string;
        try {
          logContent = readSprintLog(opts.sprint, undefined, prefixToSlug(config.sprint.prefix));
        } catch {
          console.error(`❌ No sprint log found for ${config.sprint.prefix} ${opts.sprint}.`);
          process.exit(1);
        }

        console.log(`📈 ${config.sprint.prefix} ${opts.sprint} Metrics`);
        console.log("─".repeat(40));
        console.log(logContent);
      } catch (err: unknown) {
        logger.error({ err }, "Metrics retrieval failed");
        console.error("❌ Metrics retrieval failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- drift-report ---
function registerDriftReport(program: Command): void {
  program
    .command("drift-report")
    .description("Run drift analysis on current sprint changes")
    .requiredOption("--sprint <number>", "Sprint number", parseSprintNumber)
    .option("--changed-files <files...>", "List of changed files")
    .option("--expected-files <files...>", "List of expected files")
    .action(async (opts) => {
      try {
        const config = loadConfigFromOpts(program.opts().config);
        logger.info({ sprint: opts.sprint, project: config.project.name }, "Running drift report");

        const changedFiles: string[] = opts.changedFiles ?? [];
        const expectedFiles: string[] = opts.expectedFiles ?? [];

        if (changedFiles.length === 0) {
          console.log("⚠️  No changed files provided. Use --changed-files to specify files.");
          console.log(
            "   Example: aiscrum drift-report --sprint 1 --changed-files src/a.ts src/b.ts --expected-files src/a.ts",
          );
          process.exit(0);
        }

        const report = await holisticDriftCheck(changedFiles, expectedFiles);
        console.log(`\n📊 Drift Report — Sprint ${opts.sprint}`);
        console.log("─".repeat(40));
        console.log(`  Total files changed: ${report.totalFilesChanged}`);
        console.log(`  Planned changes:     ${report.plannedChanges}`);
        console.log(`  Drift percentage:    ${report.driftPercentage.toFixed(1)}%`);
        if (report.unplannedChanges.length > 0) {
          console.log("  Unplanned changes:");
          for (const file of report.unplannedChanges) {
            console.log(`    ⚠️  ${file}`);
          }
          process.exit(1);
        } else {
          console.log("  ✅ No unplanned changes detected.");
        }
      } catch (err: unknown) {
        logger.error({ err }, "Drift report failed");
        console.error("❌ Drift report failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// --- init ---
function registerInit(program: Command): void {
  program
    .command("init")
    .description("Initialize a project with .aiscrum/ roles and config")
    .option("--path <dir>", "Target project directory", process.cwd())
    .option("--force", "Overwrite existing files", false)
    .action(async (opts) => {
      try {
        console.log("🚀 Initializing AiScrum Pro...\n");

        const result = initProject({
          targetPath: opts.path,
          force: opts.force,
        });

        if (result.created.length > 0) {
          console.log("  ✅ Created:");
          for (const f of result.created) {
            console.log(`     ${f}`);
          }
        }

        if (result.skipped.length > 0) {
          console.log("\n  ⏭️  Skipped (already exist):");
          for (const f of result.skipped) {
            console.log(`     ${f}`);
          }
        }

        console.log(
          `\n✅ Initialized! ${result.created.length} files created, ${result.skipped.length} skipped.`,
        );

        if (result.configPath) {
          console.log(`\n📝 Edit ${result.configPath} to configure your project.`);
        }
      } catch (err: unknown) {
        logger.error({ err }, "Init failed");
        console.error("❌ Init failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

function registerValidate(program: Command): void {
  program
    .command("validate")
    .description("Validate .aiscrum/ configuration for correctness")
    .option("--path <dir>", "Project directory to validate", process.cwd())
    .action(async (opts) => {
      try {
        const projectPath = path.resolve(opts.path);
        const configPath = path.join(projectPath, ".aiscrum", "config.yaml");

        const fsSync = await import("node:fs");
        if (!fsSync.existsSync(configPath)) {
          console.error(`❌ No .aiscrum/config.yaml found at ${projectPath}`);
          process.exit(1);
        }

        console.log(`🔍 Validating ${projectPath}/.aiscrum/\n`);

        const { loadConfig } = await import("../config.js");
        const config = loadConfig(configPath);
        const report = await validateConfig(projectPath, config);

        console.log(formatReport(report));

        if (report.issues.some((i) => i.severity === "error")) {
          process.exit(1);
        }
      } catch (err: unknown) {
        logger.error({ err }, "Validation failed");
        console.error("❌ Validation failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}
