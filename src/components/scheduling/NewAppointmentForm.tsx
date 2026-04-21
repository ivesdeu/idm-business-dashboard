import { useEffect, useState, type FormEvent } from 'react';
import type { ClientOption, SchedulingAppointment } from '@/components/scheduling/types';

function isoToDateInput (iso: string): string {
  try {
    const d = new Date (iso);
    const y = d.getFullYear ();
    const m = String (d.getMonth () + 1).padStart (2, '0');
    const day = String (d.getDate ()).padStart (2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return '';
  }
}

function isoToTimeInput (iso: string): string {
  try {
    const d = new Date (iso);
    const h = String (d.getHours ()).padStart (2, '0');
    const m = String (d.getMinutes ()).padStart (2, '0');
    return `${h}:${m}`;
  } catch {
    return '';
  }
}

function combineLocalDateTime (dateStr: string, timeStr: string): string {
  const [y, mo, d] = dateStr.split ('-').map (Number);
  const [hh, mm] = timeStr.split (':').map (Number);
  const dt = new Date (y, mo - 1, d, hh || 0, mm || 0, 0, 0);
  return dt.toISOString ();
}

type Props = {
  clientOptions: ClientOption[];
  demoMode: boolean;
  initial: SchedulingAppointment | null;
  onSubmit: (payload: {
    title: string;
    clientId: string | null;
    startTime: string;
    endTime: string;
    location: string | null;
    notes: string | null;
    syncToGoogle: boolean;
  }) => Promise<void>;
  onCancelEdit: () => void;
};

export function NewAppointmentForm ({ clientOptions, demoMode, initial, onSubmit, onCancelEdit }: Props) {
  const [title, setTitle] = useState ('');
  const [clientId, setClientId] = useState<string> ('');
  const [dateStr, setDateStr] = useState (() => isoToDateInput (new Date ().toISOString ()));
  const [startT, setStartT] = useState ('09:00');
  const [endT, setEndT] = useState ('10:00');
  const [location, setLocation] = useState ('');
  const [notes, setNotes] = useState ('');
  const [syncToGoogle, setSyncToGoogle] = useState (false);
  const [submitting, setSubmitting] = useState (false);

  useEffect (() => {
    if (!initial) {
      setTitle ('');
      setClientId ('');
      setDateStr (isoToDateInput (new Date ().toISOString ()));
      setStartT ('09:00');
      setEndT ('10:00');
      setLocation ('');
      setNotes ('');
      setSyncToGoogle (false);
      return;
    }
    setTitle (initial.title);
    setClientId (initial.clientId ?? '');
    setDateStr (isoToDateInput (initial.startTime));
    setStartT (isoToTimeInput (initial.startTime));
    setEndT (isoToTimeInput (initial.endTime));
    setLocation (initial.location ?? '');
    setNotes (initial.notes ?? '');
    setSyncToGoogle (false);
  }, [initial]);

  async function handleSubmit (e: FormEvent) {
    e.preventDefault ();
    if (demoMode) return;
    setSubmitting (true);
    try {
      const startTime = combineLocalDateTime (dateStr, startT);
      const endTime = combineLocalDateTime (dateStr, endT);
      await onSubmit ({
        title: title.trim () || 'Untitled',
        clientId: clientId || null,
        startTime,
        endTime,
        location: location.trim () || null,
        notes: notes.trim () || null,
        syncToGoogle,
      });
      if (!initial) {
        setTitle ('');
        setClientId ('');
        setLocation ('');
        setNotes ('');
        setSyncToGoogle (false);
      }
    } finally {
      setSubmitting (false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit (e)} className="max-w-xl border border-[var(--sched-border,#e2e8f0)] bg-[var(--sched-surface,#fff)] p-6">
      {initial ? (
        <div className="mb-4 flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-[var(--sched-text,#0f172a)]">Edit appointment</h3>
          <button type="button" className="text-sm text-[var(--sched-accent)] hover:underline" onClick={onCancelEdit}>
            Clear
          </button>
        </div>
      ) : (
        <h3 className="mb-4 text-base font-semibold text-[var(--sched-text,#0f172a)]">New appointment</h3>
      )}

      {demoMode ? (
        <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          Sign in with a workspace to create and save appointments. Demo mode shows sample data only.
        </p>
      ) : null}

      <div className="space-y-4">
        <label className="block text-xs font-semibold uppercase text-[var(--sched-muted)]">
          Title
          <input
            className="mt-1 w-full rounded-lg border border-[var(--sched-border)] px-3 py-2 text-sm disabled:opacity-60"
            value={title}
            onChange={(e) => setTitle (e.target.value)}
            disabled={demoMode}
            required
          />
        </label>
        <label className="block text-xs font-semibold uppercase text-[var(--sched-muted)]">
          Client
          <select
            className="mt-1 w-full rounded-lg border border-[var(--sched-border)] px-3 py-2 text-sm disabled:opacity-60"
            value={clientId}
            onChange={(e) => setClientId (e.target.value)}
            disabled={demoMode}
          >
            <option value="">— Select client —</option>
            {clientOptions.map ((c) => (
              <option key={c.id || c.label} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-xs font-semibold uppercase text-[var(--sched-muted)]">
            Date
            <input
              type="date"
              className="mt-1 w-full rounded-lg border border-[var(--sched-border)] px-3 py-2 text-sm disabled:opacity-60"
              value={dateStr}
              onChange={(e) => setDateStr (e.target.value)}
              disabled={demoMode}
              required
            />
          </label>
          <label className="block text-xs font-semibold uppercase text-[var(--sched-muted)]">
            Start
            <input
              type="time"
              className="mt-1 w-full rounded-lg border border-[var(--sched-border)] px-3 py-2 text-sm disabled:opacity-60"
              value={startT}
              onChange={(e) => setStartT (e.target.value)}
              disabled={demoMode}
              required
            />
          </label>
          <label className="block text-xs font-semibold uppercase text-[var(--sched-muted)]">
            End
            <input
              type="time"
              className="mt-1 w-full rounded-lg border border-[var(--sched-border)] px-3 py-2 text-sm disabled:opacity-60"
              value={endT}
              onChange={(e) => setEndT (e.target.value)}
              disabled={demoMode}
              required
            />
          </label>
        </div>
        <label className="block text-xs font-semibold uppercase text-[var(--sched-muted)]">
          Location <span className="font-normal">(optional)</span>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--sched-border)] px-3 py-2 text-sm disabled:opacity-60"
            value={location}
            onChange={(e) => setLocation (e.target.value)}
            disabled={demoMode}
          />
        </label>
        <label className="block text-xs font-semibold uppercase text-[var(--sched-muted)]">
          Notes
          <textarea
            className="mt-1 w-full rounded-lg border border-[var(--sched-border)] px-3 py-2 text-sm disabled:opacity-60"
            rows={3}
            value={notes}
            onChange={(e) => setNotes (e.target.value)}
            disabled={demoMode}
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-[var(--sched-text)]">
          <input type="checkbox" checked={syncToGoogle} onChange={(e) => setSyncToGoogle (e.target.checked)} disabled={demoMode} />
          Sync to Google Calendar after save (stub)
        </label>
        <button
          type="submit"
          className="w-full rounded-lg bg-[var(--sched-accent,#0a0a0a)] py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          disabled={demoMode || submitting}
        >
          {submitting ? 'Saving…' : initial ? 'Update appointment' : 'Create appointment'}
        </button>
      </div>
    </form>
  );
}
