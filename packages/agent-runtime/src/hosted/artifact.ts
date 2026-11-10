/**
 * The pinned artifact as a host reads it (CONTRATO.md section 7): the catalog
 * the build wrote, every kit's digest recomputed from the files installed, and
 * a kit's module imported from the path the catalog names, never from one a
 * request names.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent } from "../agent.js";
import { treeDigest } from "./catalog.js";
import { HostedCatalogSchema, type HostedCatalog } from "./contract.js";
import { HostedRefusal, type HostedKit } from "./run.js";

/** The runtime trees inside the artifact that every kit's digest covers. */
export const ARTIFACT_SHARED = ["node_modules/@codespar/agent-core", "node_modules/@codespar/agent-runtime"] as const;

/** A kit's digest as it lies in the artifact rooted at `root`. */
export function artifactDigest(root: string, id: string): string {
  return treeDigest(root, [`kits/${id}`, ...ARTIFACT_SHARED]);
}

/** What a host's tests replace: where the catalog text comes from, and how a kit's installed digest is computed. */
export interface CatalogReader {
  readCatalog?: () => string;
  digestOf?: (id: string) => string;
}

/** The catalog of the artifact at `root`, refused whole when any kit's files are not the ones the build hashed. */
export function loadHostedCatalog(root: string, reader: CatalogReader = {}): HostedCatalog {
  const catalog = HostedCatalogSchema.parse(JSON.parse(reader.readCatalog ? reader.readCatalog() : readFileSync(join(root, "catalog.json"), "utf8")));
  for (const kit of catalog.kits) {
    const found = reader.digestOf ? reader.digestOf(kit.id) : artifactDigest(root, kit.id);
    if (found !== kit.source.packageDigest) throw new HostedRefusal("digest_mismatch", `${kit.id}: the catalog says ${kit.source.packageDigest}, the installed files are ${found}`);
  }
  return catalog;
}

/** One kit of a verified catalog, by id and the digest a run was created with. */
export async function openHostedKit(root: string, catalog: HostedCatalog, id: string, packageDigest: string): Promise<HostedKit> {
  const descriptor = catalog.kits.find((k) => k.id === id);
  if (!descriptor) throw new HostedRefusal("run_unknown", `no kit ${id} in this artifact`);
  if (descriptor.source.packageDigest !== packageDigest) throw new HostedRefusal("digest_mismatch", `${id} is ${descriptor.source.packageDigest} here, not ${packageDigest}`);
  const module = (await import(pathToFileURL(join(root, descriptor.entrypoint)).href)) as { agent?: Agent };
  if (!module.agent) throw new HostedRefusal("invalid_command", `${descriptor.entrypoint} exports no agent`);
  return { agent: module.agent, descriptor };
}
