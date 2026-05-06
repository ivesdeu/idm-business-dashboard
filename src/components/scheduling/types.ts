export type AppointmentStatus = 'confirmed' | 'pending' | 'cancelled';

export type MeetingNoteStatus = 'draft' | 'complete';

export type TranscriptionStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopped';

export type TranscriptChunk = {
  text: string;
  isFinal: boolean;
  receivedAt: number;
};

export type DeepgramWord = {
  word: string;
  confidence?: number;
  start?: number;
  end?: number;
  speaker?: number;
  punctuated_word?: string;
};

export type DeepgramAlternative = {
  transcript: string;
  confidence?: number;
  words?: DeepgramWord[];
};

export type DeepgramResultsMessage = {
  type?: 'Results';
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: DeepgramAlternative[] };
};

export type DeepgramUtteranceEndMessage = {
  type: 'UtteranceEnd';
};

export type DeepgramMetadataMessage = {
  type: 'Metadata';
};

export type DeepgramErrorMessage = {
  type: 'Error';
  description?: string;
  message?: string;
};

export type DeepgramMessage =
  | DeepgramResultsMessage
  | DeepgramUtteranceEndMessage
  | DeepgramMetadataMessage
  | DeepgramErrorMessage
  | Record<string, unknown>;

export type MeetingActionItem = {
  task: string;
  owner: string;
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
