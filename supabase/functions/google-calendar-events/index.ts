import { createClient } from "npm:@supabase/supabase-js@2.101.1";
import { serveWithEdgeRequestLogging } from "../_shared/withEdgeRequestLogging.ts";
import { corsHeadersFor } from "../_shared/cors.ts";
import { getGoogleAccessTokenForUserOrg } from "../_shared/googleAccessToken.ts";
import { resolveOrganizationId } from "../_shared/orgContext.ts";
import {
  appointmentColorToGoogleColorId,
  deleteGoogleCalendarEvent,
  insertGoogleCalendarEvent,
  patchGoogleCalendarEvent,
  type CalendarAttendee,
} from "../_shared/googleCalendarEventsApi.ts";

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

function parseAttendees(raw: unknown): CalendarAttendee[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarAttendee[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const email = rec.email != null ? String(rec.email).trim() : "";
    if (!email || !email.includes("@")) continue;
    const displayName = rec.displayName != null ? String(rec.displayName).trim() : undefined;
    out.push({ email, displayName });
  }
  return out;
}

serveWithEdgeRequestLogging("google-calendar-events", async (req, _ctx) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(req) });
  }
  if (req.method !== "POST") {
    return json(req, 405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID")?.trim();
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")?.trim();
  if (!supabaseUrl || !anonKey || !serviceKey || !clientId || !clientSecret) {
    return json(req, 500, { error: "Server misconfiguration" });
  }

  const authHeader = req.headers.get("Authorization")?.trim() || "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(req, 401, { error: "Missing Authorization" });
  }
  const jwt = authHeader.slice(7).trim();
  if (!jwt) return json(req, 401, { error: "Missing Authorization" });

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(req, 400, { error: "Invalid JSON" });
  }

  const organizationIdRaw = body.organization_id != null ? String(body.organization_id).trim() : "";
  const action = body.action != null ? String(body.action).trim() : "insert";

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userErr } = await userClient.auth.getUser(jwt);
  if (userErr || !userData?.user?.id) {
    return json(req, 401, { error: userErr?.message || "Invalid session" });
  }
  const userId = userData.user.id;

  const orgId = await resolveOrganizationId(userClient, userId, organizationIdRaw || null);
  if (!orgId) {
    return json(req, 403, { error: "No organization membership" });
  }

  const tokenResult = await getGoogleAccessTokenForUserOrg(admin, userId, orgId, clientId, clientSecret);
  if (!tokenResult.ok) {
    if (tokenResult.code === "not_connected") {
      return json(req, 400, {
        error: "not_connected",
        detail: "Connect Google in Settings → Connections (calendar write scope required).",
      });
    }
    return json(req, 502, {
      error: "token_refresh",
      detail: "Could not refresh Google access. Reconnect in Settings → Connections.",
    });
  }

  const access = tokenResult.accessToken;
  const timeZone =
    body.time_zone != null && String(body.time_zone).trim()
      ? String(body.time_zone).trim()
      : "America/New_York";
  const sendUpdates =
    body.send_updates === "none" || body.send_updates === "externalOnly"
      ? (body.send_updates as "none" | "externalOnly")
      : "all";

  if (action === "delete") {
    const eventId = body.event_id != null ? String(body.event_id).trim() : "";
    if (!eventId) return json(req, 400, { error: "event_id is required for delete." });
    const result = await deleteGoogleCalendarEvent(access, eventId, sendUpdates);
    if (!result.ok) {
      return json(req, 502, { error: "calendar_delete_failed", detail: result.error });
    }
    return json(req, 200, { ok: true, event_id: result.eventId });
  }

  const summary = body.summary != null ? String(body.summary).trim() : "";
  const startIso = body.start_iso != null ? String(body.start_iso).trim() : "";
  const endIso = body.end_iso != null ? String(body.end_iso).trim() : "";
  const colorSlug = body.color != null ? String(body.color).trim() : "";
  const colorId = appointmentColorToGoogleColorId(colorSlug);
  const attendees = parseAttendees(body.attendees);
  const description = body.description != null ? String(body.description) : undefined;
  const location = body.location != null ? String(body.location) : undefined;

  if (action === "patch") {
    const eventId = body.event_id != null ? String(body.event_id).trim() : "";
    if (!eventId) return json(req, 400, { error: "event_id is required for patch." });
    const result = await patchGoogleCalendarEvent(
      access,
      eventId,
      {
        summary: summary || undefined,
        description,
        location,
        startIso: startIso || undefined,
        endIso: endIso || undefined,
        timeZone,
        attendees: attendees.length ? attendees : undefined,
        colorId,
      },
      sendUpdates,
    );
    if (!result.ok) {
      return json(req, 502, { error: "calendar_patch_failed", detail: result.error });
    }
    return json(req, 200, { ok: true, event_id: result.eventId, html_link: result.htmlLink });
  }

  if (!summary || !startIso || !endIso) {
    return json(req, 400, { error: "summary, start_iso, and end_iso are required for insert." });
  }

  const result = await insertGoogleCalendarEvent(
    access,
    {
      summary,
      description,
      location,
      startIso,
      endIso,
      timeZone,
      attendees,
      colorId,
    },
    sendUpdates,
  );

  if (!result.ok) {
    return json(req, 502, { error: "calendar_insert_failed", detail: result.error });
  }

  return json(req, 200, {
    ok: true,
    event_id: result.eventId,
    html_link: result.htmlLink,
  });
});
