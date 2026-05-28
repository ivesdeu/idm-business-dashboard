import type { AdvisorToolModule, ToolContext } from "../context.ts";
import {
  displayClientName,
  makeProposal,
  newProposalId,
  parseAppointmentColor,
  resolveClientId,
} from "./shared.ts";
import { isUuid, optionalString, parseIsoDate } from "../utils.ts";

const APPOINTMENT_COLORS = ["blue", "green", "red", "amber", "purple", "rose", "slate", "teal", "pink"];

async function findAppointmentCandidates(
  ctx: ToolContext,
  opts: {
    appointment_id?: string;
    title?: string;
    client_name?: string;
    when_hint?: string;
  },
) {
  if (opts.appointment_id && isUuid(opts.appointment_id)) {
    const { data, error } = await ctx.supabase
      .from("appointments")
      .select("id, title, start_time, end_time, status, color, client_id, clients(company_name, contact_name)")
      .eq("organization_id", ctx.orgId)
      .eq("id", opts.appointment_id)
      .maybeSingle();
    if (error) return { error: error.message, rows: [] };
    return { rows: data ? [data] : [] };
  }
  if (ctx.lastEntities?.appointmentId && isUuid(ctx.lastEntities.appointmentId) && !opts.title && !opts.client_name) {
    const { data, error } = await ctx.supabase
      .from("appointments")
      .select("id, title, start_time, end_time, status, color, client_id, clients(company_name, contact_name)")
      .eq("organization_id", ctx.orgId)
      .eq("id", ctx.lastEntities.appointmentId)
      .maybeSingle();
    if (error) return { error: error.message, rows: [] };
    return { rows: data ? [data] : [] };
  }

  let query = ctx.supabase
    .from("appointments")
    .select("id, title, start_time, end_time, status, color, client_id, clients(company_name, contact_name)")
    .eq("organization_id", ctx.orgId)
    .neq("status", "cancelled")
    .order("start_time", { ascending: true })
    .limit(8);

  const now = new Date();
  const hint = optionalString(opts.when_hint, 64)?.toLowerCase() || "";
  if (hint.includes("tomorrow")) {
    const t = new Date(now);
    t.setUTCDate(t.getUTCDate() + 1);
    const ymd = t.toISOString().slice(0, 10);
    query = query.gte("start_time", `${ymd}T00:00:00.000Z`).lte("start_time", `${ymd}T23:59:59.999Z`);
  } else if (hint.includes("today")) {
    const ymd = now.toISOString().slice(0, 10);
    query = query.gte("start_time", `${ymd}T00:00:00.000Z`).lte("start_time", `${ymd}T23:59:59.999Z`);
  } else {
    query = query.gte("start_time", new Date(now.getTime() - 7 * 86400000).toISOString());
  }

  const title = optionalString(opts.title, 200);
  if (title) query = query.ilike("title", `%${title}%`);

  const { data, error } = await query;
  if (error) return { error: error.message, rows: [] };
  let rows = (data || []) as Array<Record<string, unknown>>;
  const clientName = optionalString(opts.client_name, 120);
  if (clientName) {
    const needle = clientName.toLowerCase();
    rows = rows.filter((r) => {
      const c = r.clients as { company_name?: string; contact_name?: string } | null;
      const cn = String(c?.company_name || "").toLowerCase();
      const ct = String(c?.contact_name || "").toLowerCase();
      return cn.includes(needle) || ct.includes(needle);
    });
  }
  return { rows };
}

function formatApptWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export const proposeAppointmentCreateTool: AdvisorToolModule = {
  name: "propose_appointment_create",
  definition: {
    name: "propose_appointment_create",
    description:
      "Propose creating a calendar appointment. Requires user confirmation before saving. Use for scheduling meetings.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_iso: { type: "string", description: "ISO start datetime." },
        end_iso: { type: "string", description: "ISO end datetime (optional if duration_min set)." },
        duration_min: { type: "number", description: "Duration in minutes if end_iso omitted." },
        client_name: { type: "string" },
        color: { type: "string", enum: APPOINTMENT_COLORS },
        location: { type: "string" },
        notes: { type: "string" },
      },
      required: ["title", "start_iso"],
    },
  },
  async execute(input, ctx) {
    const title = optionalString(input.title, 300);
    const startIso = parseIsoDate(input.start_iso);
    if (!title || !startIso) return { error: "title and start_iso are required." };

    let endIso = parseIsoDate(input.end_iso);
    if (!endIso) {
      const dur = typeof input.duration_min === "number" ? input.duration_min : 60;
      const end = new Date(startIso);
      end.setMinutes(end.getMinutes() + Math.max(15, Math.min(480, dur)));
      endIso = end.toISOString();
    }

    const clientRes = await resolveClientId(ctx, optionalString(input.client_name, 120), undefined);
    if (clientRes.error) return { error: clientRes.error, candidates: clientRes.candidates };

    const color = parseAppointmentColor(input.color);
    const payload = {
      title,
      start_time: startIso,
      end_time: endIso,
      client_id: clientRes.clientId,
      location: optionalString(input.location, 300) || null,
      notes: optionalString(input.notes, 4000) || null,
      color,
      status: "pending",
    };

    const clientLabel = optionalString(input.client_name, 120) || "no client";
    const colorLabel = color ? `, color ${color}` : "";
    const human =
      `Create appointment **${title}** on ${formatApptWhen(startIso)} with ${clientLabel}${colorLabel}?`;
    const voice = `Create ${title} on ${formatApptWhen(startIso)}. Say yes to confirm or cancel.`;
    return makeProposal("appointment.create", payload, human, voice);
  },
};

