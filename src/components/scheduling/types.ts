export type AppointmentStatus = 'confirmed' | 'pending' | 'cancelled';

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
