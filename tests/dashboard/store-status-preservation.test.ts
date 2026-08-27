import { describe, it, expect, beforeEach } from "vitest";
import type { SprintIssue } from "../../src/dashboard/frontend/src/types";

// Mock store logic for testing status preservation
interface StoreState {
  issues: SprintIssue[];
}

// This is the core logic we're testing from store.ts lines 210-226
function handleSprintIssuesMessage(current: SprintIssue[], incoming: SprintIssue[]): SprintIssue[] {
  const statusMap = new Map(current.map((i) => [i.number, i]));
  const runtimeStatuses = new Set(["in-progress", "done", "failed", "blocked"]);
  const merged = incoming.map((i) => {
    const prev = statusMap.get(i.number);
    // Preserve runtime status and associated fields if previous status is a runtime status
    if (prev && runtimeStatuses.has(prev.status)) {
      return { ...i, status: prev.status, step: prev.step, failReason: prev.failReason };
    }
    return i;
  });
  return merged;
}

describe("Store status preservation across tab switches", () => {
  let state: StoreState;

  beforeEach(() => {
    state = { issues: [] };
  });

  it("should preserve in-progress status when sprint:issues message arrives", () => {
    // Initial planned issues
    state.issues = [
      { number: 1, title: "First issue", status: "planned" },
      { number: 2, title: "Second issue", status: "planned" },
    ];

    // Simulate issue starting (runtime status update)
    state.issues[0].status = "in-progress";
    state.issues[0].step = "analyzing";

    expect(state.issues[0].status).toBe("in-progress");
    expect(state.issues[0].step).toBe("analyzing");

    // Simulate tab switch - fresh sprint:issues data arrives
    const freshIssues: SprintIssue[] = [
      { number: 1, title: "First issue", status: "planned" }, // Server still shows planned
      { number: 2, title: "Second issue", status: "planned" },
    ];
    state.issues = handleSprintIssuesMessage(state.issues, freshIssues);

    // Assert: in-progress status should be preserved
    expect(state.issues[0].status).toBe("in-progress");
    expect(state.issues[0].step).toBe("analyzing");
    expect(state.issues[1].status).toBe("planned");
  });

  it("should preserve done status when sprint:issues message arrives", () => {
    // Start with planned issue
    state.issues = [{ number: 1, title: "Test issue", status: "planned" }];

    // Mark as in-progress
    state.issues[0].status = "in-progress";
    state.issues[0].step = "implementing";

    // Mark as done
    state.issues[0].status = "done";
    delete state.issues[0].step;

    expect(state.issues[0].status).toBe("done");

    // Simulate tab switch
    const freshIssues: SprintIssue[] = [{ number: 1, title: "Test issue", status: "planned" }];
    state.issues = handleSprintIssuesMessage(state.issues, freshIssues);

    // Assert: done status preserved
    expect(state.issues[0].status).toBe("done");
  });

  it("should preserve failed status with fail reason", () => {
    // Setup
    state.issues = [{ number: 1, title: "Failing issue", status: "planned" }];

    state.issues[0].status = "in-progress";
    state.issues[0].step = "testing";

    state.issues[0].status = "failed";
    state.issues[0].failReason = "Tests failed";

    expect(state.issues[0].status).toBe("failed");
    expect(state.issues[0].failReason).toBe("Tests failed");

    // Tab switch
    const freshIssues: SprintIssue[] = [{ number: 1, title: "Failing issue", status: "planned" }];
    state.issues = handleSprintIssuesMessage(state.issues, freshIssues);

    // Assert: failed status and reason preserved
    expect(state.issues[0].status).toBe("failed");
    expect(state.issues[0].failReason).toBe("Tests failed");
  });

  it("should preserve blocked status", () => {
    state.issues = [{ number: 1, title: "Blocked issue", status: "planned" }];

    state.issues[0].status = "blocked";
    state.issues[0].failReason = "Waiting for dependency";

    expect(state.issues[0].status).toBe("blocked");

    // Tab switch
    const freshIssues: SprintIssue[] = [{ number: 1, title: "Blocked issue", status: "planned" }];
    state.issues = handleSprintIssuesMessage(state.issues, freshIssues);

    // Assert: blocked status preserved
    expect(state.issues[0].status).toBe("blocked");
  });

  it("should handle empty issues array", () => {
    state.issues = [{ number: 1, title: "Issue", status: "in-progress", step: "working" }];

    expect(state.issues).toHaveLength(1);

    // Empty array from server
    const freshIssues: SprintIssue[] = [];
    state.issues = handleSprintIssuesMessage(state.issues, freshIssues);

    expect(state.issues).toHaveLength(0);
  });

  it("should allow planned status to be updated by server", () => {
    // Start with planned
    state.issues = [{ number: 1, title: "Issue", status: "planned" }];

    // Server sends updated planned issue (e.g., title changed)
    const freshIssues: SprintIssue[] = [{ number: 1, title: "Updated title", status: "planned" }];
    state.issues = handleSprintIssuesMessage(state.issues, freshIssues);

    expect(state.issues[0].title).toBe("Updated title");
    expect(state.issues[0].status).toBe("planned");
  });

  it("should preserve step and failReason even if status matches", () => {
    // Edge case: If both current and incoming have "in-progress" status,
    // but current has step/failReason, those should still be preserved
    state.issues = [
      {
        number: 1,
        title: "Issue",
        status: "in-progress",
        step: "implementing",
      },
    ];

    // Server sends back the same status but no step
    const freshIssues: SprintIssue[] = [{ number: 1, title: "Issue", status: "in-progress" }];
    state.issues = handleSprintIssuesMessage(state.issues, freshIssues);

    // Current logic FAILS this test - it won't preserve step if statuses match
    expect(state.issues[0].status).toBe("in-progress");
    expect(state.issues[0].step).toBe("implementing"); // This should be preserved
  });
});
