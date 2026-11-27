/**
 * The commands a hosted run's export hands a person (CONTRATO §8, `code.commands`):
 * the same kit, at the commit the run used, on their machine.
 *
 * WHY THE WHOLE REPOSITORY. A kit is an npm workspace: its package.json depends
 * on `@codespar/agent-core` and `@codespar/agent-runtime`, which live in
 * `packages/` of this repository and are not published to npm. A copy of the
 * kit's folder alone (`degit .../agents/<kit>`) cannot install: npm looks the
 * two packages up on the registry and answers E404. The commands therefore copy
 * the repository at the run's commit, install at its root (where the
 * workspaces resolve), and start the kit by its workspace. Nothing is
 * published for this, and the kit's README, which already says to install at
 * the root, is the one that comes with the copy.
 */
import type { ExecutorId, HostedKitDescriptor, ModelMode } from "./contract.js";

/** The directory the copy lands in: the repository's own name. */
export const EXPORT_DIR = "agent-starter-kits";

export interface ExportBinding {
  modelMode: ModelMode;
  executor: ExecutorId;
  approvalMode: "human" | "mandate";
  locale: "pt-BR" | "en";
  exampleId: string | null;
}

export function exportCommands(d: Pick<HostedKitDescriptor, "id" | "source">, b: ExportBinding): string[] {
  const workspace = `--workspace=agents/${d.id}`;
  const flags = `--mode ${b.approvalMode} --locale ${b.locale}`;
  return [
    `npx degit ${d.source.repository}#${d.source.commit} ${EXPORT_DIR}`,
    `cd ${EXPORT_DIR} && npm install`,
    b.modelMode === "replay" && b.exampleId ? `npm start ${workspace} -- --scenario ${b.exampleId} ${flags}` : `npm start ${workspace} -- ${flags}`,
  ];
}
