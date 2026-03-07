import { describe, it, expect, vi } from "vitest";
import {
  createPermissionHandler,
  createSessionPermissionRegistry,
  DEFAULT_PERMISSION_CONFIG,
  type PermissionConfig,
} from "../../src/acp/permissions.js";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

/** Helper to build a minimal RequestPermissionRequest. */
function makeRequest(
  toolName: string,
  options: RequestPermissionRequest["options"] = [
    { kind: "allow_once", optionId: "allow-1" },
    { kind: "reject_once", optionId: "reject-1" },
  ],
  sessionId?: string,
): RequestPermissionRequest {
  return {
    toolCall: { name: toolName },
    options,
    ...(sessionId ? { sessionId } : {}),
  } as RequestPermissionRequest;
}

const silentLog = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as never;

describe("createPermissionHandler", () => {
  describe("auto-approve", () => {
    it("approves when autoApprove is true", async () => {
      const handler = createPermissionHandler({ autoApprove: true, allowPatterns: [] }, silentLog);
      const result = await handler(makeRequest("some_tool"));
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "allow-1",
      });
    });

    it("prefers allow_once over allow_always", async () => {
      const handler = createPermissionHandler({ autoApprove: true, allowPatterns: [] }, silentLog);
      const result = await handler(
        makeRequest("tool", [
          { kind: "allow_always", optionId: "always-1" },
          { kind: "allow_once", optionId: "once-1" },
        ]),
      );
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "once-1",
      });
    });

    it("falls back to allow_always when no allow_once", async () => {
      const handler = createPermissionHandler({ autoApprove: true, allowPatterns: [] }, silentLog);
      const result = await handler(
        makeRequest("tool", [
          { kind: "allow_always", optionId: "always-1" },
          { kind: "reject_once", optionId: "reject-1" },
        ]),
      );
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "always-1",
      });
    });
  });

  describe("allow pattern matching", () => {
    it("approves tool matching a pattern", async () => {
      const config: PermissionConfig = {
        autoApprove: false,
        allowPatterns: ["read_file", "write"],
      };
      const handler = createPermissionHandler(config, silentLog);

      const result = await handler(makeRequest("read_file"));
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "allow-1",
      });
    });

    it("approves when tool name contains pattern substring", async () => {
      const config: PermissionConfig = {
        autoApprove: false,
        allowPatterns: ["file"],
      };
      const handler = createPermissionHandler(config, silentLog);

      const result = await handler(makeRequest("read_file_contents"));
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "allow-1",
      });
    });

    it("rejects tool not matching any pattern", async () => {
      const config: PermissionConfig = {
        autoApprove: false,
        allowPatterns: ["read_file"],
      };
      const handler = createPermissionHandler(config, silentLog);

      const result = await handler(makeRequest("execute_command"));
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "reject-1",
      });
    });
  });

  describe("rejection", () => {
    it("rejects when autoApprove is false and no patterns match", async () => {
      const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog);
      const result = await handler(makeRequest("dangerous_tool"));
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "reject-1",
      });
    });

    it("prefers reject_once over reject_always", async () => {
      const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog);
      const result = await handler(
        makeRequest("tool", [
          { kind: "reject_always", optionId: "always-r" },
          { kind: "reject_once", optionId: "once-r" },
        ]),
      );
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "once-r",
      });
    });

    it("cancels when no allow or reject option exists", async () => {
      const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog);
      const result = await handler(makeRequest("tool", []));
      expect(result.outcome).toEqual({ outcome: "cancelled" });
    });
  });

  describe("edge cases", () => {
    it("handles empty allow patterns like no patterns", async () => {
      const config: PermissionConfig = {
        autoApprove: false,
        allowPatterns: [],
      };
      const handler = createPermissionHandler(config, silentLog);
      const result = await handler(makeRequest("any_tool"));
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "reject-1",
      });
    });

    it("handles missing toolCall name gracefully", async () => {
      const handler = createPermissionHandler({ autoApprove: true, allowPatterns: [] }, silentLog);
      const result = await handler({
        toolCall: {},
        options: [{ kind: "allow_once", optionId: "a1" }],
      } as RequestPermissionRequest);
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "a1",
      });
    });

    it("cancels when autoApprove is true but no allow option exists", async () => {
      const handler = createPermissionHandler({ autoApprove: true, allowPatterns: [] }, silentLog);
      const result = await handler(makeRequest("tool", [{ kind: "reject_once", optionId: "r1" }]));
      // autoApprove can't approve without an allow option, falls to reject
      expect(result.outcome).toEqual({
        outcome: "selected",
        optionId: "r1",
      });
    });
  });
});

