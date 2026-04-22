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
    <div className="card">
      <div className="sched-appt-filters">
        <div className="spend-dd">
          <span className="spend-dd-lbl">When</span>
          <select className="fi" value={when} onChange={(e) => setWhen (e.target.value as WhenFilter)} title="When">
            <option value="upcoming">Upcoming</option>
            <option value="past">Past</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="spend-dd">
          <span className="spend-dd-lbl">Status</span>
          <select className="fi" value={statusF} onChange={(e) => setStatusF (e.target.value as StatusFilter)} title="Status">
            <option value="all">All</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="spend-dd">
          <span className="spend-dd-lbl">Client</span>
          <select className="fi" value={clientId} onChange={(e) => setClientId (e.target.value)} title="Client">
            <option value="">All clients</option>
            {clientOptions.map ((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="dt" style={{ minWidth: '720px' }}>
          <thead>
            <tr>
              <th className="th-sort" scope="col" onClick={() => toggleSort ('date')}>
                Date / time {sortKey === 'date' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="th-sort" scope="col" onClick={() => toggleSort ('client')}>
                Client {sortKey === 'client' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="th-sort" scope="col" onClick={() => toggleSort ('title')}>
                Title / type {sortKey === 'title' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="th-sort" scope="col" onClick={() => toggleSort ('duration')}>
                Duration {sortKey === 'duration' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th className="th-sort" scope="col" onClick={() => toggleSort ('status')}>
                Status {sortKey === 'status' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
              </th>
              <th scope="col">Sync</th>
              <th scope="col" style={{ width: '200px', textAlign: 'right' }}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map ((a) => (
              <tr key={a.id}>
                <td>
                  <button type="button" className="sched-link" onClick={() => onSelect (a)}>
                    {formatSlot (a.startTime)}
                  </button>
                </td>
                <td>{a.clientName}</td>
                <td>{a.title}</td>
                <td>{durationLabel (a.startTime, a.endTime)}</td>
                <td className="capitalize">{a.status}</td>
                <td>
                  <SyncBadge synced={!!a.googleCalendarEventId} />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div className="sched-appt-actions">
                    <button type="button" className="btn" style={{ fontSize: '12px', padding: '5px 12px' }} onClick={() => onEdit (a)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: '12px', padding: '5px 12px' }}
                      onClick={() => onCancel (a)}
                      disabled={a.status === 'cancelled'}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn btn-p"
                      style={{ fontSize: '12px', padding: '5px 12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                      onClick={() => void onSync (a)}
                      disabled={syncLoadingId === a.id}
                    >
                      {syncLoadingId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
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
        <p style={{ fontSize: '13px', color: 'var(--text3)', padding: '28px 8px', textAlign: 'center', margin: 0 }}>
          No appointments match these filters.
        </p>
      ) : null}
    </div>
  );
}
