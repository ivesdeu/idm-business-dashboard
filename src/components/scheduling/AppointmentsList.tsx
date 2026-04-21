import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { SchedulingAppointment } from '@/components/scheduling/types';
import { SyncBadge } from '@/components/scheduling/SyncBadge';

type SortKey = 'date' | 'client' | 'title' | 'duration' | 'status';
type WhenFilter = 'all' | 'upcoming' | 'past';
type StatusFilter = 'all' | 'confirmed' | 'pending' | 'cancelled';

type Props = {
  appointments: SchedulingAppointment[];
  clientOptions: { id: string; label: string }[];
  onSelect: (a: SchedulingAppointment) => void;
  onEdit: (a: SchedulingAppointment) => void;
  onCancel: (a: SchedulingAppointment) => void;
  onSync: (a: SchedulingAppointment) => Promise<void>;
  syncLoadingId: string | null;
};

function durationLabel (start: string, end: string): string {
  try {
    const ms = new Date (end).getTime () - new Date (start).getTime ();
    if (ms <= 0) return '—';
    const m = Math.round (ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor (m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  } catch {
    return '—';
  }
}

function formatSlot (start: string): string {
  try {
    return new Date (start).toLocaleString (undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return start;
  }
}

export function AppointmentsList ({
  appointments,
  clientOptions,
  onSelect,
  onEdit,
  onCancel,
  onSync,
  syncLoadingId,
}: Props) {
  const [when, setWhen] = useState<WhenFilter> ('upcoming');
  const [statusF, setStatusF] = useState<StatusFilter> ('all');
  const [clientId, setClientId] = useState<string> ('');
  const [sortKey, setSortKey] = useState<SortKey> ('date');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'> ('asc');

  const filtered = useMemo (() => {
    const now = Date.now ();
    return appointments.filter ((a) => {
      const start = new Date (a.startTime).getTime ();
      if (when === 'upcoming' && start < now) return false;
      if (when === 'past' && start >= now) return false;
      if (statusF !== 'all' && a.status !== statusF) return false;
      if (clientId && a.clientId !== clientId) return false;
      return true;
    });
  }, [appointments, when, statusF, clientId]);

  const sorted = useMemo (() => {
    const arr = [...filtered];
    arr.sort ((x, y) => {
      let cmp = 0;
      if (sortKey === 'date') cmp = new Date (x.startTime).getTime () - new Date (y.startTime).getTime ();
      else if (sortKey === 'client') cmp = x.clientName.localeCompare (y.clientName);
      else if (sortKey === 'title') cmp = x.title.localeCompare (y.title);
      else if (sortKey === 'duration')
        cmp =
          new Date (x.endTime).getTime () -
          new Date (x.startTime).getTime () -
          (new Date (y.endTime).getTime () - new Date (y.startTime).getTime ());
      else cmp = x.status.localeCompare (y.status);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function toggleSort (k: SortKey) {
    if (sortKey === k) setSortDir ((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey (k);
      setSortDir ('asc');
    }
  }

  return (
    <div className="rounded-xl border border-[var(--sched-border,#e2e8f0)] bg-[var(--sched-surface,#fff)] shadow-sm">
      <div className="flex flex-wrap items-end gap-3 border-b border-[var(--sched-border)] p-4">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--sched-muted)]">
          When
          <select className="rounded-lg border border-[var(--sched-border)] bg-white px-2 py-1.5 text-sm" value={when} onChange={(e) => setWhen (e.target.value as WhenFilter)}>
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--sched-muted)]">
          Status
          <select className="rounded-lg border border-[var(--sched-border)] bg-white px-2 py-1.5 text-sm" value={statusF} onChange={(e) => setStatusF (e.target.value as StatusFilter)}>
            <option value="all">All</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--sched-muted)]">
          Client
          <select className="rounded-lg border border-[var(--sched-border)] bg-white px-2 py-1.5 text-sm" value={clientId} onChange={(e) => setClientId (e.target.value)}>
            <option value="">All clients</option>
            {clientOptions.map ((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--sched-border)] text-xs font-semibold uppercase text-[var(--sched-muted)]">
              <th className="cursor-pointer px-3 py-2 hover:bg-black/[0.02]" onClick={() => toggleSort ('date')}>
                Date / time {sortKey === 'date' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="cursor-pointer px-3 py-2 hover:bg-black/[0.02]" onClick={() => toggleSort ('client')}>
                Client {sortKey === 'client' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="cursor-pointer px-3 py-2 hover:bg-black/[0.02]" onClick={() => toggleSort ('title')}>
                Title / type {sortKey === 'title' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="cursor-pointer px-3 py-2 hover:bg-black/[0.02]" onClick={() => toggleSort ('duration')}>
                Duration {sortKey === 'duration' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="cursor-pointer px-3 py-2 hover:bg-black/[0.02]" onClick={() => toggleSort ('status')}>
                Status {sortKey === 'status' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="px-3 py-2">Sync</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map ((a) => (
              <tr key={a.id} className="border-b border-[var(--sched-border)] hover:bg-black/[0.02]">
                <td className="px-3 py-2.5 text-[var(--sched-text)]">
                  <button type="button" className="text-left font-medium text-[var(--sched-accent)] hover:underline" onClick={() => onSelect (a)}>
                    {formatSlot (a.startTime)}
                  </button>
                </td>
                <td className="px-3 py-2.5 text-[var(--sched-text)]">{a.clientName}</td>
                <td className="px-3 py-2.5 text-[var(--sched-text)]">{a.title}</td>
                <td className="px-3 py-2.5 text-[var(--sched-muted)]">{durationLabel (a.startTime, a.endTime)}</td>
                <td className="px-3 py-2.5 capitalize text-[var(--sched-text)]">{a.status}</td>
                <td className="px-3 py-2.5">
                  <SyncBadge synced={!!a.googleCalendarEventId} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" className="rounded-md border border-[var(--sched-border)] px-2 py-1 text-xs font-medium hover:bg-black/[0.03]" onClick={() => onEdit (a)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-[var(--sched-border)] px-2 py-1 text-xs font-medium hover:bg-black/[0.03]"
                      onClick={() => onCancel (a)}
                      disabled={a.status === 'cancelled'}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--sched-accent,#e8501a)] px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                      onClick={() => void onSync (a)}
                      disabled={syncLoadingId === a.id}
                    >
                      {syncLoadingId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      Sync
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length === 0 ? (
        <p className="p-8 text-center text-sm text-[var(--sched-muted)]">No appointments match these filters.</p>
      ) : null}
    </div>
  );
}