describe("SessionPermissionRegistry", () => {
  it("registers and retrieves a policy", () => {
    const registry = createSessionPermissionRegistry();
    registry.register("session-1", { allowPatterns: ["view", "grep"] });
    expect(registry.getPolicy("session-1")).toEqual({ allowPatterns: ["view", "grep"] });
  });

  it("returns undefined for unregistered sessions", () => {
    const registry = createSessionPermissionRegistry();
    expect(registry.getPolicy("unknown")).toBeUndefined();
  });

  it("unregisters a session", () => {
    const registry = createSessionPermissionRegistry();
    registry.register("session-1", { allowPatterns: ["view"] });
    registry.unregister("session-1");
    expect(registry.getPolicy("session-1")).toBeUndefined();
  });
});

describe("createPermissionHandler with session registry", () => {
  it("allows tools matching session policy", async () => {
    const registry = createSessionPermissionRegistry();
    registry.register("sess-1", { allowPatterns: ["view", "grep", "glob"] });
    const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog, registry);

    const result = await handler(makeRequest("view", undefined, "sess-1"));
    expect(result.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("denies tools NOT in session policy", async () => {
    const registry = createSessionPermissionRegistry();
    registry.register("sess-1", { allowPatterns: ["view", "grep"] });
    const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog, registry);

    const result = await handler(makeRequest("bash", undefined, "sess-1"));
    expect(result.outcome).toEqual({ outcome: "selected", optionId: "reject-1" });
  });

  it("denies edit for verifier preset", async () => {
    const registry = createSessionPermissionRegistry();
    // verifier: codebase_read + shell_execute + github_read
    registry.register("reviewer-session", {
      allowPatterns: ["view", "grep", "glob", "bash", "github-mcp-server-issue_read"],
    });
    const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog, registry);

    const editResult = await handler(makeRequest("edit", undefined, "reviewer-session"));
    expect(editResult.outcome).toEqual({ outcome: "selected", optionId: "reject-1" });

    const bashResult = await handler(makeRequest("bash", undefined, "reviewer-session"));
    expect(bashResult.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("falls back to global config when session has no policy", async () => {
    const registry = createSessionPermissionRegistry();
    const handler = createPermissionHandler(
      { autoApprove: true, allowPatterns: [] },
      silentLog,
      registry,
    );

    // No policy registered for this session → global autoApprove
    const result = await handler(makeRequest("bash", undefined, "unregistered-session"));
    expect(result.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("session policy takes precedence over global autoApprove", async () => {
    const registry = createSessionPermissionRegistry();
    registry.register("locked-session", { allowPatterns: ["view"] });
    // Global says autoApprove, but session says only "view"
    const handler = createPermissionHandler(
      { autoApprove: true, allowPatterns: [] },
      silentLog,
      registry,
    );

    const result = await handler(makeRequest("bash", undefined, "locked-session"));
    expect(result.outcome).toEqual({ outcome: "selected", optionId: "reject-1" });
  });

  it("allows GitHub MCP read tools via substring match", async () => {
    const registry = createSessionPermissionRegistry();
    registry.register("planner-session", {
      allowPatterns: ["view", "grep", "glob", "github-mcp-server-list_", "github-mcp-server-get_"],
    });
    const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog, registry);

    const result = await handler(
      makeRequest("github-mcp-server-list_issues", undefined, "planner-session"),
    );
    expect(result.outcome).toEqual({ outcome: "selected", optionId: "allow-1" });
  });

  it("denies GitHub MCP write tools when only read is allowed", async () => {
    const registry = createSessionPermissionRegistry();
    registry.register("observer-session", {
      allowPatterns: ["view", "grep", "glob", "github-mcp-server-issue_read"],
    });
    const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog, registry);

    const result = await handler(
      makeRequest("github-mcp-server-create_issue", undefined, "observer-session"),
    );
    expect(result.outcome).toEqual({ outcome: "selected", optionId: "reject-1" });
  });

  it("cancels when no reject option available for denied tool", async () => {
    const registry = createSessionPermissionRegistry();
    registry.register("sess-1", { allowPatterns: ["view"] });
    const handler = createPermissionHandler(DEFAULT_PERMISSION_CONFIG, silentLog, registry);

    const result = await handler(
      makeRequest("bash", [{ kind: "allow_once", optionId: "a1" }], "sess-1"),
    );
    expect(result.outcome).toEqual({ outcome: "cancelled" });
  });
});
