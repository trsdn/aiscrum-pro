import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/github/issues.js", () => ({
  execGh: vi.fn().mockResolvedValue(""),
}));
vi.mock("../../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { execGh } from "../../src/github/issues.js";
import {
  setLabel,
  removeLabel,
  getLabels,
  ensureLabelExists,
  setStatusLabel,
} from "../../src/github/labels.js";

const mockExecGh = vi.mocked(execGh);

describe("labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecGh.mockResolvedValue("");
  });

  it("setLabel calls gh issue edit with --add-label", async () => {
    await setLabel(42, "bug");
    expect(mockExecGh).toHaveBeenCalledWith(["issue", "edit", "42", "--add-label", "bug"]);
  });

  it("removeLabel calls gh issue edit with --remove-label", async () => {
    await removeLabel(42, "bug");
    expect(mockExecGh).toHaveBeenCalledWith(["issue", "edit", "42", "--remove-label", "bug"]);
  });

  it("getLabels returns parsed label array", async () => {
    mockExecGh.mockResolvedValueOnce('{"labels": [{"name": "bug"}]}');
    const result = await getLabels(42);
    expect(result).toEqual([{ name: "bug" }]);
  });

  it("ensureLabelExists creates label when not found", async () => {
    mockExecGh.mockResolvedValueOnce("[]"); // list call
    await ensureLabelExists("new-label");
    expect(mockExecGh).toHaveBeenCalledTimes(2);
    expect(mockExecGh).toHaveBeenNthCalledWith(2, ["label", "create", "new-label", "--force"]);
  });

  it("ensureLabelExists skips creation when label exists", async () => {
    mockExecGh.mockResolvedValueOnce('[{"name": "bug"}]'); // list call
    await ensureLabelExists("bug");
    expect(mockExecGh).toHaveBeenCalledTimes(1);
  });

  it("ensureLabelExists passes color and description", async () => {
    mockExecGh.mockResolvedValueOnce("[]"); // list call
    await ensureLabelExists("label", "ff0000", "A label");
    expect(mockExecGh).toHaveBeenNthCalledWith(2, [
      "label",
      "create",
      "label",
      "--color",
      "ff0000",
      "--description",
      "A label",
      "--force",
    ]);
  });

  it("setStatusLabel removes stale status labels before adding new one", async () => {
    mockExecGh
      .mockResolvedValueOnce('{"labels": [{"name": "status:planned"}, {"name": "bug"}]}') // getLabels
      .mockResolvedValueOnce("") // removeLabel status:planned
      .mockResolvedValueOnce(""); // setLabel status:in-progress
    await setStatusLabel(42, "status:in-progress");
    expect(mockExecGh).toHaveBeenCalledWith([
      "issue",
      "edit",
      "42",
      "--remove-label",
      "status:planned",
    ]);
    expect(mockExecGh).toHaveBeenCalledWith([
      "issue",
      "edit",
      "42",
      "--add-label",
      "status:in-progress",
    ]);
  });

  it("setStatusLabel does not remove the target label itself", async () => {
    mockExecGh
      .mockResolvedValueOnce('{"labels": [{"name": "status:done"}]}') // getLabels
      .mockResolvedValueOnce(""); // setLabel
    await setStatusLabel(42, "status:done");
    expect(mockExecGh).toHaveBeenCalledTimes(2); // getLabels + setLabel only
  });

  it("setStatusLabel works even when getLabels fails", async () => {
    mockExecGh
      .mockRejectedValueOnce(new Error("gh failed")) // getLabels
      .mockResolvedValueOnce(""); // setLabel
    await setStatusLabel(42, "status:blocked");
    expect(mockExecGh).toHaveBeenCalledWith([
      "issue",
      "edit",
      "42",
      "--add-label",
      "status:blocked",
    ]);
  });
});
