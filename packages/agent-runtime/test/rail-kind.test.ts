/**
 * Which rail a command builds when no `--rail` is given. A CodeSpar key
 * decides it for the agents on the CodeSpar API; an agent whose live rail is
 * elsewhere (`apiRailKey: "none"`) is on `api` only when every variable it
 * names in `apiRailEnv` is set, and never because of a CodeSpar key.
 */
import { describe, expect, it } from "vitest";
import { CODESPAR_KEY_PLACEHOLDER, resolveRailKind } from "../src/setup.js";

const KEY = "csk_test_rail_kind_not_a_key";

describe("resolveRailKind", () => {
  it("answers the flag when one is given", () => {
    expect(resolveRailKind({}, "api")).toBe("api");
    expect(resolveRailKind({ CODESPAR_API_KEY: KEY }, "stub")).toBe("stub");
    expect(resolveRailKind({}, "api", { apiRailKey: "none" })).toBe("api");
  });

  it("follows the CodeSpar key by default, the placeholder counting as none", () => {
    expect(resolveRailKind({ CODESPAR_API_KEY: KEY }, undefined)).toBe("api");
    expect(resolveRailKind({ CODESPAR_API_KEY: CODESPAR_KEY_PLACEHOLDER }, undefined)).toBe("stub");
    expect(resolveRailKind({}, undefined)).toBe("stub");
  });

  describe('with apiRailKey: "none"', () => {
    const kit = { apiRailKey: "none" as const, apiRailEnv: ["RAIL_ID", "RAIL_SECRET"] };

    it("is api only when every variable in apiRailEnv is set and not blank", () => {
      expect(resolveRailKind({ RAIL_ID: "a", RAIL_SECRET: "b" }, undefined, kit)).toBe("api");
      expect(resolveRailKind({ RAIL_ID: "a" }, undefined, kit)).toBe("stub");
      expect(resolveRailKind({ RAIL_ID: "a", RAIL_SECRET: "   " }, undefined, kit)).toBe("stub");
    });

    it("never follows a CodeSpar key", () => {
      expect(resolveRailKind({ CODESPAR_API_KEY: KEY }, undefined, kit)).toBe("stub");
      expect(resolveRailKind({ CODESPAR_API_KEY: KEY }, undefined, { apiRailKey: "none" })).toBe("stub");
    });

    it("with no apiRailEnv, or an empty one, is always the stub", () => {
      expect(resolveRailKind({ RAIL_ID: "a" }, undefined, { apiRailKey: "none" })).toBe("stub");
      expect(resolveRailKind({ RAIL_ID: "a" }, undefined, { apiRailKey: "none", apiRailEnv: [] })).toBe("stub");
    });
  });
});
