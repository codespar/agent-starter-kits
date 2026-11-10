/**
 * Section 11: the proof bundle, one folder per run under `runs/<run-id>/`.
 * It answers "why could the agent pay this". It holds no key and no secret;
 * payee keys are masked the way a bank statement masks them.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalJson, itemsHash } from "./hash.js";
import type { Mandate } from "./mandate.js";
import { maskPayee, redactorFor } from "./masking.js";
import type { RailReceipt } from "./rail.js";
import type { ApprovalArtifact } from "./types.js";

export interface TranscriptLine {
  at: string;
  kind: "user" | "assistant_step" | "tool_call" | "tool_result" | "assistant" | "system";
  [key: string]: unknown;
}

/**
 * Where a bundle's files live. A directory on a terminal; a map a host
 * persists with the run when the run is hosted, so a hosted run writes no
 * file anywhere. Paths are relative to the bundle (`receipts/<id>.json`).
 */
export interface BundleFiles {
  append(path: string, text: string): void;
  write(path: string, text: string): void;
  read(path: string): string | undefined;
  /** The `.json` files directly under `dir`, sorted. */
  list(dir: string): string[];
}

class DirectoryFiles implements BundleFiles {
  constructor(private readonly root: string) {
    mkdirSync(join(root, "receipts"), { recursive: true });
  }
  append(path: string, text: string): void {
    appendFileSync(join(this.root, path), text);
  }
  write(path: string, text: string): void {
    writeFileSync(join(this.root, path), text);
  }
  read(path: string): string | undefined {
    const abs = join(this.root, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  }
  list(dir: string): string[] {
    const abs = join(this.root, dir);
    return existsSync(abs) ? readdirSorted(abs) : [];
  }
}

/** The bundle as a map from path to contents. `files` is the live map: a host saves it as it is. */
export class MemoryFiles implements BundleFiles {
  constructor(readonly files: Map<string, string> = new Map()) {}
  append(path: string, text: string): void {
    this.files.set(path, (this.files.get(path) ?? "") + text);
  }
  write(path: string, text: string): void {
    this.files.set(path, text);
  }
  read(path: string): string | undefined {
    return this.files.get(path);
  }
  list(dir: string): string[] {
    const prefix = `${dir}/`;
    return [...this.files.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/") && k.endsWith(".json"))
      .map((k) => k.slice(prefix.length))
      .sort();
  }
}

export class ProofBundle {
  readonly dir: string;
  private readonly files: BundleFiles;
  /** Every payee key this bundle has been handed, so a prose field that names one (an escalation detail) is masked too. */
  private readonly payees = new Set<string>();
  /** The redactor over `payees`, rebuilt only when a value brings a key it has not seen. */
  private redact = redactorFor([]);
  private redactFor = 0;

  constructor(
    runsDir: string,
    readonly runId: string,
    files?: BundleFiles,
  ) {
    this.dir = join(runsDir, runId);
    this.files = files ?? new DirectoryFiles(this.dir);
  }

  /** A bundle that writes no file: its contents are `files`, which the caller persists. `dir` is a label, never a path to open. */
  static inMemory(runId: string, files: MemoryFiles): ProofBundle {
    return new ProofBundle("memory:", runId, files);
  }

  /**
   * The mandate's payee keys, so prose naming one is masked. `mandateSnapshot`
   * learns them when a run starts; a run reopened in another process learns
   * them again here before it writes anything.
   */
  learnPayees(mandate: Mandate): void {
    for (const payee of [...mandate.beneficiaries.map((b) => b.payee), ...mandate.merchant_allowlist]) if (payee && payee !== "*") this.payees.add(payee);
  }

  static open(runsDir: string, runId: string): ProofBundle | undefined {
    return existsSync(join(runsDir, runId)) ? new ProofBundle(runsDir, runId) : undefined;
  }

  /**
   * Masked like an event, except the model's tool calls: `rerun` replays them byte for byte, and the mandate resolves a
   * beneficiary by its key too, so a masked input would draft another payment. A key a tool call names stays in it, in the
   * clear, and is the one exception to "no key in the clear" in a bundle. A step's `reply` is masked: `rerun` replays it as
   * the masked text, which ends the turn the same way and decides nothing.
   */
  transcript(line: TranscriptLine): void {
    this.files.append("transcript.jsonl", JSON.stringify(this.masked(line, REPLAYED_FIELDS)) + "\n");
  }

  readTranscript(): TranscriptLine[] {
    return (this.files.read("transcript.jsonl") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TranscriptLine);
  }

