import type { ToolContext } from "../context.ts";
import { isUuid } from "../utils.ts";

export async function executeCalendarSyncAction(
  payload: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const appointmentId = String(payload.appointment_id || "");
  if (!isUuid(appointmentId)) {
    return { ok: false, error: "appointment_id is required for calendar sync." };
  }

  const { data: appt, error: fetchErr } = await ctx.supabase
    .from("appointments")
    .select(
      "id, title, start_time, end_time, location, notes, color, google_calendar_event_id, client_id, clients(email, company_name, contact_name)",
    )
    .eq("organization_id", ctx.orgId)
    .eq("id", appointmentId)
    .maybeSingle();

  if (fetchErr || !appt) {
    return { ok: false, error: fetchErr?.message || "Appointment not found." };
  }

  const client = appt.clients as {
    email?: string | null;
    company_name?: string | null;
    contact_name?: string | null;
  } | null;
  const attendeeEmail =
    (payload.attendee_email as string | undefined)?.trim() ||
    (client?.email && String(client.email).includes("@") ? String(client.email).trim() : "");
  const attendeeName =
    String(client?.company_name || "").trim() ||
    String(client?.contact_name || "").trim() ||
    undefined;

  const sendInvite = payload.send_invite !== false;
  const attendees =
    sendInvite && attendeeEmail
      ? [{ email: attendeeEmail, displayName: attendeeName }]
      : undefined;

  if (!ctx.authHeader || !ctx.supabaseUrl || !ctx.anonKey) {
    return { ok: false, error: "Calendar sync is not available in this context." };
  }

  const action = appt.google_calendar_event_id ? "patch" : "insert";
  const body: Record<string, unknown> = {
    organization_id: ctx.orgId,
    action,
    summary: String(appt.title || "Meeting"),
    description: appt.notes || undefined,
    location: appt.location || undefined,
    start_iso: String(appt.start_time),
    end_iso: String(appt.end_time),
    time_zone: ctx.effectiveTimezone,
    color: appt.color || undefined,
    attendees,
    send_updates: sendInvite && attendeeEmail ? "all" : "none",
  };
  if (action === "patch") {
    body.event_id = appt.google_calendar_event_id;
  }

  const res = await fetch(`${ctx.supabaseUrl}/functions/v1/google-calendar-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: ctx.authHeader,
      apikey: ctx.anonKey,
    },
    body: JSON.stringify(body),
  });

  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }

  if (!res.ok || j.error) {
    const err = j.detail != null ? String(j.detail) : j.error != null ? String(j.error) : "Calendar sync failed.";
    return { ok: false, error: err };
  }

  const eventId = j.event_id != null ? String(j.event_id) : "";
  if (!eventId) return { ok: false, error: "Calendar API returned no event id." };

  const syncedAt = new Date().toISOString();
  const { error: updErr } = await ctx.supabase
    .from("appointments")
    .update({
      google_calendar_event_id: eventId,
      synced_at: syncedAt,
    })
    .eq("id", appointmentId)
    .eq("organization_id", ctx.orgId);

  if (updErr) {
    return {
      ok: true,
      result: {
        appointment_id: appointmentId,
        google_calendar_event_id: eventId,
        synced_at: syncedAt,
        warning: "Event created in Google Calendar but local sync metadata failed to save.",
      },
    };
  }

  return {
    ok: true,
    result: {
      appointment_id: appointmentId,
      google_calendar_event_id: eventId,
      synced_at: syncedAt,
      invite_sent: !!(sendInvite && attendeeEmail),
      attendee_email: attendeeEmail || null,
    },
  };
}
