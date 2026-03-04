import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeSessionLog } from "../../src/dashboard/session-logger.js";
import type { ChatSession } from "../../src/dashboard/chat-manager.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

function makeSession(overrides?: Partial<ChatSession>): ChatSession {
  return {
    id: "chat-123-abc",
    role: "refiner",
    acpSessionId: "acp-1",
    model: "gpt-4",
    createdAt: new Date("2026-02-28T14:00:00Z"),
    messages: [
      { role: "user", content: "Refine issue #10", timestamp: new Date("2026-02-28T14:00:01Z") },
      { role: "assistant", content: "I'll read the issue first.", timestamp: new Date("2026-02-28T14:00:02Z") },
    ],
    ...overrides,
  };
}

describe("writeSessionLog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a log file to the correct path", () => {
    writeSessionLog(makeSession(), { projectPath: "/proj", sprintNumber: 3 });

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      path.join("/proj", ".aiscrum", "roles", "refiner", "log", "sprint-3"),
      { recursive: true },
    );
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
    const [filepath] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(String(filepath)).toContain("sprint-3");
    expect(String(filepath)).toContain("-chat.md");
  });

  it("includes session metadata in log content", () => {
    writeSessionLog(makeSession(), { projectPath: "/proj", sprintNumber: 1 });

    const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain("# Chat Session: refiner");
    expect(content).toContain("**Role**: refiner");
    expect(content).toContain("**Model**: gpt-4");
    expect(content).toContain("**Messages**: 2");
    expect(content).toContain("chat-123-abc");
  });

  it("includes full message transcript", () => {
    writeSessionLog(makeSession(), { projectPath: "/proj", sprintNumber: 1 });

    const content = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    expect(content).toContain("👤 User");
    expect(content).toContain("Refine issue #10");
    expect(content).toContain("🤖 Assistant");
    expect(content).toContain("I'll read the issue first.");
  });

  it("skips empty sessions", () => {
    writeSessionLog(makeSession({ messages: [] }), { projectPath: "/proj", sprintNumber: 1 });

    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("handles write errors gracefully without throwing", () => {
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => {
      writeSessionLog(makeSession(), { projectPath: "/proj", sprintNumber: 1 });
    }).not.toThrow();
  });

  it("uses the role from the session for the log path", () => {
    writeSessionLog(makeSession({ role: "planner" }), { projectPath: "/proj", sprintNumber: 2 });

    const dirCall = vi.mocked(fs.mkdirSync).mock.calls[0][0] as string;
    expect(dirCall).toContain(path.join("roles", "planner", "log", "sprint-2"));
  });

  it("generates unique filenames from session timestamp", () => {
    writeSessionLog(makeSession(), { projectPath: "/proj", sprintNumber: 1 });

    const filepath = String(vi.mocked(fs.writeFileSync).mock.calls[0][0]);
    expect(filepath).toContain("2026-02-28T14-00-00");
  });
});
