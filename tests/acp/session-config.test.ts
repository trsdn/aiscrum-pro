import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs before importing module under test
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import fs from "node:fs/promises";
import {
  resolveSessionConfig,
  loadInstructions,
  type CeremonyPhase,
} from "../../src/acp/session-config.js";
import type { SprintConfig, McpServerEntry } from "../../src/types.js";

const mockedReadFile = vi.mocked(fs.readFile);

/** Build a minimal SprintConfig for testing. */
function makeConfig(overrides: Partial<SprintConfig> = {}): SprintConfig {
  return {
    sprintNumber: 1,
    sprintPrefix: "S1",
    sprintSlug: "sprint-1",
    projectPath: "/project",
    baseBranch: "main",
    worktreeBase: "/tmp/worktrees",
    branchPattern: "feat/{issue}-{slug}",
    maxParallelSessions: 2,
    maxIssuesPerSprint: 5,
    maxDriftIncidents: 2,
    maxRetries: 3,
    enableChallenger: false,
    autoRevertDrift: false,
    backlogLabels: [],
    autoMerge: false,
    squashMerge: true,
    deleteBranchAfterMerge: true,
    sessionTimeoutMs: 60000,
    customInstructions: "",
    autoApproveTools: false,
    allowToolPatterns: [],
    globalMcpServers: [],
    globalInstructions: [],
    phases: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toAcpMcpServer (via resolveSessionConfig)", () => {
  it("converts stdio server entry", async () => {
    const stdioServer: McpServerEntry = {
      type: "stdio",
      name: "my-stdio",
      command: "node",
      args: ["server.js"],
      env: [{ name: "KEY", value: "val" }],
    };
    const config = makeConfig({ globalMcpServers: [stdioServer] });
    const result = await resolveSessionConfig(config, "worker");

    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0]).toEqual({
      name: "my-stdio",
      command: "node",
      args: ["server.js"],
      env: [{ name: "KEY", value: "val" }],
    });
    // stdio entries should NOT have a `type` field in ACP format
    expect(result.mcpServers[0]).not.toHaveProperty("type");
  });

  it("converts http server entry", async () => {
    const httpServer: McpServerEntry = {
      type: "http",
      name: "my-http",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer tok" }],
    };
    const config = makeConfig({ globalMcpServers: [httpServer] });
    const result = await resolveSessionConfig(config, "worker");

    expect(result.mcpServers[0]).toEqual({
      type: "http",
      name: "my-http",
      url: "https://example.com/mcp",
      headers: [{ name: "Authorization", value: "Bearer tok" }],
    });
  });

  it("converts sse server entry", async () => {
    const sseServer: McpServerEntry = {
      type: "sse",
      name: "my-sse",
      url: "https://example.com/sse",
    };
    const config = makeConfig({ globalMcpServers: [sseServer] });
    const result = await resolveSessionConfig(config, "worker");

    expect(result.mcpServers[0]).toEqual({
      type: "sse",
      name: "my-sse",
      url: "https://example.com/sse",
      headers: [],
    });
  });
});

describe("loadInstructions", () => {
  it("returns empty string for no file paths", async () => {
    const result = await loadInstructions([], "/project");
    expect(result).toBe("");
    expect(mockedReadFile).not.toHaveBeenCalled();
  });

  it("loads and concatenates multiple files", async () => {
    mockedReadFile
      .mockResolvedValueOnce("# Global Instructions" as never)
      .mockResolvedValueOnce("# Phase Instructions" as never);

    const result = await loadInstructions(["global.md", "phase.md"], "/project");
    expect(result).toBe("# Global Instructions\n\n# Phase Instructions");
  });

  it("skips files that fail to read", async () => {
    mockedReadFile
      .mockResolvedValueOnce("content-a" as never)
      .mockRejectedValueOnce(new Error("ENOENT") as never)
      .mockResolvedValueOnce("content-c" as never);

    const result = await loadInstructions(["a.md", "missing.md", "c.md"], "/project");
    expect(result).toBe("content-a\n\ncontent-c");
  });

  it("resolves relative paths against projectPath", async () => {
    mockedReadFile.mockResolvedValueOnce("ok" as never);
    await loadInstructions(["docs/instructions.md"], "/my/project");
    expect(mockedReadFile).toHaveBeenCalledWith(
      expect.stringContaining("/my/project/docs/instructions.md"),
      "utf-8",
    );
  });

  it("uses absolute paths as-is", async () => {
    mockedReadFile.mockResolvedValueOnce("ok" as never);
    await loadInstructions(["/absolute/path.md"], "/project");
    expect(mockedReadFile).toHaveBeenCalledWith("/absolute/path.md", "utf-8");
  });
});

