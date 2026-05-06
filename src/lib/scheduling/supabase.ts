import type {
  MeetingActionItem,
  MeetingNote,
  MeetingNoteAttendee,
  SchedulingAppointment,
} from '@/components/scheduling/types';

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

export type MeetingNoteRow = {
  id: string;
  organization_id: string;
  contact_id: string | null;
  calendar_event_id: string | null;
  title: string;
  attendees: unknown;
  scheduled_at: string | null;
  agenda: string | null;
  raw_notes: string | null;
  manual_notes: string | null;
  transcript: string | null;
  topics: unknown;
  transcript_duration: number | null;
  action_items: unknown;
  decisions: string | null;
  summary: string | null;
  status: string | null;
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

function parseAttendees (value: unknown): MeetingNoteAttendee[] {
  if (!Array.isArray (value)) return [];
  return value
    .map ((item) => {
      if (!item || typeof item !== 'object') return null;
      const rec = item as Record<string, unknown>;
      const email = typeof rec.email === 'string' ? rec.email.trim () : '';
      const name = typeof rec.name === 'string' ? rec.name.trim () : '';
      if (!email && !name) return null;
      return { email, name };
    })
    .filter ((item): item is MeetingNoteAttendee => !!item);
}

function parseActionItems (value: unknown): MeetingActionItem[] {
  if (!Array.isArray (value)) return [];
  return value
    .map ((item) => {
      if (!item || typeof item !== 'object') return null;
      const rec = item as Record<string, unknown>;
      const task = typeof rec.task === 'string' ? rec.task.trim () : '';
      const owner = typeof rec.owner === 'string' ? rec.owner.trim () : '';
      const dueDate = typeof rec.due_date === 'string'
        ? rec.due_date
        : typeof rec.dueDate === 'string'
          ? rec.dueDate
          : null;
      const completed = rec.completed === true;
      if (!task) return null;
      return { task, owner, dueDate, completed };
    })
    .filter ((item): item is MeetingActionItem => !!item);
}

function parseTopics (value: unknown): string[] {
  if (!Array.isArray (value)) return [];
  return value
    .map ((item) => (typeof item === 'string' ? item.trim () : ''))
    .filter ((item) => !!item);
}

export function rowToMeetingNote (row: MeetingNoteRow): MeetingNote {
  return {
    id: row.id,
    organizationId: row.organization_id,
    contactId: row.contact_id,
    calendarEventId: row.calendar_event_id,
    title: row.title,
    attendees: parseAttendees (row.attendees),
    scheduledAt: row.scheduled_at,
    agenda: row.agenda ?? '',
    rawNotes: row.raw_notes ?? '',
    manualNotes: row.manual_notes ?? '',
    transcript: row.transcript ?? '',
    topics: parseTopics (row.topics),
    transcriptDuration: Math.max (0, Number (row.transcript_duration ?? 0) || 0),
    actionItems: parseActionItems (row.action_items),
    decisions: row.decisions ?? '',
    summary: row.summary ?? '',
    status: row.status === 'complete' ? 'complete' : 'draft',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
