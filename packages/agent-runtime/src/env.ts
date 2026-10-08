/**
 * Two names for the same two settings. The kit reads `CODESPAR_API_URL` and
 * `CODESPAR_PROJECT_ID`; the CodeSpar CLI (`@codespar/cli`) reads
 * `CODESPAR_BASE_URL` and `CODESPAR_PROJECT`. A shell prepared for one of them
 * left the other on its default, production, with nothing said: a staging key
 * then meets the wrong deployment.
 *
 * The kit takes the CLI's names as aliases of its own, and refuses to start
 * when both are set and disagree. It runs once, after the `.env` is read, so
 * every later reader of `CODESPAR_API_URL` / `CODESPAR_PROJECT_ID` sees the
 * reconciled value.
 */
const PAIRS: ReadonlyArray<{ kit: string; cli: string; same: (a: string, b: string) => boolean }> = [
  { kit: "CODESPAR_API_URL", cli: "CODESPAR_BASE_URL", same: (a, b) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "") },
  { kit: "CODESPAR_PROJECT_ID", cli: "CODESPAR_PROJECT", same: (a, b) => a === b },
];

export class EnvNamesDisagreeError extends Error {
  constructor(kit: string, kitValue: string, cli: string, cliValue: string) {
    super(`${kit}=${kitValue} and ${cli}=${cliValue} disagree. The kit reads ${kit} and the CodeSpar CLI reads ${cli}; they must name the same thing. Set one of them, or both to the same value.`);
    this.name = "EnvNamesDisagreeError";
  }
}

/** An empty value counts as unset, as it does in the CLI. */
export function reconcileEnvNames(env: NodeJS.ProcessEnv = process.env): void {
  for (const { kit, cli, same } of PAIRS) {
    const kitValue = env[kit]?.trim() || undefined;
    const cliValue = env[cli]?.trim() || undefined;
    if (kitValue && cliValue && !same(kitValue, cliValue)) throw new EnvNamesDisagreeError(kit, kitValue, cli, cliValue);
    if (!kitValue && cliValue) env[kit] = cliValue;
  }
}
