import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cp from "node:child_process";
import { getIssue, addComment, getComments, listIssues, createIssue, execGh } from "../../src/github/issues.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(cp.execFile);

function mockExecFileSuccess(stdout: string): void {
  mockExecFile.mockImplementation(
    ((_cmd: unknown, _args: unknown, callback: unknown) => {
      (callback as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
        null,
        { stdout, stderr: "" },
      );
    }) as typeof cp.execFile,
  );
}

function mockExecFileError(message: string): void {
  mockExecFile.mockImplementation(
    ((_cmd: unknown, _args: unknown, callback: unknown) => {
      (callback as (err: Error | null) => void)(new Error(message));
    }) as typeof cp.execFile,
  );
}

function mockExecFileErrorWithCode(message: string, code: string | number): void {
  mockExecFile.mockImplementation(
    ((_cmd: unknown, _args: unknown, callback: unknown) => {
      const err = new Error(message) as NodeJS.ErrnoException;
      err.code = String(code);
      // For numeric exit codes, set as number to match child_process behavior
      if (typeof code === "number") {
        (err as unknown as Record<string, unknown>).code = code;
      }
      (callback as (err: Error | null) => void)(err);
    }) as typeof cp.execFile,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("execGh", () => {
  it("calls gh with provided args", async () => {
    mockExecFileSuccess('{"ok": true}');
    const result = await execGh(["issue", "list"]);
    expect(result).toBe('{"ok": true}');
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "list"],
      expect.any(Function),
    );
  });

  it("throws on failure with descriptive message", async () => {
    mockExecFileError("not authenticated");
    await expect(execGh(["issue", "list"])).rejects.toThrow(
      "gh issue list failed: not authenticated",
    );
  });

  it("throws helpful message when gh CLI is not installed (ENOENT)", async () => {
    mockExecFileErrorWithCode("spawn gh ENOENT", "ENOENT");
    await expect(execGh(["issue", "list"])).rejects.toThrow(
      "gh CLI not found. Install it: https://cli.github.com/",
    );
  });

  it("throws helpful message when gh CLI is not authenticated (exit code 4)", async () => {
    mockExecFileErrorWithCode("gh auth required", 4);
    await expect(execGh(["issue", "list"])).rejects.toThrow(
      "gh CLI not authenticated. Run: gh auth login",
    );
  });
});

describe("getIssue", () => {
  it("returns parsed issue data", async () => {
    const issue = {
      number: 42,
      title: "Fix bug",
      body: "Some body",
      labels: [{ name: "bug" }],
      state: "OPEN",
    };
    mockExecFileSuccess(JSON.stringify(issue));

    const result = await getIssue(42);
    expect(result).toEqual(issue);
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "view", "42", "--json", "number,title,body,labels,state,milestone"],
      expect.any(Function),
    );
  });

  it("throws when issue not found", async () => {
    mockExecFileError("Could not resolve to an issue");
    await expect(getIssue(9999)).rejects.toThrow("gh issue view 9999");
  });
});

describe("addComment", () => {
  it("calls gh issue comment with body", async () => {
    mockExecFileSuccess("");
    await addComment(10, "Hello world");
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "comment", "10", "--body", "Hello world"],
      expect.any(Function),
    );
  });

  it("throws on error", async () => {
    mockExecFileError("permission denied");
    await expect(addComment(10, "test")).rejects.toThrow("permission denied");
  });
});

describe("getComments", () => {
  it("returns parsed comments newest first", async () => {
    const comments = [
      { body: "Latest comment", createdAt: "2026-03-02T00:00:00Z" },
      { body: "Older comment", createdAt: "2026-03-01T00:00:00Z" },
    ];
    mockExecFileSuccess(JSON.stringify(comments));
    const result = await getComments(42, 5);
    expect(result).toEqual(comments);
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "view", "42", "--json", "comments", "--jq", ".comments | sort_by(.createdAt) | reverse | .[:5]"],
      expect.any(Function),
    );
  });

  it("returns empty array on invalid JSON", async () => {
    mockExecFileSuccess("not-json");
    const result = await getComments(1);
    expect(result).toEqual([]);
  });

  it("returns empty array on error", async () => {
    mockExecFileSuccess("");
    const result = await getComments(1);
    expect(result).toEqual([]);
  });
});

describe("listIssues", () => {
  it("lists issues without filters", async () => {
    const issues = [
      { number: 1, title: "A", body: "", labels: [], state: "OPEN" },
    ];
    mockExecFileSuccess(JSON.stringify(issues));

    const result = await listIssues();
    expect(result).toEqual(issues);
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      ["issue", "list", "--json", "number,title,body,labels,state,milestone"],
      expect.any(Function),
    );
  });

  it("passes label and state filters", async () => {
    mockExecFileSuccess("[]");

    await listIssues({ labels: ["bug", "urgent"], state: "open" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      [
        "issue", "list",
        "--json", "number,title,body,labels,state,milestone",
        "--label", "bug,urgent",
        "--state", "open",
      ],
      expect.any(Function),
    );
  });

  it("passes milestone filter", async () => {
    mockExecFileSuccess("[]");

    await listIssues({ milestone: "Sprint 1" });
    expect(mockExecFile).toHaveBeenCalledWith(
      "gh",
      [
        "issue", "list",
        "--json", "number,title,body,labels,state,milestone",
        "--milestone", "Sprint 1",
      ],
      expect.any(Function),
    );
  });
});

describe("createIssue", () => {
  it("rejects empty title", async () => {
    await expect(createIssue({ title: "", body: "desc" })).rejects.toThrow(
      "title is required",
    );
  });

  it("rejects undefined title", async () => {
    await expect(createIssue({ title: undefined as unknown as string, body: "desc" })).rejects.toThrow(
      "title is required",
    );
  });

  it("rejects empty body", async () => {
    await expect(createIssue({ title: "Valid title", body: "" })).rejects.toThrow(
      "body is required",
    );
  });

  it("skips creation if duplicate open issue exists", async () => {
    const existing = [
      { number: 42, title: "chore(process): Fix something", body: "desc", labels: [], state: "OPEN" },
    ];
    // First call: listIssues for dedup check; second call would be createIssue (should not happen)
    let callCount = 0;
    mockExecFile.mockImplementation(
      ((_cmd: unknown, args: unknown, callback: unknown) => {
        callCount++;
        const argList = args as string[];
        if (argList[0] === "issue" && argList[1] === "list") {
          (callback as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
            null, { stdout: JSON.stringify(existing), stderr: "" },
          );
        } else {
          (callback as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
            null, { stdout: "", stderr: "" },
          );
        }
      }) as typeof cp.execFile,
    );

    const result = await createIssue({ title: "chore(process): Fix something", body: "desc" });
    expect(result.number).toBe(42);
    // Should only have called listIssues, not issue create
    expect(callCount).toBe(1);
  });
});
