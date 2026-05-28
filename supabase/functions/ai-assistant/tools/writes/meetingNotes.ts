import type { AdvisorToolModule, ToolContext } from "../context.ts";
import { makeProposal, newProposalId, resolveClientId } from "./shared.ts";
import { isUuid, optionalString } from "../utils.ts";

function yesterdayRangeUtc(): { from: string; to: string } {
  const now = new Date();
  const y = new Date(now);
  y.setUTCDate(y.getUTCDate() - 1);
  const ymd = y.toISOString().slice(0, 10);
  return { from: `${ymd}T00:00:00.000Z`, to: `${ymd}T23:59:59.999Z` };
}

export const proposeMeetingNoteCreateTool: AdvisorToolModule = {
  name: "propose_meeting_note_create",
  definition: {
    name: "propose_meeting_note_create",
    description: "Propose creating a new meeting note and opening it. Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        client_name: { type: "string" },
        scheduled_iso: { type: "string" },
      },
      required: ["title"],
    },
  },
  async execute(input, ctx) {
    const title = optionalString(input.title, 300);
    if (!title) return { error: "title is required." };
    const clientRes = await resolveClientId(ctx, optionalString(input.client_name, 120), undefined);
    if (clientRes.error) return { error: clientRes.error, candidates: clientRes.candidates };

    const payload = {
      title,
      contact_id: clientRes.clientId,
      scheduled_at: optionalString(input.scheduled_iso, 64) || null,
    };
    const human = `Create meeting note **${title}** and open it?`;
    const voice = `Create meeting note ${title}. Say yes to confirm.`;
    return makeProposal("meeting_note.create", payload, human, voice);
  },
};

export const proposeMeetingNoteAssignActionItemsTool: AdvisorToolModule = {
  name: "propose_meeting_note_assign_action_items",
  definition: {
    name: "propose_meeting_note_assign_action_items",
    description:
      "Propose assigning all action items on meeting note(s) to the current user. Requires confirmation.",
    input_schema: {
      type: "object",
      properties: {
        meeting_note_id: { type: "string" },
        filter: {
          type: "string",
          enum: ["yesterday", "today", "latest"],
          description: "Which note(s) when id not given.",
        },
        assign_to: { type: "string", enum: ["me"], description: "Only 'me' supported in v1." },
      },
    },
  },
  async execute(input, ctx) {
    const noteId = optionalString(input.meeting_note_id, 64);
    let notes: Array<Record<string, unknown>> = [];

    if (noteId && isUuid(noteId)) {
      const { data, error } = await ctx.supabase
        .from("meeting_notes")
        .select("id, title, action_items, scheduled_at")
        .eq("organization_id", ctx.orgId)
        .eq("id", noteId)
        .maybeSingle();
      if (error) return { error: error.message };
      if (!data) return { error: "Meeting note not found." };
      notes = [data as Record<string, unknown>];
    } else {
      const filter = optionalString(input.filter, 32) || "yesterday";
      let query = ctx.supabase
        .from("meeting_notes")
        .select("id, title, action_items, scheduled_at, updated_at")
        .eq("organization_id", ctx.orgId)
        .order("updated_at", { ascending: false })
        .limit(5);

      if (filter === "yesterday") {
        const r = yesterdayRangeUtc();
        query = query.gte("scheduled_at", r.from).lte("scheduled_at", r.to);
      } else if (filter === "today") {
        const ymd = new Date().toISOString().slice(0, 10);
        query = query.gte("scheduled_at", `${ymd}T00:00:00.000Z`).lte("scheduled_at", `${ymd}T23:59:59.999Z`);
      }

      const { data, error } = await query;
      if (error) return { error: error.message };
      notes = (data || []) as Array<Record<string, unknown>>;
      if (!notes.length) return { error: `No meeting notes found for filter "${filter}".` };
    }

    const updates: Array<{ id: string; title: string; action_items: unknown[] }> = [];
    for (const n of notes) {
      const items = Array.isArray(n.action_items) ? (n.action_items as Array<Record<string, unknown>>) : [];
      if (!items.length) continue;
      const next = items.map((it) => ({
        ...it,
        owner: ctx.userDisplayName,
        owner_user_id: ctx.userId,
      }));
      updates.push({ id: String(n.id), title: String(n.title || "Meeting"), action_items: next });
    }

    if (!updates.length) return { error: "No action items to assign on the selected note(s)." };

    const human = `Assign all action items on **${updates.length}** meeting note(s) to you?`;
    const voice = `Assign action items to you on ${updates.length} notes. Say yes to confirm.`;
    return makeProposal(
      "meeting_note.assign_action_items",
      { updates, assign_to_user_id: ctx.userId },
      human,
      voice,
    );
  },
};

