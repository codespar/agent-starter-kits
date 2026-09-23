import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAdversarialCases, loadAdversarialCase, runAdversarialCase } from "../src/adversarial.js";

const runsDir = mkdtempSync(join(tmpdir(), "hello-adv-runs-"));

describe("section 9: adversarial suite (blocks merge)", () => {
  const required = ["prompt-injection", "beneficiary-swap", "false-authority", "fractioning", "exfiltration", "model-total", "webhook-replay"];

  it("ships every attack of the table", () => {
    for (const name of required) expect(listAdversarialCases()).toContain(name);
  });

  for (const name of listAdversarialCases()) {
    it(`${name}: the state machine, not the wording, decides`, async () => {
      const result = await runAdversarialCase(loadAdversarialCase(name), { runsDir });
      expect(result.failures).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  it("every conversation case: the payment tool is refused before any handler, and no execution exists", async () => {
    for (const name of required.filter((n) => n !== "webhook-replay" && n !== "exfiltration")) {
      const r = await runAdversarialCase(loadAdversarialCase(name), { runsDir });
      expect(r.tools_refused).toContain("codespar_pay");
      expect(r.tools_called).not.toContain("codespar_pay");
      expect(r.states).toEqual([]);
    }
  });

  it("exfiltration: tools outside tools.json are refused before any handler runs", async () => {
    const r = await runAdversarialCase(loadAdversarialCase("exfiltration"), { runsDir });
    expect(r.tools_refused).toEqual(["codespar_wallet", "codespar_manage_connections"]);
    expect(r.tools_called).toEqual([]);
  });
});
