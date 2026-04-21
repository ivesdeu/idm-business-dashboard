/**
 * Google Calendar integration — replace these stubs with OAuth + Calendar API.
 * UI should import only from this file for sync/fetch so production wiring is one place.
 */

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
};

export type SyncToGoogleResult =
  | { success: true; googleEventId: string }
  | { success: false; error: string };

/** TODO: Replace with real Google Calendar API event insert using OAuth access token. */
export async function syncToGoogleCalendar (appointment: AppointmentLike): Promise<SyncToGoogleResult> {
  console.log('[googleCalendar stub] syncToGoogleCalendar', appointment);
  const mockId = `mock_evt_${appointment.id.slice(0, 8)}_${Date.now ()}`;
  return { success: true, googleEventId: mockId };
}

/** TODO: Replace with Calendar API DELETE /calendars/primary/events/{eventId}. */
export async function deleteFromGoogleCalendar (eventId: string): Promise<boolean> {
  console.log('[googleCalendar stub] deleteFromGoogleCalendar', eventId);
  return true;
}

export type MockGoogleEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
};

export const mockGoogleCalendarEvents: MockGoogleEvent[] = [
  {
    id: 'mock_external_1',
    summary: 'External — team standup',
    start: new Date ().toISOString (),
    end: new Date (Date.now () + 30 * 60 * 1000).toISOString (),
  },
  {
    id: 'mock_external_2',
    summary: 'External — vendor call',
    start: new Date (Date.now () + 2 * 60 * 60 * 1000).toISOString (),
    end: new Date (Date.now () + 2 * 60 * 60 * 1000 + 45 * 60 * 1000).toISOString (),
  },
];

/** TODO: Replace with Calendar API GET /calendars/primary/events with query params for timeMin/timeMax. */
export async function fetchGoogleCalendarEvents (dateRange: DateRange): Promise<MockGoogleEvent[]> {
  console.log('[googleCalendar stub] fetchGoogleCalendarEvents', dateRange);
  return mockGoogleCalendarEvents;
}
