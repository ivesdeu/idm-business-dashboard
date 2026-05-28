import type { AdvisorToolModule, ToolContext } from "../context.ts";
import { makeProposal, newProposalId, resolveClientByName } from "./shared.ts";
import { isUuid, optionalString } from "../utils.ts";

const CRM_STATUSES = ["Lead", "Active", "At risk", "Inactive", "Churned"];

function normalizeStatus(raw: unknown): string | null {
  const s = optionalString(raw, 64);
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const st of CRM_STATUSES) {
    if (st.toLowerCase() === lower) return st;
  }
  if (lower === "at-risk" || lower === "at_risk") return "At risk";
  return s;
}

export const proposeClientUpdateTool: AdvisorToolModule = {
  name: "propose_client_update",
  definition: {
    name: "propose_client_update",
    description: "Propose updating a CRM client (status, priority, contact fields). Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        client_id: { type: "string" },
        status: { type: "string", description: "Lead, Active, At risk, Inactive, Churned" },
        priority: { type: "string", description: "e.g. high, medium, low" },
        contact_name: { type: "string" },
        company_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
      },
    },
  },
  async execute(input, ctx) {
    let clientId = optionalString(input.client_id, 64);
    let displayName = "";
    if (!clientId || !isUuid(clientId)) {
      if (ctx.lastEntities?.clientId && isUuid(ctx.lastEntities.clientId) && !input.client_name) {
        clientId = ctx.lastEntities.clientId;
      } else {
        const name = optionalString(input.client_name, 120);
        if (!name) return { error: "client_name or client_id is required." };
        const r = await resolveClientByName(ctx, name);
        if (r.error) return { error: r.error, candidates: r.candidates };
        clientId = r.client!.id;
        displayName = r.client!.company_name || r.client!.contact_name;
      }
    }

    const patch: Record<string, unknown> = { client_id: clientId };
    const status = normalizeStatus(input.status);
    if (status) patch.status = status;
    const priority = optionalString(input.priority, 32);
    if (priority) patch.priority = priority;
    const contactName = optionalString(input.contact_name, 200);
    if (contactName) patch.contact_name = contactName;
    const companyName = optionalString(input.company_name, 200);
    if (companyName) patch.company_name = companyName;
    const email = optionalString(input.email, 200);
    if (email) patch.email = email;
    const phone = optionalString(input.phone, 64);
    if (phone) patch.phone = phone;

    if (Object.keys(patch).length <= 1) return { error: "No fields to update." };

    const bits: string[] = [];
    if (patch.status) bits.push(`status → ${patch.status}`);
    if (patch.priority) bits.push(`priority → ${patch.priority}`);
    const label = displayName || optionalString(input.client_name, 120) || clientId!.slice(0, 8);
    const human = `Update client **${label}**: ${bits.join(", ")}?`;
    const voice = `Update ${label}. ${bits.join(". ")}. Say yes to confirm.`;
    return makeProposal("client.update", patch, human, voice);
  },
};

export const proposeClientCreateTool: AdvisorToolModule = {
  name: "propose_client_create",
  definition: {
    name: "propose_client_create",
    description: "Propose adding a new CRM client/contact. Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        contact_name: { type: "string" },
        status: { type: "string" },
        priority: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
      },
      required: ["company_name"],
    },
  },
  async execute(input, ctx) {
    const companyName = optionalString(input.company_name, 200);
    if (!companyName) return { error: "company_name is required." };
    const payload = {
      id: newProposalId(),
      company_name: companyName,
      contact_name: optionalString(input.contact_name, 200) || "",
      status: normalizeStatus(input.status) || "Lead",
      priority: optionalString(input.priority, 32) || null,
      email: optionalString(input.email, 200) || null,
      phone: optionalString(input.phone, 64) || null,
    };
    const who = payload.contact_name
      ? `${payload.contact_name} at ${companyName}`
      : companyName;
    const human = `Add client **${who}** with status ${payload.status}?`;
    const voice = `Add ${who}. Say yes to confirm.`;
    return makeProposal("client.create", payload, human, voice);
  },
};

export async function executeClientAction(
  type: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  if (type === "client.create") {
    const row = {
      id: String(payload.id || newProposalId()),
      user_id: ctx.userId,
      organization_id: ctx.orgId,
      company_name: String(payload.company_name || ""),
      contact_name: String(payload.contact_name || ""),
      status: String(payload.status || "Lead"),
      priority: (payload.priority as string | null) || null,
      email: (payload.email as string | null) || null,
      phone: (payload.phone as string | null) || null,
      metadata: {},
    };
    const { data, error } = await ctx.supabase.from("clients").insert(row).select("id, company_name, contact_name").maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: data as Record<string, unknown> };
  }

  if (type === "client.update") {
    const clientId = String(payload.client_id || "");
    if (!isUuid(clientId)) return { ok: false, error: "Invalid client id." };
    const patch: Record<string, unknown> = {};
    if (payload.status) patch.status = payload.status;
    if (payload.priority) patch.priority = payload.priority;
    if (payload.contact_name) patch.contact_name = payload.contact_name;
    if (payload.company_name) patch.company_name = payload.company_name;
    if (payload.email) patch.email = payload.email;
    if (payload.phone) patch.phone = payload.phone;
    const { data, error } = await ctx.supabase
      .from("clients")
      .update(patch)
      .eq("id", clientId)
      .eq("organization_id", ctx.orgId)
      .select("id, company_name, contact_name, status, priority")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: data as Record<string, unknown> };
  }

  return { ok: false, error: `Unknown client action: ${type}` };
}
