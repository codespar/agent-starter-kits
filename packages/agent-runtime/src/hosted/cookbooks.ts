/**
 * The docs cookbooks as the catalog offers them (CONTRATO v1.8): `cookbooks.yaml` at the repository root, one entry per
 * page of the docs site's `content/docs/cookbooks/`. The kits repository is the one source for what runs where: a recipe
 * is `hosted` (a kit and one of its examples run it in the Playground), `local` (a CLI template runs it on the person's
 * machine) or `reference` (a page to read), and a recipe that is not hosted says why.
 *
 * The file is read at build time only. Nothing here is typed by a person at run time, and a recipe never carries a key,
 * a document or a credential: `prerequisites.keys` are variable NAMES.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { COOKBOOK_SLUG, RecipeSchema, recipeProblems, type HostedKitDescriptor, type Recipe } from "./contract.js";

export const COOKBOOKS_FILE = "cookbooks.yaml";

const PINNED_CLI = /^@codespar\/cli@\d+\.\d+\.\d+$/;
const Words = z.object({ "pt-BR": z.string().min(1), en: z.string().min(1) }).strict();

const EntrySchema = z
  .object({
    slug: z.string().regex(COOKBOOK_SLUG),
    title: Words,
    status: z.enum(["hosted", "local", "reference"]),
    kit: z.string().optional(),
    example: z.string().optional(),
    coverage: z.enum(["full", "partial"]).optional(),
    not_covered: Words.optional(),
    template: z.string().optional(),
    inputs: z.array(z.object({ name: z.string(), "pt-BR": z.string(), en: z.string() }).strict()).default([]),
    prerequisites: z
      .object({ keys: z.array(z.string()).default([]), mandate: Words.optional(), connections: z.array(z.string()).default([]) })
      .strict()
      .default({}),
    expected: Words,
    reason: Words.optional(),
  })
  .strict();

export const CookbooksFileSchema = z
  .object({
    v: z.literal(1),
    /** Where the slugs were read: the docs site's repository, commit and directory. The docs build guards the other direction. */
    docs: z.object({ repository: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/), path: z.string().min(1) }).strict(),
    /** The published CLI a `local` recipe's command runs, one exact version. */
    cli: z.string().regex(PINNED_CLI, "cli must pin an exact version, e.g. @codespar/cli@0.22.8"),
    cookbooks: z.array(EntrySchema).min(1),
  })
  .strict();

export type CookbooksFile = z.infer<typeof CookbooksFileSchema>;

/** The command that exports a local recipe: the pinned CLI's `init` with the recipe's template. */
export function templateCommand(cli: string, template: string): string {
  return `npx ${cli} init --template ${template}`;
}

/** The recipes of a parsed `cookbooks.yaml`, in the file's order, each validated by the contract. */
export function recipesOf(file: CookbooksFile): Recipe[] {
  return file.cookbooks.map((e) =>
    RecipeSchema.parse({
      slug: e.slug,
      title: e.title,
      status: e.status,
      kit: e.kit ?? null,
      example: e.example ?? null,
      coverage: e.coverage ?? null,
      notCovered: e.not_covered ?? null,
      template: e.template ?? null,
      command: e.template ? templateCommand(file.cli, e.template) : null,
      inputs: e.inputs,
      prerequisites: { keys: e.prerequisites.keys, mandate: e.prerequisites.mandate ?? null, connections: e.prerequisites.connections },
      expected: e.expected,
      reason: e.reason ?? null,
    }),
  );
}

/** `cookbooks.yaml` under `root`, parsed and validated. Throws with the entry that is wrong. */
export function loadCookbooks(root: string): CookbooksFile {
  const raw: unknown = parseYaml(readFileSync(join(root, COOKBOOKS_FILE), "utf8"));
  const parsed = CookbooksFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${COOKBOOKS_FILE}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return parsed.data;
}

/**
 * The catalog's `recipes` for these kits. Refused, with every problem named, when a slug repeats, a hosted recipe names
 * a kit or an example that does not exist, or a kit declares a cookbook the file does not host on it.
 */
export function buildRecipes(file: CookbooksFile, kits: ReadonlyArray<Pick<HostedKitDescriptor, "id" | "exampleIds" | "cookbook">>): Recipe[] {
  const recipes = recipesOf(file);
  const problems = recipeProblems(recipes, kits);
  if (problems.length > 0) throw new Error(`${COOKBOOKS_FILE}: ${problems.join("; ")}`);
  return recipes;
}
