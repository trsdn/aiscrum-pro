import { execGh } from "./issues.js";
import { logger } from "../logger.js";

export interface GitHubMilestone {
  title: string;
  number: number;
  description: string;
  state: string;
}

/** Parse sprint number from milestone title like "Sprint 3" or "Test Sprint 3". Returns undefined if title doesn't match. */
export function parseSprintFromTitle(title: string, prefix: string = "Sprint"): number | undefined {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = title.match(new RegExp(`^${escaped}\\s+(\\d+)$`, "i"));
  return match ? parseInt(match[1], 10) : undefined;
}

/** Get the next open sprint milestone. Returns the lowest-numbered open "{prefix} N" milestone. */
export async function getNextOpenMilestone(
  prefix: string = "Sprint",
): Promise<{ milestone: GitHubMilestone; sprintNumber: number } | undefined> {
  let json: string;
  try {
    json = await execGh(["api", "repos/{owner}/{repo}/milestones", "-q", ".", "--paginate"]);
  } catch {
    return undefined;
  }

  if (!json?.trim()) {
    return undefined;
  }

  const pages = json
    .trim()
    .split("\n")
    .filter((line) => line.trim());
  const milestones = pages.flatMap((page) => {
    try {
      return JSON.parse(page) as GitHubMilestone[];
    } catch {
      return [];
    }
  });

  // Find open milestones matching "Sprint N", pick the lowest number
  const sprintMilestones = milestones
    .filter((m) => m.state === "open")
    .map((m) => ({ milestone: m, sprintNumber: parseSprintFromTitle(m.title, prefix) }))
    .filter(
      (x): x is { milestone: GitHubMilestone; sprintNumber: number } =>
        x.sprintNumber !== undefined,
    )
    .sort((a, b) => a.sprintNumber - b.sprintNumber);

  if (sprintMilestones.length === 0) {
    return undefined;
  }

  logger.info(
    { sprint: sprintMilestones[0].sprintNumber, title: sprintMilestones[0].milestone.title },
    "Found next open sprint milestone",
  );
  return sprintMilestones[0];
}

/** Create a new milestone. */
export async function createMilestone(
  title: string,
  description?: string,
): Promise<GitHubMilestone> {
  const args = ["api", "repos/{owner}/{repo}/milestones", "-f", `title=${title}`];

  if (description) {
    args.push("-f", `description=${description}`);
  }

  const json = await execGh(args);
  logger.info({ title }, "Milestone created");
  return JSON.parse(json) as GitHubMilestone;
}

/** Get a milestone by title. Returns undefined if not found. */
export async function getMilestone(title: string): Promise<GitHubMilestone | undefined> {
  const json = await execGh(["api", "repos/{owner}/{repo}/milestones", "--paginate"]);

  if (!json) {
    return undefined;
  }

  // gh --paginate may return NDJSON (one JSON array per line)
  const pages = json
    .trim()
    .split("\n")
    .filter((line) => line.trim());
  const milestones = pages.flatMap((page) => {
    try {
      return JSON.parse(page) as GitHubMilestone[];
    } catch {
      return [];
    }
  });
  return milestones.find((m) => m.title === title);
}

/** Assign an issue to a milestone by title. */
export async function setMilestone(issueNumber: number, milestoneTitle: string): Promise<void> {
  await execGh(["issue", "edit", String(issueNumber), "--milestone", milestoneTitle]);
  logger.debug({ issueNumber, milestoneTitle }, "Milestone set on issue");
}

/** Remove milestone from an issue. */
export async function removeMilestone(issueNumber: number): Promise<void> {
  await execGh(["issue", "edit", String(issueNumber), "--milestone", ""]);
  logger.debug({ issueNumber }, "Milestone removed from issue");
}

/** Close a milestone by title. */
export async function closeMilestone(title: string): Promise<void> {
  const milestone = await getMilestone(title);
  if (!milestone) {
    throw new Error(`Milestone not found: ${title}`);
  }

  await execGh([
    "api",
    "-X",
    "PATCH",
    `repos/{owner}/{repo}/milestones/${milestone.number}`,
    "-f",
    "state=closed",
  ]);
  logger.info({ title }, "Milestone closed");
}

/** List all milestones matching the given prefix (e.g. "Sprint" → "Sprint 1", "Sprint 2"). */
export async function listSprintMilestones(
  prefix: string = "Sprint",
): Promise<{ sprintNumber: number; milestoneNumber: number; title: string; state: string }[]> {
  const allMilestones: GitHubMilestone[] = [];

  // Query both open and closed milestones (GitHub API only allows one state at a time)
  for (const state of ["open", "closed"] as const) {
    try {
      const json = await execGh([
        "api",
        "repos/{owner}/{repo}/milestones",
        "-q",
        ".",
        "--paginate",
        "--method",
        "GET",
        "-F",
        `state=${state}`,
      ]);
      if (json?.trim()) {
        const pages = json
          .trim()
          .split("\n")
          .filter((line) => line.trim());
        for (const page of pages) {
          try {
            const parsed = JSON.parse(page) as GitHubMilestone[];
            allMilestones.push(...parsed);
          } catch {
            // skip malformed page
          }
        }
      }
    } catch {
      // continue with other state
    }
  }

  return allMilestones
    .map((m) => ({
      sprintNumber: parseSprintFromTitle(m.title, prefix),
      milestoneNumber: m.number,
      title: m.title,
      state: m.state,
    }))
    .filter(
      (x): x is { sprintNumber: number; milestoneNumber: number; title: string; state: string } =>
        x.sprintNumber !== undefined,
    )
    .sort((a, b) => a.sprintNumber - b.sprintNumber);
}
