/**
 * Shared helpers for sprint ceremony modules.
 */

import type { z } from "zod";
import { logger } from "../logger.js";

/** Replace `{{KEY}}` placeholders in a template string. */
export function substitutePrompt(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Sanitize user-provided content before substituting into prompts.
 * Mitigates prompt injection by wrapping content in delimiters.
 */
export function sanitizePromptInput(input: string): string {
  return `<user_content>\n${input}\n</user_content>`;
}

/**
 * Extract the first JSON object or array from a string that may contain
 * markdown fenced code blocks or plain text around it.
 */
export function extractJson<T = unknown>(text: string): T {
  // Try fenced code block first (```json ... ``` or ``` ... ```)
  const fencedMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1]) as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to parse JSON from response: ${msg}. Input (first 200 chars): ${text.slice(0, 200)}`,
      );
    }
  }

  // Fall back to finding a top-level { or [
  const start = text.search(/[{[]/);
  if (start === -1) {
    throw new Error("No JSON found in response");
  }

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === open) depth++;
    else if (ch === close) depth--;

    if (depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1)) as T;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to parse JSON from response: ${msg}. Input (first 200 chars): ${text.slice(0, 200)}`,
        );
      }
    }
  }

  throw new Error("No complete JSON found in response");
}

/**
 * Parse an agent response against a Zod schema, retrying up to twice on validation failure.
 * On each failure, calls `retryFn` with a format hint derived from the schema error.
 * Logs failures as warnings. Throws after all retries are exhausted.
 *
 * @param jsonExample - Optional JSON example string to include in the retry hint.
 *   Providing this dramatically improves retry success by showing the LLM the exact
 *   structure expected.
 */
export async function parseWithRetry<S extends z.ZodTypeAny>(
  schema: S,
  rawResponse: string,
  retryFn: (formatHint: string) => Promise<string>,
  jsonExample?: string,
): Promise<z.output<S>> {
  const log = logger.child({ module: "parseWithRetry" });
  const MAX_RETRIES = 2;

  let lastResponse = rawResponse;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return schema.parse(extractJson(lastResponse));
    } catch (err: unknown) {
      if (attempt === MAX_RETRIES) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        { error: errMsg, attempt: attempt + 1, maxRetries: MAX_RETRIES },
        "schema validation failed — retrying with format hint",
      );

      const hintLines = [
        "Your previous response could not be parsed as JSON.",
        `Error: ${errMsg}`,
        "",
        "IMPORTANT: You MUST respond with ONLY a JSON block — no markdown, no explanation.",
        "Your entire response must be a single ```json fenced code block, nothing else.",
      ];

      if (jsonExample) {
        hintLines.push(
          "",
          "The JSON must match this exact structure:",
          "```json",
          jsonExample,
          "```",
        );
      }

      lastResponse = await retryFn(hintLines.join("\n"));
    }
  }
  /* istanbul ignore next — unreachable but satisfies TS return type */
  throw new Error("parseWithRetry: exhausted retries");
}
