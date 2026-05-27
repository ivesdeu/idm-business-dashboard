/**
 * Map Plaid Personal Finance Category (PFC) primary codes to our ledger category codes.
 *
 * Ledger categories in this app (legacy financial-core):
 * - Income: svc, ret, own
 * - Expense: lab, sw, ads, oth
 */

export type LedgerCategory = "svc" | "ret" | "own" | "lab" | "sw" | "ads" | "oth";

export function isInflow(amount: number): boolean {
  // Plaid amounts are positive numbers for outflows (spend) and can be negative for inflows depending on institution.
  // We treat <=0 as inflow to be conservative for sandbox fixtures.
  return amount <= 0;
}

export function mapPlaidPfcPrimaryToLedgerCategory(
  primary: string | null | undefined,
  amount: number,
): LedgerCategory {
  if (isInflow(amount)) return "svc";
  const p = String(primary || "").trim().toUpperCase();
  if (!p) return "oth";

  // Very coarse mapping for v1. Tune as we observe real data.
  switch (p) {
    case "INCOME":
      return "svc";
    case "RENT_AND_UTILITIES":
    case "LOAN_PAYMENTS":
    case "TAXES":
    case "TRANSFER_OUT":
    case "GENERAL_MERCHANDISE":
    case "GENERAL_SERVICES":
    case "TRAVEL":
    case "FOOD_AND_DRINK":
    case "ENTERTAINMENT":
    case "GOVERNMENT_AND_NON_PROFIT":
    case "PERSONAL_CARE":
    case "HOME_IMPROVEMENT":
    case "MEDICAL":
    case "EDUCATION":
    case "UNCATEGORIZED":
      return "oth";
    case "PAYROLL":
    case "PROFESSIONAL_SERVICES":
      return "lab";
    case "SOFTWARE":
    case "DIGITAL":
      return "sw";
    case "ADVERTISING":
      return "ads";
    default:
      return "oth";
  }
}

