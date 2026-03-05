import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { extractJson, parseWithRetry } from "../../src/ceremonies/helpers.js";

describe("extractJson", () => {
  it("throws descriptive error for malformed JSON", () => {
    expect(() => extractJson("```json\n{invalid}\n```")).toThrow("Failed to parse JSON");
  });

  it("throws for garbage text with braces", () => {
    expect(() => extractJson("{not json at all}")).toThrow("Failed to parse JSON");
  });

  it("throws for empty string", () => {
    expect(() => extractJson("")).toThrow("No JSON found");
  });

  it("throws for truncated JSON", () => {
    expect(() => extractJson('{"key": "val')).toThrow();
  });

  it("handles valid JSON in fenced block", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("handles valid JSON without fence", () => {
    expect(extractJson('some text {"a":1} more text')).toEqual({ a: 1 });
  });
});

vi.mock("../../src/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

describe("parseWithRetry", () => {
  const schema = z.object({ decision: z.string(), issues: z.array(z.string()).default([]) });

  it("succeeds on first attempt with valid JSON", async () => {
    const retryFn = vi.fn();
    const result = await parseWithRetry(schema, '```json\n{"decision":"approved"}\n```', retryFn);
    expect(result).toEqual({ decision: "approved", issues: [] });
    expect(retryFn).not.toHaveBeenCalled();
  });

  it("retries on invalid JSON and succeeds on second attempt", async () => {
    const retryFn = vi
      .fn()
      .mockResolvedValue('```json\n{"decision":"rejected","issues":["bug"]}\n```');
    const result = await parseWithRetry(schema, "no json here", retryFn);
    expect(result).toEqual({ decision: "rejected", issues: ["bug"] });
    expect(retryFn).toHaveBeenCalledOnce();
    expect(retryFn.mock.calls[0][0]).toContain("could not be parsed");
  });

  it("throws after exhausting all retries", async () => {
    const retryFn = vi.fn().mockResolvedValue("still no json");
    await expect(parseWithRetry(schema, "bad", retryFn)).rejects.toThrow();
    expect(retryFn).toHaveBeenCalledTimes(2);
  });

  it("retries on schema validation failure (valid JSON but wrong shape)", async () => {
    const retryFn = vi.fn().mockResolvedValue('```json\n{"decision":"ok"}\n```');
    const result = await parseWithRetry(schema, '{"wrong_field": 123}', retryFn);
    expect(result.decision).toBe("ok");
  });
});
