import type { ToolContext } from "../context.ts";
import { isUuid, optionalString } from "../utils.ts";

export type AdvisorProposal = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  summary_human: string;
  summary_voice: string;
};

export type CompoundStep = {
  id: string;
  type: string;
  label: string;
  payload: Record<string, unknown>;
  optional?: boolean;
};

export type CompoundProposal = AdvisorProposal & {
  type: `compound.${string}`;
  payload: { steps: CompoundStep[] };
};

export function isCompoundProposalType(type: string): boolean {
  return String(type || "").startsWith("compound.");
}

export function makeCompoundProposal(
  kind: string,
  steps: CompoundStep[],
  summaryHuman: string,
  summaryVoice?: string,
): { proposal: CompoundProposal } {
  const voice = (summaryVoice || summaryHuman).slice(0, 500);
  return {
    proposal: {
      id: newProposalId(),
      type: `compound.${kind}` as `compound.${string}`,
      payload: { steps },
      summary_human: summaryHuman,
      summary_voice: voice,
    },
  };
}

/** Step output bag keyed by step id for cross-step refs. */
export type StepOutputBag = Record<string, Record<string, unknown>>;

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".").filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Resolve `{ ref: "step.<stepId>.<path>" }` placeholders using prior step outputs.
 */
export function resolveStepRefs(
  value: unknown,
  outputs: StepOutputBag,
): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => resolveStepRefs(v, outputs));
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.ref === "string" && rec.ref.startsWith("step.")) {
      const parts = rec.ref.slice("step.".length).split(".");
      const stepId = parts.shift();
      if (!stepId) return undefined;
      const bag = outputs[stepId];
      if (!bag) return undefined;
      const path = parts.join(".");
      return path ? getPath(bag, path) : bag;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) {
      out[k] = resolveStepRefs(v, outputs);
    }
    return out;
  }
  return value;
}

export function newProposalId(): string {
  return crypto.randomUUID();
}

export function makeProposal(
  type: string,
  payload: Record<string, unknown>,
  summaryHuman: string,
  summaryVoice?: string,
): { proposal: AdvisorProposal } {
  const voice = (summaryVoice || summaryHuman).slice(0, 500);
  return {
    proposal: {
      id: newProposalId(),
      type,
      payload,
      summary_human: summaryHuman,
      summary_voice: voice,
    },
  };
}

export async function resolveClientByName(
  ctx: ToolContext,
  name: string,
): Promise<
  | { client: { id: string; company_name: string; contact_name: string }; error?: undefined }
  | { client?: undefined; error: string; candidates?: Array<{ id: string; company_name: string; contact_name: string }> }
> {
  const q = name.trim();
  if (!q) return { error: "Client name is required." };

  const { data, error } = await ctx.supabase
    .from("clients")
    .select("id, company_name, contact_name")
    .eq("organization_id", ctx.orgId)
    .or(`company_name.ilike.%${q}%,contact_name.ilike.%${q}%`)
    .limit(6);

  if (error) return { error: error.message };
  const rows = (data || []) as Array<{ id: string; company_name: string | null; contact_name: string | null }>;
  if (!rows.length) return { error: `No client matched "${q}".` };
  if (rows.length === 1) {
    return {
      client: {
        id: rows[0].id,
        company_name: String(rows[0].company_name || ""),
        contact_name: String(rows[0].contact_name || ""),
      },
    };
  }
  const exact = rows.filter(
    (r) =>
      String(r.company_name || "").toLowerCase() === q.toLowerCase() ||
      String(r.contact_name || "").toLowerCase() === q.toLowerCase(),
  );
  if (exact.length === 1) {
    return {
      client: {
        id: exact[0].id,
        company_name: String(exact[0].company_name || ""),
        contact_name: String(exact[0].contact_name || ""),
      },
    };
  }
  return {
    error: `Multiple clients match "${q}". Pick one or be more specific.`,
    candidates: rows.slice(0, 5).map((r) => ({
      id: r.id,
      company_name: String(r.company_name || ""),
      contact_name: String(r.contact_name || ""),
    })),
  };
}

export async function resolveClientId(
  ctx: ToolContext,
  clientName?: string,
  clientId?: string,
): Promise<{ clientId: string | null; error?: string; candidates?: unknown }> {
  if (clientId && isUuid(clientId)) return { clientId };
  if (ctx.lastEntities?.clientId && isUuid(ctx.lastEntities.clientId) && !clientName) {
    return { clientId: ctx.lastEntities.clientId };
  }
  if (!clientName) return { clientId: null };
  const r = await resolveClientByName(ctx, clientName);
  if (r.error) return { clientId: null, error: r.error, candidates: r.candidates };
  return { clientId: r.client!.id };
}

const APPOINTMENT_COLORS = new Set([
  "blue",
  "green",
  "red",
  "amber",
  "purple",
  "rose",
  "slate",
  "teal",
  "pink",
]);

export function parseAppointmentColor(value: unknown): string | null {
  const s = optionalString(value, 16)?.toLowerCase();
  if (!s) return null;
  return APPOINTMENT_COLORS.has(s) ? s : null;
}

export function mapExpenseCategoryLabel(raw: string): { code: string; label: string } {
  const v = raw.trim().toLowerCase();
  if (!v) return { code: "oth", label: "Other" };
  if (v.match(/labor|payroll|team|staff/)) return { code: "lab", label: raw.trim() || "Labor" };
  if (v.match(/soft|saas|tool/)) return { code: "sw", label: raw.trim() || "Software" };
  if (v.match(/ad|advertis|marketing|promo/)) return { code: "ads", label: raw.trim() || "Advertising" };
  if (v.match(/meal|food|restaurant|coffee|starbucks|dining/)) return { code: "oth", label: raw.trim() || "Meals" };
  if (v === "lab" || v === "sw" || v === "ads" || v === "oth" || v === "svc" || v === "ret" || v === "own") {
    return { code: v, label: raw.trim() || v };
  }
  return { code: "oth", label: raw.trim() || "Other" };
}

export function displayClientName(c: { company_name?: string | null; contact_name?: string | null }): string {
  return (
    String(c.company_name || "").trim() ||
    String(c.contact_name || "").trim() ||
    "Unknown client"
  );
}
