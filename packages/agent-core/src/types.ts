/**
 * Shared shapes of the core. Amounts are always integer minor units (BRL
 * cents). Timestamps are ISO 8601 strings so they survive SQLite and JSON
 * unchanged.
 */

export type ApprovalMode = "human" | "mandate";

/** Section 4.5: who acted. Every API call and every receipt carries one. */
export type Actor =
  | { type: "agent"; agent: string; on_behalf_of: string }
  | { type: "human"; id: string; channel: string };

/** One line of an execution: a payee and an amount, resolved by the core. */
export interface ExecutionItem {
  /** The alias the model used (`escola`), when it used one. */
  alias?: string;
  /** Display name from the mandate's named payees, when known. */
  beneficiary: string;
  /** The pinned payee key (a Pix key for `pix-key` mandates). */
  payee: string;
  amount: number;
  currency: string;
  description?: string;
}

/** The trigger of section 4.4 that sent a `mandate` execution to a human. */
export type EscalationTrigger = "amount" | "new_beneficiary" | "outside_hours";

/** Stable reasons a transition can carry. They are the readable-failure contract. */
export type ExecutionReason =
  | "mandate_revoked"
  | "mandate_paused"
  | "mandate_expired"
  | "mandate_status_unavailable"
  | "org_paused"
  | "beneficiary_not_allowed"
  | "per_tx_cap_exceeded"
  | "window_cap_exceeded"
  | "approval_expired"
  | "items_hash_mismatch"
  | "mandate_changed"
  | "denied_by_approver"
  | "rail_failed"
  | "rail_uncertain"
  | "tool_not_allowed"
  | "model_total_mismatch"
  | "outside_hours"
  | "escalated";

export interface MandateRef {
  id: string;
  version: number;
}

/** Section 4.2. */
export interface ApprovalArtifact {
  approval_id: string;
  execution_id: string;
  mode: ApprovalMode;
  approver:
    | { type: "person"; id: string; channel: string }
    | { type: "mandate"; id: string };
  approved_at: string;
  expires_at: string;
  mandate: MandateRef;
  items: ExecutionItem[];
  items_hash: string;
  /** Present when a section 4.4 trigger sent the execution to a human first. */
  escalation?: { trigger: EscalationTrigger; detail: string };
  actor: Actor;
  signature: { alg: "HMAC-SHA256"; key_id: string; value: string };
}

export interface ItemOutcome {
  index: number;
  attempt_id: string;
  status: "settled" | "failed";
  receipt_id?: string;
  transaction_id?: string;
  error?: string;
}
