/**
 * A pull with two consent pages in one attempt (Iniciador JSR: register the
 * passkey, then sign the payment) has each page shown once. `markShown` keys
 * a `consent_step` apart from the attempt; without one the key is the
 * attempt's alone, so a sweeping pull and the markers already in a state.db
 * read exactly as before.
 */
import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

describe("markShown and consent_step", () => {
  it("without a step, an attempt is shown once, under the key it always had", () => {
    const h = harness();
    expect(h.engine.markShown("exe_1", "att_1_0")).toBe(true);
    expect(h.engine.markShown("exe_1", "att_1_0")).toBe(false);
    expect(h.store.getCursor("shown:exe_1:att_1_0")).toBeTruthy();
  });

  it("enroll and sign are two pages of one attempt, each shown once", () => {
    const h = harness();
    expect(h.engine.markShown("exe_1", "att_1_0", "enroll")).toBe(true);
    expect(h.engine.markShown("exe_1", "att_1_0", "enroll")).toBe(false);
    expect(h.engine.markShown("exe_1", "att_1_0", "sign")).toBe(true);
    expect(h.engine.markShown("exe_1", "att_1_0", "sign")).toBe(false);
  });

  it("a step never reads a step-less marker as its own, nor the other way round", () => {
    const h = harness();
    expect(h.engine.markShown("exe_1", "att_1_0")).toBe(true);
    expect(h.engine.markShown("exe_1", "att_1_0", "sign")).toBe(true);
    expect(h.engine.markShown("exe_1", "att_1_0")).toBe(false);
  });
});
