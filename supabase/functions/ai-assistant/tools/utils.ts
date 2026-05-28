const INCOME_CATEGORIES = new Set(["svc", "ret", "own"]);
const EXPENSE_CATEGORIES = new Set(["lab", "sw", "ads", "oth"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIncomeCategory(cat: string | null | undefined): boolean {
  return INCOME_CATEGORIES.has(String(cat || "").trim());
}

export function isExpenseCategory(cat: string | null | undefined): boolean {
  return EXPENSE_CATEGORIES.has(String(cat || "").trim());
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function optionalString(value: unknown, maxLen = 500): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  if (!s) return undefined;
  return s.slice(0, maxLen);
}

export function parseIsoDate(value: unknown): string | null {
  const s = optionalString(value, 32);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Resolve period presets to { from, to } ISO strings in the given IANA timezone. */
export function resolvePeriod(
  period: unknown,
  _tz: string,
): { from: string; to: string; label: string } {
  const now = new Date();

  if (period && typeof period === "object" && !Array.isArray(period)) {
    const rec = period as Record<string, unknown>;
    const from = parseIsoDate(rec.from);
    const to = parseIsoDate(rec.to);
    if (from && to) {
      return { from, to, label: "custom range" };
    }
  }

  const p = typeof period === "string" ? period.trim().toLowerCase() : "";

  if (p === "custom" && period && typeof period === "object") {
    const rec = period as Record<string, unknown>;
    const from = parseIsoDate(rec.from);
    const to = parseIsoDate(rec.to);
    if (from && to) return { from, to, label: "custom range" };
  }

  if (p === "last_month") {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth();
    const start = new Date(Date.UTC(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
    return { from: start.toISOString(), to: end.toISOString(), label: "last month" };
  }

  if (p === "qtd") {
    const y = now.getUTCFullYear();
    const qStartMonth = Math.floor(now.getUTCMonth() / 3) * 3;
    const start = new Date(Date.UTC(y, qStartMonth, 1));
    return { from: start.toISOString(), to: now.toISOString(), label: "quarter to date" };
  }

  if (p === "ytd") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    return { from: start.toISOString(), to: now.toISOString(), label: "year to date" };
  }

  if (p === "mtd" || p === "this_month") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from: start.toISOString(), to: now.toISOString(), label: "this month" };
  }

  // default: this month
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from: start.toISOString(), to: now.toISOString(), label: "this month" };
}

export function dateOnlyFromIso(iso: string): string {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso.slice(0, 10);
  }
}

export function startOfLocalDayIso(dateYmd: string, tz: string): string {
  // Approximate: use UTC midnight on that calendar day (tools use date column anyway)
  return `${dateYmd}T00:00:00.000Z`;
}

export function endOfLocalDayIso(dateYmd: string): string {
  return `${dateYmd}T23:59:59.999Z`;
}

export function todayRangeUtc(): { from: string; to: string } {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10);
  return { from: startOfLocalDayIso(ymd, "UTC"), to: endOfLocalDayIso(ymd) };
}

export function weekRangeUtc(): { from: string; to: string } {
  const now = new Date();
  const day = now.getUTCDay();
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function tomorrowRangeUtc(): { from: string; to: string } {
  const now = new Date();
  const t = new Date(now);
  t.setUTCDate(t.getUTCDate() + 1);
  const ymd = t.toISOString().slice(0, 10);
  return { from: startOfLocalDayIso(ymd, "UTC"), to: endOfLocalDayIso(ymd) };
}

export function matchOwnerToMe(
  ownerText: string,
  ctx: { userId: string; userDisplayName: string; userEmail: string },
): boolean {
  const owner = ownerText.trim().toLowerCase();
  if (!owner) return false;
  const email = ctx.userEmail.toLowerCase();
  const username = email.includes("@") ? email.split("@")[0] : email;
  const display = ctx.userDisplayName.trim().toLowerCase();
  const parts = display.split(/\s+/).filter(Boolean);
  if (owner === display) return true;
  if (username && owner.includes(username)) return true;
  for (const part of parts) {
    if (part.length >= 2 && owner.includes(part)) return true;
  }
  return false;
}
