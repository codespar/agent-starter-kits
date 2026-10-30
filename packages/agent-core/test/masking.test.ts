/**
 * The redactor the bundle and `inspect` share (#116): a key found by its
 * shape in free text, with nothing handed over, and never a piece of an id or
 * a hash.
 */
import { describe, expect, it } from "vitest";
import { maskPayee, redactorFor } from "../src/masking.js";

const redact = redactorFor([]);

describe("redactorFor masks a key by its shape", () => {
  it("a bare CPF at the end of a sentence or after a label", () => {
    expect(redact("Paguei ao CPF 11144477735.")).toBe(`Paguei ao CPF ${maskPayee("11144477735")}.`);
    expect(redact("chave:11144477735")).toBe(`chave:${maskPayee("11144477735")}`);
    expect(redact("CNPJ 11222333000181.")).toBe(`CNPJ ${maskPayee("11222333000181")}.`);
  });

  it("leaves ids, hashes and decimals that hold the same digits alone", () => {
    const evp = "123e4567-e89b-42d3-a456-426614174000";
    for (const untouched of [`sha256:${"1".repeat(11)}abcdef`, `sha256:${"12345678901".repeat(5)}9`, `exe_${evp}`, "R$ 11144477735.50", "1759000000000", "receipts/11144477735/x"]) {
      expect(redact(untouched)).toBe(untouched);
    }
  });

  it("costs linear time on a long value, with or without an @", () => {
    for (const value of ["x".repeat(100_000), `${"x".repeat(50_000)}@${"y".repeat(50_000)}`, "a@".repeat(50_000)]) {
      const started = performance.now();
      redact(value);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });
});
