import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { Logger } from "../logger.js";
import { logger as defaultLogger } from "../logger.js";
import type { ResolvedToolPolicy } from "../types/config.js";

export interface PermissionConfig {
  /** Auto-approve all permission requests when true. */
  autoApprove: boolean;
  /** Glob-like patterns for tool names to allow (matched via simple substring). */
  allowPatterns: string[];
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  autoApprove: false,
  allowPatterns: [],
};

/** Registry that maps session IDs to per-session tool policies. */
export interface SessionPermissionRegistry {
  register(sessionId: string, policy: ResolvedToolPolicy): void;
  unregister(sessionId: string): void;
  getPolicy(sessionId: string): ResolvedToolPolicy | undefined;
}

export function createSessionPermissionRegistry(): SessionPermissionRegistry {
  const policies = new Map<string, ResolvedToolPolicy>();
  return {
    register: (sid, policy) => policies.set(sid, policy),
    unregister: (sid) => policies.delete(sid),
    getPolicy: (sid) => policies.get(sid),
  };
}

/**
 * Creates a permission handler callback for the ACP client.
 * Returns a function compatible with `Client.requestPermission`.
 *
 * When a session has a registered tool policy, the handler uses it.
 * Otherwise, falls back to the global config (backward compatible).
 */
export function createPermissionHandler(
  config: PermissionConfig = DEFAULT_PERMISSION_CONFIG,
  log: Logger = defaultLogger,
  registry?: SessionPermissionRegistry,
): (params: RequestPermissionRequest) => Promise<RequestPermissionResponse> {
  return async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
    const toolCall = params.toolCall;
    const toolName = toolCall && "name" in toolCall ? (toolCall.name as string) : "unknown";
    const sessionId = "sessionId" in params ? (params.sessionId as string) : undefined;
    const options = params.options;

    // Find the allow_once option (preferred) or first allow option
    const allowOption =
      options.find((o) => o.kind === "allow_once") ??
      options.find((o) => o.kind === "allow_always");

    const rejectOption =
      options.find((o) => o.kind === "reject_once") ??
      options.find((o) => o.kind === "reject_always");

    // --- Per-session tool policy (takes precedence) ---
    if (registry && sessionId) {
      const sessionPolicy = registry.getPolicy(sessionId);
      if (sessionPolicy) {
        const matched = sessionPolicy.allowPatterns.some((pattern) => toolName.includes(pattern));
        if (matched && allowOption) {
          log.debug(
            { tool: toolName, session: sessionId },
            "permission approved via session policy",
          );
          return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
        }
        if (!matched) {
          if (rejectOption) {
            log.warn({ tool: toolName, session: sessionId }, "permission denied by session policy");
            return { outcome: { outcome: "selected", optionId: rejectOption.optionId } };
          }
          log.warn({ tool: toolName, session: sessionId }, "permission cancelled — no allow match");
          return { outcome: { outcome: "cancelled" } };
        }
      }
    }

    // --- Global config fallback (original behavior) ---
    if (config.autoApprove && allowOption) {
      log.debug({ tool: toolName, optionId: allowOption.optionId }, "permission auto-approved");
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }

    // Check allow patterns
    if (config.allowPatterns.length > 0 && allowOption) {
      const matched = config.allowPatterns.some((pattern) => toolName.includes(pattern));
      if (matched) {
        log.debug(
          { tool: toolName, optionId: allowOption.optionId },
          "permission approved via pattern match",
        );
        return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
      }
    }

    // Reject if no auto-approve and no pattern match
    if (rejectOption) {
      log.warn({ tool: toolName, optionId: rejectOption.optionId }, "permission rejected");
      return { outcome: { outcome: "selected", optionId: rejectOption.optionId } };
    }

    // Fallback: cancel if no suitable option found
    log.warn({ tool: toolName }, "permission cancelled — no suitable option");
    return { outcome: { outcome: "cancelled" } };
  };
}
