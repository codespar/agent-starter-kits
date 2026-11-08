/**
 * What a read-only kit may read of the platform on `codespar-test`
 * (CONTRATO.md v1.5): the Test project's own account, its spending mandates'
 * limits and its latest payment proposals. The host answers from the records
 * it already serves (the Wallet, the mandates, the proposals); the kit gets
 * no client and no key, and nothing here can move money or change a record.
 *
 * Every payee leaves the host masked. A kit that reads through this port
 * needs no spending mandate: reading is not spending.
 */

export interface PlatformBalance {
  environment: "test";
  asOf: string;
  /** Whether the project has its own bound account in Test. `false` with no currencies is "no account yet", never a zero balance. */
  accountExists: boolean;
  currencies: Array<{ currency: string; balanceMinor: number; availableMinor: number; heldMinor: number }>;
}

export interface PlatformMandate {
  id: string;
  status: string;
  currency: string;
  perTxCapMinor: number;
  capMinor: number;
  periodicCap: { window: string; capMinor: number } | null;
  expiresAt: string;
}

export interface PlatformProposal {
  id: string;
  state: string;
  amountMinor: number;
  currency: string;
  payeeMasked: string;
  createdAt: string;
  receiptId: string | null;
}

/** The host's read port. Absent everywhere but a hosted `codespar-test` run of a kit that declares it reads the platform. */
export interface PlatformReads {
  balance(): Promise<PlatformBalance>;
  mandates(): Promise<PlatformMandate[]>;
  /** Newest first, at most `limit` (the host may cap it lower). */
  proposals(limit: number): Promise<PlatformProposal[]>;
}