export const proposeAppointmentUpdateTool: AdvisorToolModule = {
  name: "propose_appointment_update",
  definition: {
    name: "propose_appointment_update",
    description:
      "Propose updating an existing appointment (time, color, title, etc.). Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        title: { type: "string" },
        new_start_iso: { type: "string" },
        new_end_iso: { type: "string" },
        color: { type: "string", enum: APPOINTMENT_COLORS },
        client_name: { type: "string", description: "Disambiguation hint." },
        when_hint: { type: "string", description: "e.g. today, tomorrow, 3pm" },
      },
    },
  },
  async execute(input, ctx) {
    const found = await findAppointmentCandidates(ctx, {
      appointment_id: optionalString(input.appointment_id, 64),
      title: optionalString(input.title, 200),
      client_name: optionalString(input.client_name, 120),
      when_hint: optionalString(input.when_hint, 64),
    });
    if (found.error) return { error: found.error };
    if (!found.rows.length) return { error: "No matching appointment found." };
    if (found.rows.length > 1) {
      return {
        error: "Multiple appointments match. Be more specific.",
        candidates: found.rows.map((r) => ({
          id: r.id,
          title: r.title,
          start_time: r.start_time,
        })),
      };
    }

    const row = found.rows[0];
    const appointmentId = String(row.id);
    const patch: Record<string, unknown> = { appointment_id: appointmentId };
    if (optionalString(input.title, 300)) patch.title = optionalString(input.title, 300);
    const newStart = parseIsoDate(input.new_start_iso);
    const newEnd = parseIsoDate(input.new_end_iso);
    if (newStart) patch.start_time = newStart;
    if (newEnd) patch.end_time = newEnd;
    const color = parseAppointmentColor(input.color);
    if (color !== null || input.color === null) {
      if (input.color !== undefined) patch.color = color;
    }

    const bits: string[] = [];
    if (patch.title) bits.push(`title → ${patch.title}`);
    if (patch.start_time) bits.push(`start → ${formatApptWhen(String(patch.start_time))}`);
    if (patch.color) bits.push(`color → ${patch.color}`);
    const human = `Update **${row.title}** (${formatApptWhen(String(row.start_time))})${bits.length ? ": " + bits.join(", ") : ""}?`;
    const voice = `Update ${row.title}. ${bits.join(". ") || ""} Say yes to confirm.`;
    return makeProposal("appointment.update", patch, human, voice);
  },
};

export const proposeAppointmentCancelTool: AdvisorToolModule = {
  name: "propose_appointment_cancel",
  definition: {
    name: "propose_appointment_cancel",
    description: "Propose cancelling an appointment (sets status to cancelled). Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        title: { type: "string" },
        client_name: { type: "string" },
        when_hint: { type: "string" },
      },
    },
  },
  async execute(input, ctx) {
    const found = await findAppointmentCandidates(ctx, {
      appointment_id: optionalString(input.appointment_id, 64),
      title: optionalString(input.title, 200),
      client_name: optionalString(input.client_name, 120),
      when_hint: optionalString(input.when_hint, 64),
    });
    if (found.error) return { error: found.error };
    if (!found.rows.length) return { error: "No matching appointment found." };
    if (found.rows.length > 1) {
      return {
        error: "Multiple appointments match.",
        candidates: found.rows.map((r) => ({ id: r.id, title: r.title, start_time: r.start_time })),
      };
    }
    const row = found.rows[0];
    const payload = { appointment_id: String(row.id), status: "cancelled" };
    const human = `Cancel **${row.title}** on ${formatApptWhen(String(row.start_time))}?`;
    const voice = `Cancel ${row.title}. Say yes to confirm.`;
    return makeProposal("appointment.cancel", payload, human, voice);
  },
};

export async function executeAppointmentAction(
  type: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  if (type === "appointment.create") {
    const row = {
      id: newProposalId(),
      organization_id: ctx.orgId,
      user_id: ctx.userId,
      client_id: (payload.client_id as string | null) || null,
      title: String(payload.title || "Meeting"),
      start_time: String(payload.start_time),
      end_time: String(payload.end_time),
      location: (payload.location as string | null) || null,
      notes: (payload.notes as string | null) || null,
      color: (payload.color as string | null) || null,
      status: "pending",
    };
    const { data, error } = await ctx.supabase.from("appointments").insert(row).select("id, title, start_time").maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: { appointment_id: data?.id, title: data?.title, start_time: data?.start_time } };
  }

  const appointmentId = String(payload.appointment_id || "");
  if (!isUuid(appointmentId)) return { ok: false, error: "Invalid appointment id." };

  if (type === "appointment.cancel") {
    const { data, error } = await ctx.supabase
      .from("appointments")
      .update({ status: "cancelled" })
      .eq("id", appointmentId)
      .eq("organization_id", ctx.orgId)
      .select("id, title, status")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: data as Record<string, unknown> };
  }

  if (type === "appointment.update") {
    const patch: Record<string, unknown> = {};
    if (payload.title) patch.title = payload.title;
    if (payload.start_time) patch.start_time = payload.start_time;
    if (payload.end_time) patch.end_time = payload.end_time;
    if (payload.color !== undefined) patch.color = payload.color;
    const { data, error } = await ctx.supabase
      .from("appointments")
      .update(patch)
      .eq("id", appointmentId)
      .eq("organization_id", ctx.orgId)
      .select("id, title, start_time, end_time, color, status")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, result: data as Record<string, unknown> };
  }

  return { ok: false, error: `Unknown appointment action: ${type}` };
}
