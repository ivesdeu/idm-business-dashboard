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
    <form
      onSubmit={(e) => void handleSubmit (e)}
      className="card"
      style={{ maxWidth: '36rem' }}
    >
      {initial ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
          <div className="fst" style={{ marginTop: 0, marginBottom: 0 }}>
            Edit appointment
          </div>
          <button type="button" className="btn" style={{ fontSize: '12px', padding: '5px 12px' }} onClick={onCancelEdit}>
            Clear
          </button>
        </div>
      ) : (
        <div className="fst" style={{ marginTop: 0 }}>
          New appointment
        </div>
      )}

      {demoMode ? (
        <p
          style={{
            fontSize: '13px',
            color: 'var(--text2)',
            margin: '0 0 16px',
            padding: '10px 12px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--bg3)',
          }}
        >
          Sign in with a workspace to create and save appointments. Demo mode shows sample data only.
        </p>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div className="fgp">
          <span className="fl">Title</span>
          <input className="fi" value={title} onChange={(e) => setTitle (e.target.value)} disabled={demoMode} required />
        </div>
        <div className="fgp">
          <span className="fl">Client</span>
          <select className="fi" value={clientId} onChange={(e) => setClientId (e.target.value)} disabled={demoMode}>
            <option value="">— Select client —</option>
            {clientOptions.map ((c) => (
              <option key={c.id || c.label} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sched-form-grid-3">
          <div className="fgp">
            <span className="fl">Date</span>
            <input className="fi" type="date" value={dateStr} onChange={(e) => setDateStr (e.target.value)} disabled={demoMode} required />
          </div>
          <div className="fgp">
            <span className="fl">Start</span>
            <input className="fi" type="time" value={startT} onChange={(e) => setStartT (e.target.value)} disabled={demoMode} required />
          </div>
          <div className="fgp">
            <span className="fl">End</span>
            <input className="fi" type="time" value={endT} onChange={(e) => setEndT (e.target.value)} disabled={demoMode} required />
          </div>
        </div>
        <div className="fgp">
          <span className="fl">
            Location <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(optional)</span>
          </span>
          <input className="fi" value={location} onChange={(e) => setLocation (e.target.value)} disabled={demoMode} />
        </div>
        <div className="fgp">
          <span className="fl">Notes</span>
          <textarea className="fi" rows={3} value={notes} onChange={(e) => setNotes (e.target.value)} disabled={demoMode} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.875rem', color: 'var(--text2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={syncToGoogle} onChange={(e) => setSyncToGoogle (e.target.checked)} disabled={demoMode} />
          Sync to Google Calendar after save (stub)
        </label>
        <button type="submit" className="btn btn-p" style={{ width: '100%', marginTop: '4px' }} disabled={demoMode || submitting}>
          {submitting ? 'Saving…' : initial ? 'Update appointment' : 'Create appointment'}
        </button>
      </div>
    </form>
  );
}
