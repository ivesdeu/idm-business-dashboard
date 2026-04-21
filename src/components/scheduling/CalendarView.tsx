import { useMemo, useState } from 'react';
import type { SchedulingAppointment } from '@/components/scheduling/types';
import { SyncBadge } from '@/components/scheduling/SyncBadge';

type CalMode = 'month' | 'week';

type Props = {
  appointments: SchedulingAppointment[];
  onSelect: (a: SchedulingAppointment) => void;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeekMonday (d: Date): Date {
  const x = new Date (d);
  const day = x.getDay ();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate (x.getDate () + diff);
  x.setHours (0, 0, 0, 0);
  return x;
}

function sameLocalDay (iso: string, day: Date): boolean {
  const t = new Date (iso);
  return (
    t.getFullYear () === day.getFullYear () &&
    t.getMonth () === day.getMonth () &&
    t.getDate () === day.getDate ()
  );
}

function formatTime (iso: string): string {
  try {
    return new Date (iso).toLocaleTimeString (undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function statusTone (s: SchedulingAppointment['status']): string {
  if (s === 'confirmed') return 'border-l-emerald-500 bg-emerald-500/10';
  if (s === 'cancelled') return 'border-l-slate-400 bg-slate-500/10 opacity-75 line-through';
  return 'border-l-amber-500 bg-amber-500/10';
}

export function CalendarView ({ appointments, onSelect }: Props) {
  const [mode, setMode] = useState<CalMode> ('month');
  const [cursor, setCursor] = useState (() => new Date ());

  const label = useMemo (() => {
    return cursor.toLocaleDateString (undefined, { month: 'long', year: 'numeric' });
  }, [cursor]);

  const weekLabel = useMemo (() => {
    const start = startOfWeekMonday (cursor);
    const end = new Date (start);
    end.setDate (end.getDate () + 6);
    const a = start.toLocaleDateString (undefined, { month: 'short', day: 'numeric' });
    const b = end.toLocaleDateString (undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `${a} — ${b}`;
  }, [cursor]);

  const monthCells = useMemo (() => {
    const y = cursor.getFullYear ();
    const m = cursor.getMonth ();
    const first = new Date (y, m, 1);
    const lastDay = new Date (y, m + 1, 0).getDate ();
    const lead = (first.getDay () + 6) % 7;
    const cells: { date: Date; inMonth: boolean }[] = [];
    const padStart = new Date (first);
    padStart.setDate (1 - lead);
    for (let i = 0; i < lead; i++) {
      const d = new Date (padStart);
      d.setDate (padStart.getDate () + i);
      cells.push ({ date: d, inMonth: false });
    }
    for (let d = 1; d <= lastDay; d++) {
      cells.push ({ date: new Date (y, m, d), inMonth: true });
    }
    while (cells.length % 7 !== 0 || cells.length < 42) {
      const last = cells[cells.length - 1].date;
      const n = new Date (last);
      n.setDate (last.getDate () + 1);
      cells.push ({ date: n, inMonth: false });
    }
    return cells;
  }, [cursor]);

  const weekDays = useMemo (() => {
    const start = startOfWeekMonday (cursor);
    return Array.from ({ length: 7 }, (_, i) => {
      const d = new Date (start);
      d.setDate (start.getDate () + i);
      return d;
    });
  }, [cursor]);

  function appsForDay (day: Date): SchedulingAppointment[] {
    return appointments.filter ((a) => sameLocalDay (a.startTime, day));
  }

  return (
    <div className="rounded-xl border border-[var(--sched-border,#e2e8f0)] bg-[var(--sched-surface,#fff)] p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-[var(--sched-border)] px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]"
            onClick={() => {
              const n = new Date (cursor);
              if (mode === 'month') n.setMonth (n.getMonth () - 1);
              else n.setDate (n.getDate () - 7);
              setCursor (n);
            }}
          >
            Prev
          </button>
          <button
            type="button"
            className="rounded-lg border border-[var(--sched-border)] px-3 py-1.5 text-sm font-medium hover:bg-black/[0.03]"
            onClick={() => {
              const n = new Date (cursor);
              if (mode === 'month') n.setMonth (n.getMonth () + 1);
              else n.setDate (n.getDate () + 7);
              setCursor (n);
            }}
          >
            Next
          </button>
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--sched-accent,#e8501a)] hover:underline"
            onClick={() => setCursor (new Date ())}
          >
            Today
          </button>
        </div>
        <div className="text-center text-base font-semibold text-[var(--sched-text,#0f172a)]">{mode === 'month' ? label : weekLabel}</div>
        <div className="flex rounded-lg border border-[var(--sched-border)] p-0.5">
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === 'month' ? 'bg-[var(--sched-accent,#e8501a)] text-white' : 'hover:bg-black/[0.03]'}`}
            onClick={() => setMode ('month')}
          >
            Month
          </button>
          <button
            type="button"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${mode === 'week' ? 'bg-[var(--sched-accent,#e8501a)] text-white' : 'hover:bg-black/[0.03]'}`}
            onClick={() => setMode ('week')}
          >
            Week
          </button>
        </div>
      </div>

      {mode === 'month' ? (
        <>
          <div className="grid grid-cols-7 gap-px rounded-lg bg-[var(--sched-border)] text-xs font-semibold uppercase text-[var(--sched-muted)]">
            {WEEKDAYS.map ((w) => (
              <div key={w} className="bg-[var(--sched-surface)] px-2 py-2 text-center">
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px bg-[var(--sched-border)]">
            {monthCells.map ((cell, idx) => {
              const dayApps = appsForDay (cell.date);
              return (
                <div
                  key={idx}
                  className={`min-h-[100px] bg-[var(--sched-surface)] p-1.5 ${cell.inMonth ? '' : 'opacity-40'}`}
                >
                  <div className="mb-1 text-right text-xs font-medium text-[var(--sched-muted)]">{cell.date.getDate ()}</div>
                  <div className="flex max-h-[120px] flex-col gap-1 overflow-y-auto">
                    {dayApps.map ((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => onSelect (a)}
                        className={`truncate rounded border-l-[3px] px-1.5 py-1 text-left text-[11px] leading-tight ${statusTone (a.status)}`}
                      >
                        <span className="font-semibold text-[var(--sched-text)]">{formatTime (a.startTime)}</span>{' '}
                        <span className="text-[var(--sched-text)]">{a.title}</span>
                        <div className="truncate text-[10px] text-[var(--sched-muted)]">{a.clientName}</div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {weekDays.map ((day) => {
            const dayApps = appsForDay (day);
            return (
              <div key={day.toISOString ()} className="min-h-[280px] rounded-lg border border-[var(--sched-border)] bg-[var(--sched-surface)] p-2">
                <div className="mb-2 border-b border-[var(--sched-border)] pb-2 text-center text-xs font-semibold text-[var(--sched-muted)]">
                  <div>{WEEKDAYS[(day.getDay () + 6) % 7]}</div>
                  <div className="text-lg text-[var(--sched-text)]">{day.getDate ()}</div>
                </div>
                <div className="flex flex-col gap-2">
                  {dayApps.map ((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onSelect (a)}
                      className={`rounded border-l-[3px] p-2 text-left text-xs ${statusTone (a.status)}`}
                    >
                      <div className="font-semibold text-[var(--sched-text)]">
                        {formatTime (a.startTime)} – {formatTime (a.endTime)}
                      </div>
                      <div className="text-[var(--sched-text)]">{a.title}</div>
                      <div className="text-[10px] text-[var(--sched-muted)]">{a.clientName}</div>
                      <div className="mt-1">
                        <SyncBadge synced={!!a.googleCalendarEventId} />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
