export type AppointmentStatus = 'confirmed' | 'pending' | 'cancelled';

export type MeetingNoteStatus = 'draft' | 'complete';

export type TranscriptionStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopped';

export type TranscriptChunk = {
  text: string;
  isFinal: boolean;
  receivedAt: number;
};

export type AssemblyAiStreamingMessage = {
  type?: string;
  transcript?: string;
  end_of_turn?: boolean;
  error?: string;
  id?: string;
  expires_at?: number;
};

export type MeetingActionItem = {
  task: string;
  owner: string;
  /** Resolved org-member UUID when AI is confident; null otherwise. */
  ownerUserId: string | null;
  dueDate: string | null;
  completed: boolean;
};

export type MeetingNoteAttendee = {
  email: string;
  name: string;
};

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: MeetingNoteAttendee[];
  description: string;
};

export type MeetingNote = {
  id: string;
  organizationId: string;
  contactId: string | null;
  calendarEventId: string | null;
  title: string;
  attendees: MeetingNoteAttendee[];
  scheduledAt: string | null;
  agenda: string;
  rawNotes: string;
  manualNotes: string;
  transcript: string;
  topics: string[];
  transcriptDuration: number;
  actionItems: MeetingActionItem[];
  decisions: string;
  summary: string;
  status: MeetingNoteStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Color category slugs for event pills. Map to design tokens in CalendarView.
 * `null` means "use the default accent" (existing behavior).
 */
export type AppointmentColor =
  | 'blue'
  | 'green'
  | 'red'
  | 'amber'
  | 'purple'
  | 'rose'
  | 'slate'
  | 'teal'
  | 'pink';

/** Unified row for calendar, list, and sync stubs. */
export type SchedulingAppointment = {
  id: string;
  title: string;
  clientName: string;
  clientId: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  notes: string | null;
  status: AppointmentStatus;
  googleCalendarEventId: string | null;
  syncedAt: string | null;
  color: AppointmentColor | null;
};

export type ClientOption = { id: string; label: string };

export type ToastKind = 'success' | 'error';

export type SchedulingToast = {
  id: string;
  kind: ToastKind;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};
