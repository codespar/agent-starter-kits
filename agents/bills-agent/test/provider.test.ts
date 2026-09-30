/**
 * Which model runs: the Anthropic provider only with a real key. The
 * `.env.example` placeholder, an empty value and an absent variable all
 * mean "replay the recorded transcript", so a copied example never calls
 * Anthropic with a fake key (issue #8).
 */
import { describe, expect, it } from "vitest";
import { ANTHROPIC_KEY_PLACEHOLDER, resolveProvider } from "@codespar/agent-runtime";

const REAL_LOOKING_KEY = ["sk", "ant", "x".repeat(24)].join("-");

describe("resolveProvider", () => {
  it("treats the .env.example placeholder, an empty value and an absent variable as no key", () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: ANTHROPIC_KEY_PLACEHOLDER }, undefined)).toBe("replay");
    expect(resolveProvider({ ANTHROPIC_API_KEY: "" }, undefined)).toBe("replay");
    expect(resolveProvider({ ANTHROPIC_API_KEY: "   " }, undefined)).toBe("replay");
    expect(resolveProvider({}, undefined)).toBe("replay");
  });

  it("picks Anthropic on a real-looking key, and an explicit --provider wins over the environment", () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: REAL_LOOKING_KEY }, undefined)).toBe("anthropic");
    expect(resolveProvider({ ANTHROPIC_API_KEY: REAL_LOOKING_KEY }, "replay")).toBe("replay");
    expect(resolveProvider({}, "anthropic")).toBe("anthropic");
  });

  it("picks Gemini on a Gemini key when there is no Anthropic key, and keeps Anthropic first when both are set", () => {
    expect(resolveProvider({ GEMINI_API_KEY: "gemini-test-key" }, undefined)).toBe("gemini");
    expect(resolveProvider({ ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "gemini-test-key" }, undefined)).toBe("gemini");
    expect(resolveProvider({ ANTHROPIC_API_KEY: REAL_LOOKING_KEY, GEMINI_API_KEY: "gemini-test-key" }, undefined)).toBe("anthropic");
    expect(resolveProvider({ GEMINI_API_KEY: "   " }, undefined)).toBe("replay");
    expect(resolveProvider({ GEMINI_API_KEY: "gemini-test-key" }, "replay")).toBe("replay");
    expect(resolveProvider({}, "gemini")).toBe("gemini");
  });
});
