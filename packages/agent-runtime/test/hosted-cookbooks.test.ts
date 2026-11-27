/**
 * CONTRATO v1.8: the docs cookbooks as `recipes` of the catalog, and `kit.cookbook`. Built on the test kit and on files
 * written here, never on the repository's own `cookbooks.yaml` (a scaffold of one agent runs this file and carries none;
 * the repository's file is asserted in the root test/).
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgent } from "../src/agent.js";
import { assembleCatalog, buildCatalog, describeKit } from "../src/hosted/catalog.js";
import { CookbooksFileSchema, buildRecipes, recipesOf, templateCommand, type CookbooksFile } from "../src/hosted/cookbooks.js";
import { HostedCatalogSchema, RecipeSchema, type HostedKitDescriptor } from "../src/hosted/contract.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const TEST_KIT = join(HERE, "fixtures/kits/tip-jar-agent");
const COMMIT = "a".repeat(40);
const SHARED = ["packages/agent-core/src", "packages/agent-runtime/src"];
const copies: string[] = [];
afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

const words = (pt: string, en: string) => ({ "pt-BR": pt, en });
const hosted = (slug: string, kit: string, example: string, extra: Record<string, unknown> = {}) => ({
  slug,
  title: words("Gorjeta", "Tip"),
  status: "hosted" as const,
  kit,
  example,
  coverage: "full" as const,
  inputs: [{ name: "amount", "pt-BR": "R$ 10,00", en: "R$ 10.00" }],
  prerequisites: { keys: ["CODESPAR_API_KEY"], connections: [] },
  expected: words("A gorjeta sai.", "The tip goes out."),
  ...extra,
});
const reference = (slug: string) => ({ slug, title: words("Referência", "Reference"), status: "reference" as const, expected: words("Ler.", "Read."), reason: words("Só leitura.", "Read only.") });
const file = (cookbooks: unknown[]): CookbooksFile =>
  CookbooksFileSchema.parse({ v: 1, docs: { repository: "codespar/codespar-web", commit: "d".repeat(40), path: "content/docs/cookbooks" }, cli: "@codespar/cli@0.22.8", cookbooks });

/** The test kit, optionally declaring a cookbook and stating the inputs of its example. */
async function tipJar(presentation?: { cookbook?: string; inputs?: boolean }): Promise<HostedKitDescriptor> {
  const agent = await loadAgent(TEST_KIT);
  if (!presentation) return describeKit(agent, { root: ROOT, commit: COMMIT, shared: SHARED });
  const dir = mkdtempSync(join(ROOT, "packages/agent-runtime/test/fixtures/kits/.cookbook-"));
  copies.push(dir);
  cpSync(TEST_KIT, dir, { recursive: true });
  const inputs = presentation.inputs ? `        inputs:\n          - { label: "Valor", value: "R$ 10,00" }\n` : "";
  const locale = `    title: "Gorjeta"\n    summary: "Paga uma gorjeta."\n    examples:\n      happy-path:\n        title: "Gorjeta ao barista"\n        description: "Dez reais ao barista."\n${inputs}`;
  const cookbook = presentation.cookbook ? `  cookbook: ${presentation.cookbook}\n` : "";
  writeFileSync(join(dir, "agent.yaml"), `${readFileSync(join(dir, "agent.yaml"), "utf8")}presentation:\n${cookbook}  pt-BR:\n${locale}  en:\n${locale}`);
  return describeKit({ ...agent, dir }, { root: ROOT, commit: COMMIT, shared: SHARED });
}