  /** Payee keys are masked on the way in (#116), in their fields and in any prose field that names one: the full key stays in state.db, which never travels. */
  event(event: Record<string, unknown>): void {
    this.files.append("events.jsonl", JSON.stringify(this.masked(event)) + "\n");
  }

  /**
   * `value` with every `payee` field masked, and inside the prose fields (`PROSE_FIELDS`, at any depth below one) every
   * payee key this bundle knows and every Pix-shaped key, known or not (`redactorFor`). Any other string, an id or a
   * hash, is left as it is even when a key is a substring of it. A field in `keep` is written verbatim, whatever it holds.
   */
  private masked<T>(value: T, keep: ReadonlySet<string> = new Set()): T {
    collectPayees(value, this.payees);
    if (this.payees.size !== this.redactFor) {
      this.redact = redactorFor(this.payees);
      this.redactFor = this.payees.size;
    }
    const redact = this.redact;
    const walk = (v: unknown, key: string | undefined, prose: boolean): unknown => {
      if (typeof v === "string") return key === "payee" ? maskPayee(v) : prose ? redact(v) : v;
      if (Array.isArray(v)) return v.map((x) => walk(x, key, prose));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keep.has(k) ? x : walk(x, k, prose || PROSE_FIELDS.has(k))]));
      return v;
    };
    return walk(value, undefined, false) as T;
  }

  /**
   * The conversation, when the run had one: every message in and out of a
   * channel, in order, with what the channel did with it. Separate from the
   * transcript, which is the MODEL's side, because on a channel the two are
   * not the same thing — a message the channel refused never reached the
   * person, and the QR and the copy-and-paste were sent by the runner.
   *
   * It carries no contact in the clear: the channel masks it before it gets
   * here, because the bundle travels. A payee key in a message is masked
   * here, like in an event.
   */
  channel(line: Record<string, unknown>): void {
    this.files.append("channel.jsonl", JSON.stringify(this.masked(line)) + "\n");
  }

  readChannel(): Record<string, unknown>[] {
    return (this.files.read("channel.jsonl") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  readEvents(): Record<string, unknown>[] {
    return (this.files.read("events.jsonl") ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /**
   * `approval.json` is the list of artifacts of this run, in approval order. Each is the artifact with its items' payees masked and
   * `payee_masked: true` (#116): `items_hash` and the signature are the original's, computed over the full items, so the copy's items
   * no longer hash to it. `items_hash_masked` is `itemsHash` over the masked items, so an edit to the copy's list that leaves its hash
   * behind is caught; it is unkeyed and binds nothing to the seal. The full artifact is in state.db, where the engine reads it.
   */
  approval(artifact: ApprovalArtifact): void {
    const stored = this.files.read("approval.json");
    const current: ApprovalArtifact[] = stored !== undefined ? (JSON.parse(stored) as ApprovalArtifact[]) : [];
    if (!current.some((a) => a.approval_id === artifact.approval_id)) {
      const copy = this.masked(artifact);
      current.push({ ...copy, payee_masked: true, items_hash_masked: itemsHash(copy.items) });
    }
    this.files.write("approval.json", JSON.stringify(current, null, 2) + "\n");
  }

  readApprovals(): ApprovalArtifact[] {
    const stored = this.files.read("approval.json");
    return stored !== undefined ? (JSON.parse(stored) as ApprovalArtifact[]) : [];
  }

  mandateSnapshot(mandate: Mandate): void {
    this.learnPayees(mandate);
    const { signature: _signature, canonical: _canonical, ...safe } = mandate;
    this.files.write("mandate.snapshot.json", JSON.stringify({ ...safe, beneficiaries: safe.beneficiaries.map((b) => ({ ...b, payee: maskPayee(b.payee) })), merchant_allowlist: safe.merchant_allowlist.map(maskPayee) }, null, 2) + "\n");
  }

  /**
   * Returns the path INSIDE the bundle (`receipts/<id>.json`): a bundle travels, and an absolute path names the machine that wrote it.
   *
   * `approval_id` names the artifact in `approval.json` whose hashes the spend carried, so `npm run verify` holds the receipt's sealed
   * approval link against THAT artifact, found by identity and never by looking for one whose hash happens to match. The copy stays
   * masked: binding its body to the chain needs the unmasked read, which `verify --from-api` takes from the API and writes nowhere.
   */
  receipt(receipt: RailReceipt, context: { approval_id?: string | undefined } = {}): string {
    const relative = join("receipts", `${receipt.receipt_id}.json`);
    const { raw: _raw, ...safe } = receipt;
    const copy = { ...safe, payment: { ...safe.payment, payee: safe.payment.payee ? maskPayee(safe.payment.payee) : null }, ...(context.approval_id ? { approval_id: context.approval_id } : {}) };
    this.files.write(relative.split("\\").join("/"), JSON.stringify(copy, null, 2) + "\n");
    return relative;
  }

  /** The masked mandate as it stood when the run started. Absent on a bundle whose run never got that far. */
  readMandateSnapshot(): Record<string, unknown> | undefined {
    const stored = this.files.read("mandate.snapshot.json");
    return stored !== undefined ? (JSON.parse(stored) as Record<string, unknown>) : undefined;
  }

  /** One receipt by its file name, as `listReceipts()` returns it. */
  readReceipt(file: string): Record<string, unknown> | undefined {
    const stored = this.files.read(`receipts/${basename(file)}`);
    return stored !== undefined ? (JSON.parse(stored) as Record<string, unknown>) : undefined;
  }

  /**
   * Section 11: `verify.json` is the output of `codespar audit replay`, which
   * is not a registered command of the CLI, so nothing here writes it and
   * nothing here reimplements the hash-chain check. The reader exists so a
   * bundle that gains one later is noticed rather than ignored.
   */
  hasVerify(): boolean {
    return this.files.read("verify.json") !== undefined;
  }

  listReceipts(): string[] {
    return this.files.list("receipts");
  }

  meta(meta: Record<string, unknown>): void {
    this.files.write("run.json", JSON.stringify(meta, null, 2) + "\n");
  }

  readMeta(): Record<string, unknown> | undefined {
    const stored = this.files.read("run.json");
    return stored !== undefined ? (JSON.parse(stored) as Record<string, unknown>) : undefined;
  }
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

/**
 * Where the bundle's masked copy of a receipt says something the API's read of the same receipt does not. The copy is not what the
 * signature covers, so a copy edited after the fact still verifies at the signature level; this is what catches it once the read is
 * in hand. The payee is compared masked, the only form the copy holds. An empty list means the copy is a faithful mask of the read.
 */
export function copyDisagreesWithRead(copy: Record<string, unknown>, read: Record<string, unknown>): string[] {
  const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
  const readPayee = field(read["quote"], "payee");
  const expected: Array<[string, unknown, unknown]> = [
    ["receipt_id", copy["receipt_id"], read["receipt_id"]],
    ["chain", copy["chain"], read["chain"]],
    ["mandate.id", field(copy["mandate"], "id"), field(read["mandate"], "id")],
    ["payment.amount_minor", field(copy["payment"], "amount_minor"), field(read["payment"], "amount_minor")],
    ["payment.attempt_id", field(copy["payment"], "attempt_id"), field(read["payment"], "attempt_id")],
    ["payment.money_moved", field(copy["payment"], "money_moved"), field(read["payment"], "money_moved")],
    ["payment.at", field(copy["payment"], "at"), field(read["payment"], "at")],
    ["payment.payee", field(copy["payment"], "payee"), typeof readPayee === "string" ? maskPayee(readPayee) : null],
  ];
  // Written onto the copy since the rail reads them through the SDK's types (0.16.10); a copy from before carries neither, and is not faulted for it.
  if ("chain_version" in copy) expected.push(["chain_version", copy["chain_version"], read["chain_version"]]);
  if ("approval" in copy) expected.push(["approval", canonicalJson(copy["approval"] ?? null), canonicalJson(read["approval"] ?? null)]);
  // Written onto the copy since every spend carries the actor (§2); the read calls it `actor`, the copy `sealed_actor` beside its own stamp.
  if ("sealed_actor" in copy) expected.push(["sealed_actor", canonicalJson(copy["sealed_actor"] ?? null), canonicalJson(read["actor"] ?? null)]);
  return expected.filter(([, a, b]) => a !== b).map(([name]) => name);
}

/** The fields whose text can name a payee: an escalation or transition detail, a rail's message, an outcome's error, a turn of the conversation, a tool's result. */
const PROSE_FIELDS: ReadonlySet<string> = new Set(["detail", "message", "error", "text", "reply", "content"]);

/** What a rerun replays from the transcript, verbatim: the tool calls. A step's `reply` is not among them (see `transcript`). */
const REPLAYED_FIELDS: ReadonlySet<string> = new Set(["tool_calls", "input"]);

/** Adds every string under a `payee` key, at any depth, to `into`. */
function collectPayees(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) for (const v of value) collectPayees(v, into);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "payee" && typeof v === "string" && v.length > 0 && v !== "*" && !v.includes("***")) into.add(v);
      else collectPayees(v, into);
    }
  }
}

export { maskPayee } from "./masking.js";
