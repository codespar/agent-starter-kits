/**
 * A hosted consent link carries its credential (a PAR request_uri, a JWT).
 * The stub rail's table keeps that an instrument had one, never the link.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StateStore } from "../src/index.js";

const dirs: string[] = [];
function store(): StateStore {
  const dir = mkdtempSync(join(tmpdir(), "consent-at-rest-"));
  dirs.push(dir);
  return new StateStore(join(dir, "state.db"));
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const LINK = "https://bank.example/consent?request_uri=urn:secret-par";
const accepted = (url: string | null) => ({ status: "accepted", transaction_id: "ch_1", instrument: { payable: true, status: "PENDING", pix_copy_paste: "000201pix", boleto_bank_line: null, boleto_bar_code: null, due_date: null, consent_url: url, consent_step: "sign" } });
const raw = (s: StateStore) => (s as unknown as { db: { prepare(sql: string): { all(): Array<{ outcome: string }> } } }).db.prepare("SELECT outcome FROM stub_rail_attempts").all().map((r) => r.outcome).join("\n");

describe("stub_rail_attempts keeps has_consent_url, never the link", () => {
  it("on the first write and on a replace", () => {
    const s = store();
    expect(s.stubRailPut("att_1", { amount: 100 }, accepted(LINK), "2026-11-09T12:00:00Z")).toBe(true);
    expect(s.stubRailGet("att_1")?.outcome).toMatchObject({ transaction_id: "ch_1", instrument: { consent_url: null, has_consent_url: true, consent_step: "sign", pix_copy_paste: "000201pix" } });
    s.stubRailReplace("att_1", { amount: 100 }, accepted("https://app.example/agentic/pay/1?token=jwt-secret"), "2026-11-09T12:01:00Z");
    expect(s.stubRailGet("att_1")?.outcome).toMatchObject({ instrument: { consent_url: null, has_consent_url: true } });
    for (const piece of ["request_uri", "secret-par", "jwt-secret", "bank.example"]) expect(raw(s)).not.toContain(piece);
    // Still found by its transaction id: only the link went.
    expect(s.stubRailFindByTransaction("ch_1")).toBeDefined();
  });

  it("an outcome with no consent link is written as it was", () => {
    const s = store();
    const plain = accepted(null);
    s.stubRailPut("att_2", {}, plain, "2026-11-09T12:00:00Z");
    expect(s.stubRailGet("att_2")?.outcome).toEqual(plain);
    s.stubRailPut("att_3", {}, { status: "settled", transaction_id: "tx_3" }, "2026-11-09T12:00:00Z");
    expect(s.stubRailGet("att_3")?.outcome).toEqual({ status: "settled", transaction_id: "tx_3" });
  });
});
