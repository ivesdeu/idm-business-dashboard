import type { SchedulingAppointment } from '@/components/scheduling/types';

export type AppointmentRow = {
  id: string;
  organization_id: string;
  user_id: string;
  client_id: string | null;
  title: string;
  start_time: string;
  end_time: string;
  location: string | null;
  notes: string | null;
  status: string;
  google_calendar_event_id: string | null;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
};

function clientLabel (clientId: string | null, map: Record<string, string>): string {
  if (!clientId) return '—';
  return map[clientId] ?? 'Unknown client';
}

export function rowToSchedulingAppointment (
  row: AppointmentRow,
  clientNames: Record<string, string>,
): SchedulingAppointment {
  const status = row.status === 'confirmed' || row.status === 'pending' || row.status === 'cancelled'
    ? row.status
    : 'pending';
  return {
    id: row.id,
    title: row.title,
    clientName: clientLabel (row.client_id, clientNames),
    clientId: row.client_id,
    startTime: row.start_time,
    endTime: row.end_time,
    location: row.location,
    notes: row.notes,
    status,
    googleCalendarEventId: row.google_calendar_event_id,
    syncedAt: row.synced_at,
  };
}
