import { execGh } from "./issues.js";
import { logger } from "../logger.js";

/** Standard status labels used by the sprint runner. */
export const STATUS_LABELS = [
  "status:planned",
  "status:in-progress",
  "status:done",
  "status:blocked",
  "status:refined",
  "status:ready",
] as const;

export type StatusLabel = (typeof STATUS_LABELS)[number];

/** Add a label to an issue. */
export async function setLabel(issueNumber: number, label: string): Promise<void> {
  logger.debug({ issueNumber, label }, "Adding label");
  await execGh(["issue", "edit", String(issueNumber), "--add-label", label]);
}

/**
 * Set a status label, removing any other status:* labels first.
 * Prevents duplicate status labels from accumulating on issues.
 */
export async function setStatusLabel(issueNumber: number, label: StatusLabel): Promise<void> {
  try {
    const current = await getLabels(issueNumber);
    const staleStatuses = current
      .filter((l) => l.name.startsWith("status:") && l.name !== label)
      .map((l) => l.name);

    for (const old of staleStatuses) {
      await removeLabel(issueNumber, old).catch((err) =>
        logger.debug({ err, issueNumber, label: old }, "failed to remove stale status label"),
      );
    }
  } catch (err) {
    logger.debug({ err, issueNumber }, "failed to read current labels — adding anyway");
  }

  await setLabel(issueNumber, label);
}

/** Remove a label from an issue. */
export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  logger.debug({ issueNumber, label }, "Removing label");
  await execGh(["issue", "edit", String(issueNumber), "--remove-label", label]);
}

/** Create a label if it doesn't already exist. */
export async function ensureLabelExists(
  name: string,
  color?: string,
  description?: string,
): Promise<void> {
  try {
    const json = await execGh(["label", "list", "--search", name, "--json", "name"]);
    const labels = JSON.parse(json) as { name: string }[];
    const exists = labels.some((l) => l.name === name);

    if (exists) {
      logger.debug({ name }, "Label already exists");
      return;
    }
  } catch {
    // If listing fails, try creating anyway
  }

  const args = ["label", "create", name];
  if (color) {
    args.push("--color", color);
  }
  if (description) {
    args.push("--description", description);
  }
  args.push("--force");

  await execGh(args);
  logger.info({ name }, "Label created");
}

/** Get labels for a specific issue. */
export async function getLabels(issueNumber: number): Promise<{ name: string }[]> {
  const json = await execGh(["issue", "view", String(issueNumber), "--json", "labels"]);
  const result = JSON.parse(json) as { labels?: { name: string }[] };
  return result.labels ?? [];
}