describe("resolveSessionConfig", () => {
  it("returns empty config when no servers or instructions", async () => {
    const config = makeConfig();
    const result = await resolveSessionConfig(config, "planner");

    expect(result.mcpServers).toEqual([]);
    expect(result.instructions).toBe("");
    expect(result.model).toBeUndefined();
  });

  it("merges global and phase-specific MCP servers", async () => {
    const globalServer: McpServerEntry = {
      type: "stdio",
      name: "global-tool",
      command: "gtool",
      args: [],
    };
    const phaseServer: McpServerEntry = {
      type: "http",
      name: "phase-tool",
      url: "https://phase.example.com",
    };

    const config = makeConfig({
      globalMcpServers: [globalServer],
      phases: {
        worker: {
          mcp_servers: [phaseServer],
          instructions: [],
        },
      },
    });

    const result = await resolveSessionConfig(config, "worker");
    expect(result.mcpServers).toHaveLength(2);
    expect(result.mcpServers[0].name).toBe("global-tool");
    expect(result.mcpServers[1].name).toBe("phase-tool");
  });

  it("merges global and phase-specific instructions", async () => {
    mockedReadFile
      .mockResolvedValueOnce("global rules" as never)
      .mockResolvedValueOnce("worker rules" as never);

    const config = makeConfig({
      globalInstructions: ["global.md"],
      phases: {
        worker: {
          mcp_servers: [],
          instructions: ["worker.md"],
        },
      },
    });

    const result = await resolveSessionConfig(config, "worker");
    expect(result.instructions).toBe("global rules\n\nworker rules");
  });

  it("uses model from phase config", async () => {
    const config = makeConfig({
      phases: {
        reviewer: {
          model: "claude-sonnet-4-5-20250514",
          mcp_servers: [],
          instructions: [],
        },
      },
    });

    const result = await resolveSessionConfig(config, "reviewer");
    expect(result.model).toBe("claude-sonnet-4-5-20250514");
  });

  it("returns undefined model when phase has no model override", async () => {
    const config = makeConfig({
      phases: {
        worker: {
          mcp_servers: [],
          instructions: [],
        },
      },
    });

    const result = await resolveSessionConfig(config, "worker");
    expect(result.model).toBeUndefined();
  });

  it("handles unknown phase gracefully", async () => {
    const config = makeConfig({
      globalMcpServers: [{ type: "stdio", name: "g", command: "g", args: [] }],
    });

    // Phase doesn't exist in config.phases — should use only global
    const result = await resolveSessionConfig(config, "challenger" as CeremonyPhase);
    expect(result.mcpServers).toHaveLength(1);
    expect(result.mcpServers[0].name).toBe("g");
    expect(result.model).toBeUndefined();
  });

  it("resolves tool_policy preset to patterns", async () => {
    const config = makeConfig({
      phases: {
        reviewer: {
          model: "claude-opus-4.6",
          tool_policy: "verifier",
          mcp_servers: [],
          instructions: [],
        },
      },
    });

    const result = await resolveSessionConfig(config, "reviewer");
    expect(result.toolPolicy).toBeDefined();
    expect(result.toolPolicy!.allowPatterns).toContain("view");
    expect(result.toolPolicy!.allowPatterns).toContain("bash");
    expect(result.toolPolicy!.allowPatterns).not.toContain("edit");
  });

  it("resolves custom capabilities tool_policy", async () => {
    const config = makeConfig({
      phases: {
        retro: {
          tool_policy: { capabilities: ["codebase_read", "file_edit"] },
          mcp_servers: [],
          instructions: [],
        },
      },
    });

    const result = await resolveSessionConfig(config, "retro" as CeremonyPhase);
    expect(result.toolPolicy).toBeDefined();
    expect(result.toolPolicy!.allowPatterns).toContain("view");
    expect(result.toolPolicy!.allowPatterns).toContain("edit");
    expect(result.toolPolicy!.allowPatterns).not.toContain("bash");
  });

  it("returns undefined toolPolicy when not configured", async () => {
    const config = makeConfig({
      phases: {
        worker: {
          model: "gpt-5.3",
          mcp_servers: [],
          instructions: [],
        },
      },
    });

    const result = await resolveSessionConfig(config, "worker");
    expect(result.toolPolicy).toBeUndefined();
  });
});
