/** Google Calendar Events API helpers (insert / patch / delete). */

export type CalendarAttendee = { email: string; displayName?: string };

export type CalendarEventInput = {
  summary: string;
  description?: string;
  location?: string;
  startIso: string;
  endIso: string;
  timeZone: string;
  attendees?: CalendarAttendee[];
  colorId?: string;
};

export type CalendarEventResult =
  | { ok: true; eventId: string; htmlLink?: string }
  | { ok: false; error: string; status?: number };

/** Map dashboard appointment color slugs to Google Calendar colorId (1–11). */
export function appointmentColorToGoogleColorId(color: string | null | undefined): string | undefined {
  const c = String(color || "").toLowerCase();
  const map: Record<string, string> = {
    blue: "9",
    green: "10",
    red: "11",
    amber: "5",
    purple: "3",
    rose: "4",
    slate: "8",
    teal: "2",
    pink: "4",
  };
  return map[c];
}

export async function insertGoogleCalendarEvent(
  accessToken: string,
  input: CalendarEventInput,
  sendUpdates: "all" | "none" | "externalOnly" = "all",
): Promise<CalendarEventResult> {
  const body: Record<string, unknown> = {
    summary: input.summary,
    description: input.description || undefined,
    location: input.location || undefined,
    start: { dateTime: input.startIso, timeZone: input.timeZone },
    end: { dateTime: input.endIso, timeZone: input.timeZone },
  };
  if (input.attendees?.length) {
    body.attendees = input.attendees.map((a) => ({
      email: a.email,
      displayName: a.displayName || undefined,
    }));
  }
  if (input.colorId) body.colorId = input.colorId;

  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("sendUpdates", sendUpdates);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: txt.slice(0, 500), status: res.status };
  }

  const data = (await res.json()) as { id?: string; htmlLink?: string };
  if (!data.id) return { ok: false, error: "Calendar API returned no event id." };
  return { ok: true, eventId: data.id, htmlLink: data.htmlLink };
}

export async function patchGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  input: Partial<CalendarEventInput>,
  sendUpdates: "all" | "none" | "externalOnly" = "all",
): Promise<CalendarEventResult> {
  const body: Record<string, unknown> = {};
  if (input.summary) body.summary = input.summary;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.startIso && input.timeZone) {
    body.start = { dateTime: input.startIso, timeZone: input.timeZone };
  }
  if (input.endIso && input.timeZone) {
    body.end = { dateTime: input.endIso, timeZone: input.timeZone };
  }
  if (input.attendees) {
    body.attendees = input.attendees.map((a) => ({
      email: a.email,
      displayName: a.displayName || undefined,
    }));
  }
  if (input.colorId) body.colorId = input.colorId;

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
  );
  url.searchParams.set("sendUpdates", sendUpdates);

  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: txt.slice(0, 500), status: res.status };
  }

  const data = (await res.json()) as { id?: string; htmlLink?: string };
  return { ok: true, eventId: data.id || eventId, htmlLink: data.htmlLink };
}

export async function deleteGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  sendUpdates: "all" | "none" | "externalOnly" = "all",
): Promise<CalendarEventResult> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
  );
  url.searchParams.set("sendUpdates", sendUpdates);

  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 404) {
    return { ok: true, eventId };
  }
  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: txt.slice(0, 500), status: res.status };
  }
  return { ok: true, eventId };
}