describe("v1.8: recipes and kit.cookbook", () => {
  it("emits the recipes in the file's order and the kit's cookbook, and the contract accepts the catalog", async () => {
    const kit = await tipJar({ cookbook: "tip-jar" });
    expect(kit.cookbook).toBe("tip-jar");
    const catalog = assembleCatalog([kit], file([hosted("tip-jar", "tip-jar-agent", "happy-path"), reference("read-me")]), { version: "0.0.0-test", commit: COMMIT });
    expect(catalog.recipes!.map((r) => [r.slug, r.status, r.kit, r.example])).toEqual([
      ["tip-jar", "hosted", "tip-jar-agent", "happy-path"],
      ["read-me", "reference", null, null],
    ]);
    expect(catalog.kits[0]!.cookbook).toBe("tip-jar");
    expect(HostedCatalogSchema.safeParse(JSON.parse(JSON.stringify(catalog))).success).toBe(true);
  });

  it("a kit with no cookbook says null, and a catalog built without a cookbooks file carries no recipes", async () => {
    const kit = await tipJar();
    expect(kit.cookbook).toBeNull();
    const catalog = await buildCatalog({ root: ROOT, commit: COMMIT, shared: SHARED, cookbooks: null }, [TEST_KIT], "0.0.0-test");
    expect(catalog.recipes).toBeUndefined();
  });

  it("refuses a hosted recipe whose kit or example does not exist", async () => {
    const kit = await tipJar();
    expect(() => buildRecipes(file([hosted("tip-jar", "no-such-agent", "happy-path")]), [kit])).toThrow(/hosted on no-such-agent, which is not a kit of this catalog/);
    expect(() => buildRecipes(file([hosted("tip-jar", "tip-jar-agent", "no-such-example")]), [kit])).toThrow(/runs example no-such-example, which tip-jar-agent does not have/);
  });

  it("refuses a slug listed twice", async () => {
    const kit = await tipJar();
    expect(() => buildRecipes(file([reference("read-me"), reference("read-me")]), [kit])).toThrow(/cookbook read-me is listed twice/);
  });

  it("refuses a kit whose cookbook the file does not list, or does not host on that kit", async () => {
    const kit = await tipJar({ cookbook: "tip-jar" });
    expect(() => buildRecipes(file([reference("read-me")]), [kit])).toThrow(/declares cookbook tip-jar, which cookbooks.yaml does not list/);
    expect(() => buildRecipes(file([reference("tip-jar")]), [kit])).toThrow(/declares cookbook tip-jar, which cookbooks.yaml does not host on tip-jar-agent/);
    // The schema holds the same rule, so a host reading the artifact refuses it too.
    const bad = { ...assembleCatalog([await tipJar()], file([reference("read-me")]), { version: "0.0.0-test", commit: COMMIT }) };
    bad.kits = bad.kits.map((k) => ({ ...k, cookbook: "tip-jar" }));
    expect(HostedCatalogSchema.safeParse(bad).success).toBe(false);
  });

  it("a recipe states its scope: partial says what it does not cover, local names its template and command, what is not hosted says why", () => {
    const parse = (extra: Record<string, unknown>) => RecipeSchema.safeParse({ ...recipesOf(file([hosted("tip-jar", "tip-jar-agent", "happy-path")]))[0], ...extra });
    expect(parse({}).success).toBe(true);
    expect(parse({ coverage: "partial" }).success).toBe(false);
    expect(parse({ coverage: "partial", notCovered: words("O split.", "The split.") }).success).toBe(true);
    expect(parse({ coverage: null }).success).toBe(false);
    expect(parse({ status: "local", kit: null, example: null, coverage: null, reason: words("Roda local.", "Runs locally.") }).success).toBe(false);
    expect(parse({ status: "local", kit: null, example: null, coverage: null, reason: words("Roda local.", "Runs locally."), template: "streaming-chat", command: templateCommand("@codespar/cli@0.22.8", "streaming-chat") }).success).toBe(true);
    expect(parse({ status: "reference", kit: null, example: null, coverage: null }).success).toBe(false);
    const local = recipesOf(file([{ slug: "chat", title: words("Chat", "Chat"), status: "local", template: "streaming-chat", expected: words("Responde.", "Answers."), reason: words("É um app.", "It is an app.") }]))[0]!;
    expect(local.command).toBe("npx @codespar/cli@0.22.8 init --template streaming-chat");
    expect(local.prerequisites).toEqual({ keys: [], mandate: null, connections: [] });
  });

  it("refuses a CLI that is not one exact version, and a key that is a value rather than a name", () => {
    expect(() => CookbooksFileSchema.parse({ ...file([reference("read-me")]), cli: "@codespar/cli@latest" })).toThrow(/exact version/);
    expect(() => recipesOf(file([hosted("tip-jar", "tip-jar-agent", "happy-path", { prerequisites: { keys: ["not-a-name"], connections: [] } })]))).toThrow();
  });

  it("carries an example's business inputs when the kit states them, and nothing when it does not", async () => {
    expect((await tipJar({ inputs: true })).examples[0]!.presentation!["pt-BR"].inputs).toEqual([{ label: "Valor", value: "R$ 10,00" }]);
    expect((await tipJar({})).examples[0]!.presentation!["pt-BR"]).not.toHaveProperty("inputs");
  });
});
