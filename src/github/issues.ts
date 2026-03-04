import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

/** Check if an error is retryable (network/rate-limit, not auth/not-found). */
function isRetryable(error: unknown): boolean {
  const errnoCode = (error as NodeJS.ErrnoException).code;
  // ENOENT = command not found, EACCES = permission denied — never retry
  if (errnoCode === "ENOENT" || errnoCode === "EACCES") return false;
  // gh exit code 4 = auth error — never retry
  if (errnoCode === "4" || (error as { code?: number }).code === 4) return false;
  // Only retry errors that look like transient network/API failures
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("ETIMEDOUT") ||
    message.includes("ECONNRESET") ||
    message.includes("EAGAIN") ||
    message.includes("rate limit") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("timeout")
  ) {
    return true;
  }
  // EAGAIN errno code (resource temporarily unavailable)
  if (errnoCode === "EAGAIN") return true;
  return false;
}

/** Run a `gh` CLI command with retry for transient failures. */
export async function execGh(args: string[]): Promise<string> {
  logger.debug({ args }, "gh %s", args[0]);

  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { stdout } = await execFileAsync("gh", args);
      return stdout.trim();
    } catch (error: unknown) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error("gh CLI not found. Install it: https://cli.github.com/");
      }
      const exitCode = (error as { code?: number | string }).code;
      if (exitCode === 4) {
        throw new Error("gh CLI not authenticated. Run: gh auth login");
      }

      if (attempt < MAX_RETRIES && isRetryable(error)) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          { args, attempt: attempt + 1, maxRetries: MAX_RETRIES, delay },
          "gh command failed, retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.error({ args, error: message }, "gh command failed");
      throw new Error(`gh ${args.join(" ")} failed: ${message}`);
    }
  }
  // Should never reach here, but TypeScript needs this
  throw lastError;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  state: string;
  milestone?: { title: string } | null;
}

/** Get issue details by number. */
export async function getIssue(number: number): Promise<GitHubIssue> {
  const json = await execGh([
    "issue",
    "view",
    String(number),
    "--json",
    "number,title,body,labels,state,milestone",
  ]);
  try {
    return JSON.parse(json) as GitHubIssue;
  } catch {
    throw new Error(`Failed to parse issue #${number} response: ${json.slice(0, 200)}`);
  }
}

export interface ListIssuesOptions {
  labels?: string[];
  state?: string;
  milestone?: string;
}

/** List issues with optional filters. */
export async function listIssues(options: ListIssuesOptions = {}): Promise<GitHubIssue[]> {
  const args = ["issue", "list", "--json", "number,title,body,labels,state,milestone"];

  if (options.labels && options.labels.length > 0) {
    args.push("--label", options.labels.join(","));
  }
  if (options.state) {
    args.push("--state", options.state);
  }
  if (options.milestone) {
    args.push("--milestone", options.milestone);
  }

  const json = await execGh(args);
  try {
    return JSON.parse(json) as GitHubIssue[];
  } catch {
    throw new Error(`Failed to parse issue list response: ${json.slice(0, 200)}`);
  }
}

export interface CreateIssueOptions {
  title: string;
  body: string;
  labels?: string[];
}

/** Create a new issue and return its details. */
export async function createIssue(options: CreateIssueOptions): Promise<GitHubIssue> {
  // Validate required fields to prevent garbage issues
  if (!options.title || typeof options.title !== "string" || options.title.trim().length === 0) {
    throw new Error("Cannot create issue: title is required and must be a non-empty string");
  }
  if (!options.body || typeof options.body !== "string" || options.body.trim().length === 0) {
    throw new Error("Cannot create issue: body is required and must be a non-empty string");
  }

  // Deduplication: skip if an open issue with the same title already exists
  try {
    const existing = await listIssues({ state: "open" });
    const duplicate = existing.find((i) => i.title === options.title);
    if (duplicate) {
      logger.info(
        { number: duplicate.number, title: options.title },
        "Skipping duplicate issue creation",
      );
      return duplicate;
    }
  } catch {
    // Non-critical — proceed with creation if dedup check fails
  }

  const args = ["issue", "create", "--title", options.title, "--body", options.body];

  if (options.labels && options.labels.length > 0) {
    args.push("--label", options.labels.join(","));
  }

  const url = await execGh(args);
  // gh issue create returns the URL; extract number from it
  const match = url.match(/\/(\d+)\s*$/);
  if (!match) {
    throw new Error(`Could not parse issue number from: ${url}`);
  }
  return getIssue(Number(match[1]));
}

export interface UpdateIssueOptions {
  title?: string;
  body?: string;
  state?: string;
}

/** Update an existing issue. */
export async function updateIssue(number: number, options: UpdateIssueOptions): Promise<void> {
  const args = ["issue", "edit", String(number)];

  if (options.title) {
    args.push("--title", options.title);
  }
  if (options.body) {
    args.push("--body", options.body);
  }

  await execGh(args);

  if (options.state === "closed") {
    await execGh(["issue", "close", String(number)]);
  } else if (options.state === "open") {
    await execGh(["issue", "reopen", String(number)]);
  }
}

/** Add a comment to an issue. */
export async function addComment(number: number, body: string): Promise<void> {
  await execGh(["issue", "comment", String(number), "--body", body]);
}

/** Get comments on an issue, newest first. */
export async function getComments(
  number: number,
  limit = 5,
): Promise<Array<{ body: string; createdAt: string }>> {
  const json = await execGh([
    "issue",
    "view",
    String(number),
    "--json",
    "comments",
    "--jq",
    `.comments | sort_by(.createdAt) | reverse | .[:${limit}]`,
  ]);
  try {
    return JSON.parse(json) as Array<{ body: string; createdAt: string }>;
  } catch {
    return [];
  }
}

/** Close an issue. */
export async function closeIssue(number: number): Promise<void> {
  await execGh(["issue", "close", String(number)]);
}
