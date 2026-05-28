/**
 * Google Calendar integration — sync via google-calendar-events edge function.
 */

import { getAccessToken, getAnonKey, getEdgeBase } from './email/session';

export type DateRange = { start: Date; end: Date };

export type AppointmentLike = {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  location?: string | null;
  notes?: string | null;
  status?: string;
  googleCalendarEventId?: string | null;
  color?: string | null;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
};

export type SyncToGoogleResult =
  | { success: true; googleEventId: string }
  | { success: false; error: string; notConnected?: boolean };

function getOrgId (): string | null {
  if (typeof window.bizDashGetCurrentOrgId === 'function') {
    return window.bizDashGetCurrentOrgId();
  }
  const id = (window as { currentOrganizationId?: string }).currentOrganizationId;
  return id && String(id).trim() ? String(id).trim() : null;
}

async function callCalendarEvents (
  body: Record<string, unknown>,
): Promise<{ ok: boolean; event_id?: string; error?: string; detail?: string; notConnected?: boolean }> {
  const token = await getAccessToken();
  const base = getEdgeBase();
  const anon = getAnonKey();
  const orgId = getOrgId();
  if (!token || !base || !anon || !orgId) {
    return { ok: false, error: 'session', detail: 'Sign in and select a workspace first.' };
  }

  const res = await fetch(`${base}/functions/v1/google-calendar-events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon,
    },
    body: JSON.stringify({ organization_id: orgId, ...body }),
  });

  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }

  if (!res.ok || j.error) {
    const err = j.error != null ? String(j.error) : 'calendar_sync_failed';
    const det = j.detail != null ? String(j.detail) : '';
    if (err === 'not_connected') {
      return { ok: false, error: err, detail: det, notConnected: true };
    }
    return { ok: false, error: err, detail: det || 'Could not sync to Google Calendar.' };
  }

  return { ok: true, event_id: j.event_id != null ? String(j.event_id) : undefined };
}

export async function syncToGoogleCalendar (appointment: AppointmentLike): Promise<SyncToGoogleResult> {
  const attendees =
    appointment.attendeeEmail && appointment.attendeeEmail.includes('@')
      ? [{ email: appointment.attendeeEmail, displayName: appointment.attendeeName || undefined }]
      : undefined;

  const action = appointment.googleCalendarEventId ? 'patch' : 'insert';
  const body: Record<string, unknown> = {
    action,
    summary: appointment.title,
    description: appointment.notes || undefined,
    location: appointment.location || undefined,
    start_iso: appointment.startTime,
    end_iso: appointment.endTime,
    color: appointment.color || undefined,
    attendees,
    send_updates: 'all',
  };
  if (action === 'patch') {
    body.event_id = appointment.googleCalendarEventId;
  }

  const result = await callCalendarEvents(body);
  if (!result.ok || !result.event_id) {
    return {
      success: false,
      error: result.detail || result.error || 'Calendar sync failed.',
      notConnected: result.notConnected,
    };
  }
  return { success: true, googleEventId: result.event_id };
}

export async function deleteFromGoogleCalendar (eventId: string): Promise<boolean> {
  const result = await callCalendarEvents({
    action: 'delete',
    event_id: eventId,
    send_updates: 'all',
  });
  return result.ok;
}

export type MockGoogleEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
};

export const mockGoogleCalendarEvents: MockGoogleEvent[] = [];

/** Read-only fetch remains a stub until calendar.read scope is wired for import. */
export async function fetchGoogleCalendarEvents (_dateRange: DateRange): Promise<MockGoogleEvent[]> {
  return mockGoogleCalendarEvents;
}
