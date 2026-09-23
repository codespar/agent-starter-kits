import { describe, expect, it } from "vitest";
import { createCodeSparClient } from "../src/api/client.js";
import { assertTestKey, isTestKey, NotATestKeyError, redactKey } from "../src/secrets.js";

describe("sandbox by construction", () => {
  it("accepts only csk_test_ keys", () => {
    expect(isTestKey("csk_test_abcdef")).toBe(true);
    expect(isTestKey("csk_live_abcdef")).toBe(false);
    expect(isTestKey("csk_test_")).toBe(false);
    expect(isTestKey(undefined)).toBe(false);
    expect(() => assertTestKey("csk_live_abcdef")).toThrow(NotATestKeyError);
  });

  it("refuses to build an API client with a live key, before any network", () => {
    expect(() => createCodeSparClient({ apiKey: "csk_live_0123456789" })).toThrow(NotATestKeyError);
    expect(() => createCodeSparClient({ apiKey: undefined })).toThrow(NotATestKeyError);
    expect(createCodeSparClient({ apiKey: "csk_test_0123456789" })).toBeDefined();
  });

  it("redacts keys for logs", () => {
    expect(redactKey("csk_test_0123456789abcdef")).toBe("csk_test_…cdef");
    expect(redactKey("csk_test_0123456789abcdef")).not.toContain("0123456789");
  });
});
