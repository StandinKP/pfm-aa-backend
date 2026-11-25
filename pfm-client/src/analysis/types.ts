/**
 * Shared shapes for on-device analysis. The ledger is what the device keeps; the
 * enclave only ever sends labels + minimal rows for NEW transactions (delta).
 * Synthetic data only.
 */

/** One transaction as the device stores it: the enclave's row plus its label. */
export interface LedgerTxn {
  txnId: string;
  /** ISO date YYYY-MM-DD */
  date: string;
  /** Signed: debit < 0, credit > 0 (same convention as the kit's records). */
  amount: number;
  /** "debit" | "credit" (kit `type`). */
  type: string;
  /** Rail, upper-case (UPI, ATM, ...). */
  mode: string;
  /** Already normalised by the enclave (upper-cased, digits -> #). Treated as untrusted text. */
  narration: string;
  accountLabel: string;
  category: string;
  /** Calibrated probability of `category`. */
  p: number;
  essential: boolean;
  /** Running account balance after this txn (kit `balance`), when the enclave sends it. Feeds cashflow signals. */
  balance?: number;
  /** ISO timestamp (kit `timestamp`); tie-breaks "latest balance" within a day. */
  timestamp?: string;
  /** Decision-cache key (16 hex of sha256 over `type|MODE|narration`) as stamped by the enclave. Additive. */
  k?: string;
}

/** A cached model decision, keyed by sha256 of "type|mode|normalisedNarration". */
export interface CachedDecision {
  category: string;
  p: number;
  essential: boolean;
  taxonomyVersion: string;
}

export interface DeriveOptions {
  /** YYYY-MM-DD reference date; defaults to the latest transaction date (as the kit does). */
  asOf?: string;
  budgets?: Record<string, number>;
  /** Cap per category list (kit PFM_LIST_MAX default 50). */
  listMax?: number;
}
