/** Mirrors pfm-tee-kit/pfm/taxonomy.py (version 1). A set change is a new taxonomy version. */
export const TAXONOMY_VERSION = "1";
export const TAXONOMY_URN = `urn:sahamati:pfm-taxonomy:${TAXONOMY_VERSION}`;
/** Same order as the kit's CATEGORIES dict. */
export const CATEGORY_IDS = [
  "grocery", "food", "transport", "shopping", "utilities", "rent", "emi", "investment", "insurance", "health",
  "education", "entertainment", "cash", "fees", "transfer", "salary", "interest", "refund", "other",
] as const;
export const UNCLASSIFIED = "unclassified";
