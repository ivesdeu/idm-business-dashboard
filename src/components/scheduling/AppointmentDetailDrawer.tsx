import { X } from 'lucide-react';
import type { SchedulingAppointment } from '@/components/scheduling/types';
import { SyncBadge } from '@/components/scheduling/SyncBadge';

function formatRange (startIso: string, endIso: string): string {
  try {
    const s = new Date (startIso);
    const e = new Date (endIso);
    return `${s.toLocaleString (undefined, { dateStyle: 'medium', timeStyle: 'short' })} — ${e.toLocaleTimeString (undefined, { timeStyle: 'short' })}`;
  } catch {
    return `${startIso} — ${endIso}`;
  }
}

type Props = {
  appointment: SchedulingAppointment | null;
  onClose: () => void;
  onEdit?: (a: SchedulingAppointment) => void;
};

export function AppointmentDetailDrawer ({ appointment, onClose, onEdit }: Props) {
  if (!appointment) return null;

  return (
    <div className="fixed inset-0 z-[110] flex justify-end bg-black/25" role="presentation" onMouseDown={onClose}>
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-[var(--sched-border,#e2e8f0)] bg-[var(--sched-surface,#f8fafc)]"
        role="dialog"
        aria-labelledby="drawer-appt-title"
        onMouseDown={(e) => e.stopPropagation ()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--sched-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 id="drawer-appt-title" className="truncate text-lg font-semibold text-[var(--sched-text,#0f172a)]">
              {appointment.title}
            </h2>
            <p className="mt-1 text-sm text-[var(--sched-muted,#64748b)]">{appointment.clientName}</p>
          </div>
          <button type="button" className="shrink-0 rounded-md p-1 text-[var(--sched-muted)] hover:bg-black/5" aria-label="Close" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          <div className="mb-4">
            <SyncBadge synced={!!appointment.googleCalendarEventId} />
          </div>
          <dl className="space-y-3">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--sched-muted)]">When</dt>
              <dd className="mt-0.5 text-[var(--sched-text)]">{formatRange (appointment.startTime, appointment.endTime)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--sched-muted)]">Status</dt>
              <dd className="mt-0.5 capitalize text-[var(--sched-text)]">{appointment.status}</dd>
            </div>
            {appointment.location ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--sched-muted)]">Location</dt>
                <dd className="mt-0.5 text-[var(--sched-text)]">{appointment.location}</dd>
              </div>
            ) : null}
            {appointment.notes ? (
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--sched-muted)]">Notes</dt>
                <dd className="mt-0.5 whitespace-pre-wrap text-[var(--sched-text)]">{appointment.notes}</dd>
              </div>
            ) : null}
          </dl>
        </div>
        {onEdit ? (
          <div className="border-t border-[var(--sched-border)] px-5 py-4">
            <button
              type="button"
              className="btn"
              style={{ width: '100%' }}
              onClick={() => {
                onEdit (appointment);
                onClose ();
              }}
            >
              Edit in form
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