export const proposeEmailMeetingSummaryTool: AdvisorToolModule = {
  name: "propose_email_meeting_summary",
  definition: {
    name: "propose_email_meeting_summary",
    description:
      "Propose opening the email composer with a meeting summary prefilled for attendees. User must click Send.",
    input_schema: {
      type: "object",
      properties: {
        meeting_note_id: { type: "string" },
        filter: { type: "string", enum: ["latest", "yesterday"] },
        additional_recipients: { type: "array", items: { type: "string" } },
      },
    },
  },
  async execute(input, ctx) {
    let note: Record<string, unknown> | null = null;
    const noteId = optionalString(input.meeting_note_id, 64);
    if (noteId && isUuid(noteId)) {
      const { data, error } = await ctx.supabase
        .from("meeting_notes")
        .select("id, title, summary, attendees, action_items, decisions")
        .eq("organization_id", ctx.orgId)
        .eq("id", noteId)
        .maybeSingle();
      if (error) return { error: error.message };
      note = data as Record<string, unknown> | null;
    } else {
      const { data, error } = await ctx.supabase
        .from("meeting_notes")
        .select("id, title, summary, attendees, action_items, decisions")
        .eq("organization_id", ctx.orgId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return { error: error.message };
      note = data as Record<string, unknown> | null;
    }
    if (!note) return { error: "Meeting note not found." };

    const attendees = Array.isArray(note.attendees) ? (note.attendees as Array<Record<string, unknown>>) : [];
    const emails = attendees
      .map((a) => String(a.email || "").trim())
      .filter((e) => e.includes("@"));
    const extra = Array.isArray(input.additional_recipients)
      ? (input.additional_recipients as unknown[]).map((e) => String(e).trim()).filter((e) => e.includes("@"))
      : [];
    const to = [...new Set([...emails, ...extra])];
    if (!to.length) return { error: "No attendee emails on this meeting note." };

    const summary = String(note.summary || "").trim() || "See meeting notes in the dashboard.";
    const title = String(note.title || "Meeting");
    const htmlBody = `<p>${summary.replace(/\n/g, "<br>")}</p>`;

    const payload = {
      client_action: "open_email_composer",
      to,
      subject: `Summary: ${title}`,
      html_body: htmlBody,
      plain_body: summary,
      meeting_note_id: note.id,
    };

    const human = `Open email composer to **${to.join(", ")}** with subject "${payload.subject}"? You will still click Send.`;
    const voice = `Open email to attendees. Say yes to confirm.`;
    return makeProposal("meeting_note.email_summary", payload, human, voice);
  },
};

export async function executeMeetingNoteAction(
  type: string,
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string; client_action?: string }> {
  if (type === "meeting_note.create") {
    const row = {
      organization_id: ctx.orgId,
      contact_id: (payload.contact_id as string | null) || null,
      title: String(payload.title || "Untitled meeting"),
      attendees: Array.isArray(payload.attendees) ? payload.attendees : [],
      scheduled_at: (payload.scheduled_at as string | null) || null,
      raw_notes: "",
      manual_notes: String(payload.manual_notes || ""),
      action_items: Array.isArray(payload.action_items) ? payload.action_items : [],
      decisions: String(payload.decisions || ""),
      summary: String(payload.summary || ""),
      topics: Array.isArray(payload.topics) ? payload.topics : [],
      transcript_duration: 0,
      status: (payload.status as string) || "draft",
    };
    const { data, error } = await ctx.supabase
      .from("meeting_notes")
      .insert(row)
      .select("id, title")
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      result: data as Record<string, unknown>,
      client_action: "open_meeting_note",
    };
  }

  if (type === "meeting_note.assign_action_items") {
    const updates = Array.isArray(payload.updates) ? (payload.updates as Array<Record<string, unknown>>) : [];
    const applied: string[] = [];
    for (const u of updates) {
      const id = String(u.id || "");
      if (!isUuid(id)) continue;
      const { error } = await ctx.supabase
        .from("meeting_notes")
        .update({ action_items: u.action_items })
        .eq("id", id)
        .eq("organization_id", ctx.orgId);
      if (!error) applied.push(id);
    }
    return { ok: applied.length > 0, result: { updated_note_ids: applied } };
  }

  if (type === "meeting_note.email_summary") {
    return {
      ok: true,
      result: {
        to: payload.to,
        subject: payload.subject,
        html_body: payload.html_body,
      },
      client_action: "open_email_composer",
    };
  }

  return { ok: false, error: `Unknown meeting note action: ${type}` };
}
