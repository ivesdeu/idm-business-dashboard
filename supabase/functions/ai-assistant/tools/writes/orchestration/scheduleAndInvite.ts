import type { AdvisorToolModule, ToolContext } from "../../context.ts";
import {
  displayClientName,
  makeCompoundProposal,
  parseAppointmentColor,
  resolveClientId,
} from "../shared.ts";
import { optionalString, parseIsoDate } from "../../utils.ts";

export const proposeScheduleAndInviteTool: AdvisorToolModule = {
  name: "propose_schedule_and_invite",
  definition: {
    name: "propose_schedule_and_invite",
    description:
      "Propose scheduling an appointment AND syncing to Google Calendar with email invite to the client. Multi-step; requires one confirmation.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start_iso: { type: "string" },
        end_iso: { type: "string" },
        duration_min: { type: "number" },
        client_name: { type: "string" },
        client_id: { type: "string" },
        color: { type: "string" },
        location: { type: "string" },
        notes: { type: "string" },
        send_invite: { type: "boolean", description: "Send Google Calendar invite (default true)." },
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
      endIso = new Date(new Date(startIso).getTime() + dur * 60_000).toISOString();
    }

    const clientRes = await resolveClientId(
      ctx,
      optionalString(input.client_name, 120),
      optionalString(input.client_id, 64),
    );
    if (clientRes.error) return { error: clientRes.error, candidates: clientRes.candidates };

    let clientEmail = "";
    let clientLabel = "";
    if (clientRes.clientId) {
      const { data: clientRow } = await ctx.supabase
        .from("clients")
        .select("email, company_name, contact_name")
        .eq("id", clientRes.clientId)
        .eq("organization_id", ctx.orgId)
        .maybeSingle();
      if (clientRow) {
        clientEmail = String(clientRow.email || "").trim();
        clientLabel = displayClientName(clientRow);
      }
    }

    const color = parseAppointmentColor(input.color);
    const sendInvite = input.send_invite !== false;

    const steps = [
      {
        id: "create_apt",
        type: "appointment.create",
        label: `Create appointment: ${title}`,
        payload: {
          title,
          start_time: startIso,
          end_time: endIso,
          client_id: clientRes.clientId,
          color,
          location: optionalString(input.location, 300) || null,
          notes: optionalString(input.notes, 2000) || null,
        },
      },
      {
        id: "sync_cal",
        type: "calendar.sync",
        label: sendInvite && clientEmail
          ? `Sync to Google Calendar & invite ${clientEmail}`
          : "Sync to Google Calendar",
        optional: true,
        payload: {
          appointment_id: { ref: "step.create_apt.appointment_id" },
          send_invite: sendInvite,
          attendee_email: clientEmail || undefined,
        },
      },
    ];

    const inviteNote =
      sendInvite && clientEmail
        ? ` Google will email **${clientEmail}** an invite.`
        : sendInvite && !clientEmail
          ? " (No client email on file — calendar event only.)"
          : "";

    const human =
      `**Schedule & invite** (${clientLabel || "no client"}):\n\n` +
      `1. Create **${title}** — ${new Date(startIso).toLocaleString()}\n` +
      `2. Sync to Google Calendar${inviteNote}\n\n` +
      `Confirm once to run both steps.`;

    const voice = `Schedule ${title} and sync to calendar.${clientEmail ? ` Invite ${clientEmail}.` : ""} Say yes to confirm.`;

    return makeCompoundProposal("schedule_and_invite", steps, human, voice);
  },
};
