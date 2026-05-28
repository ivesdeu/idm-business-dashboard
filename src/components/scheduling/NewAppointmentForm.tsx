import { useEffect, useState, type FormEvent } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import type {
  AppointmentColor,
  ClientOption,
  SchedulingAppointment,
} from '@/components/scheduling/types';

type AppointmentColorPalette = {
  label: string;
  solid: string;
};

const FORM_APPOINTMENT_COLORS: { color: AppointmentColor; palette: AppointmentColorPalette }[] = [
  { color: 'blue', palette: { label: 'Blue', solid: '#3b82f6' } },
  { color: 'green', palette: { label: 'Green', solid: '#10b981' } },
  { color: 'amber', palette: { label: 'Amber', solid: '#f59e0b' } },
  { color: 'red', palette: { label: 'Red', solid: '#ef4444' } },
  { color: 'rose', palette: { label: 'Rose', solid: '#f43f5e' } },
  { color: 'pink', palette: { label: 'Pink', solid: '#ec4899' } },
  { color: 'purple', palette: { label: 'Purple', solid: '#8b5cf6' } },
  { color: 'teal', palette: { label: 'Teal', solid: '#14b8a6' } },
  { color: 'slate', palette: { label: 'Slate', solid: '#64748b' } },
];

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
    color: AppointmentColor | null;
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
  const [color, setColor] = useState<AppointmentColor | null> (null);
  const [syncToGoogle, setSyncToGoogle] = useState (false);
  const [submitting, setSubmitting] = useState (false);

  useEffect (() => {
    if (initial) {
      setTitle (initial.title);
      setClientId (initial.clientId ?? '');
      setDateStr (isoToDateInput (initial.startTime));
      setStartT (isoToTimeInput (initial.startTime));
      setEndT (isoToTimeInput (initial.endTime));
      setLocation (initial.location ?? '');
      setNotes (initial.notes ?? '');
      setColor (initial.color ?? null);
      setSyncToGoogle (false);
      return;
    }

    setTitle ('');
    setClientId ('');
    setDateStr (isoToDateInput (new Date ().toISOString ()));
    setStartT ('09:00');
    setEndT ('10:00');
    setLocation ('');
    setNotes ('');
    setColor (null);
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
        color,
        syncToGoogle,
      });
      if (!initial) {
        setTitle ('');
        setClientId ('');
        setLocation ('');
        setNotes ('');
        setColor (null);
        setSyncToGoogle (false);
      }
    } finally {
      setSubmitting (false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit (e)}
      className="card mx-auto w-full max-w-xl"
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
        <div className="fgp">
          <span className="fl">
            Color <span style={{ fontWeight: 400, color: 'var(--text3)' }}>(optional)</span>
          </span>
          <div
            role="radiogroup"
            aria-label="Event color"
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}
          >
            <button
              type="button"
              role="radio"
              aria-checked={color == null}
              aria-label="No color"
              onClick={() => setColor (null)}
              disabled={demoMode}
              title="No color"
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                border: `1px ${color == null ? 'solid' : 'dashed'} ${color == null ? 'var(--text)' : 'var(--border)'}`,
                padding: 0,
                background: 'var(--bg2)',
                color: 'var(--text3)',
                cursor: demoMode ? 'default' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 0,
              }}
            >
              <XMarkIcon style={{ width: 12, height: 12 }} aria-hidden />
            </button>
            {FORM_APPOINTMENT_COLORS.map (({ color: c, palette }) => {
              const selected = color === c;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={palette.label}
                  title={palette.label}
                  onClick={() => setColor (c)}
                  disabled={demoMode}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    border: selected ? '2px solid var(--text)' : '1px solid rgba(0,0,0,0.08)',
                    padding: 0,
                    background: palette.solid,
                    cursor: demoMode ? 'default' : 'pointer',
                    boxShadow: selected ? '0 0 0 2px rgba(0,0,0,0.08)' : 'none',
                  }}
                />
              );
            })}
          </div>
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
