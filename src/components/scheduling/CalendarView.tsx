import { useMemo, useState } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';
import { Bell, CalendarDays, ChevronLeft, ChevronRight, Clock3, Link2, MapPin, UserRound, X } from 'lucide-react';
import type { SchedulingAppointment } from '@/components/scheduling/types';

type CalMode = 'month' | 'week';

type Props = {
  appointments: SchedulingAppointment[];
  onSelect: (a: SchedulingAppointment) => void;
  onCreateAppointment?: (payload: {
    title: string;
    clientId: string | null;
    startTime: string;
    endTime: string;
    location: string | null;
    notes: string | null;
    syncToGoogle: boolean;
  }) => Promise<void>;
};

type PreviewState = {
  appointment: SchedulingAppointment;
  left: number;
  top: number;
};

type QuickCreateState = {
  startTime: string;
  endTime: string;
  left: number;
  top: number;
};

type DragState = {
  dayIndex: number;
  anchorMinute: number;
  currentMinute: number;
  moved: boolean;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEK_HOURS = Array.from ({ length: 16 }, (_, i) => i + 8);
const HOUR_HEIGHT = 56;
const WEEK_GUTTER_WIDTH = 56;
const SNAP_MINUTES = 15;
const MIN_SELECTION_MINUTES = 30;

function startOfWeekSunday (d: Date): Date {
  const x = new Date (d);
  x.setDate (x.getDate () - x.getDay ());
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

function isTodayLocal (day: Date): boolean {
  const now = new Date ();
  return (
    now.getFullYear () === day.getFullYear () &&
    now.getMonth () === day.getMonth () &&
    now.getDate () === day.getDate ()
  );
}

function formatTime (iso: string): string {
  try {
    return new Date (iso)
      .toLocaleTimeString (undefined, { hour: 'numeric', minute: '2-digit' })
      .replace (' ', ' ');
  } catch {
    return '';
  }
}

function formatDateLine (iso: string): string {
  try {
    return new Date (iso).toLocaleDateString (undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function formatDuration (startIso: string, endIso: string): string {
  const start = new Date (startIso).getTime ();
  const end = new Date (endIso).getTime ();
  const minutes = Math.max (0, Math.round ((end - start) / 60000));
  if (!minutes) return '';
  if (minutes < 60) return `${minutes}min`;
  var hours = Math.floor (minutes / 60);
  var rem = minutes % 60;
  return rem ? `${hours}h ${rem}min` : `${hours}h`;
}

function formatHourLabel (hour: number): string {
  if (hour === 12) return '12 PM';
  if (hour > 12) return `${hour - 12} PM`;
  return `${hour} AM`;
}

function minutesFromWeekStart (iso: string): number {
  const d = new Date (iso);
  return d.getHours () * 60 + d.getMinutes ();
}

function snapMinute (minute: number): number {
  return Math.round (minute / SNAP_MINUTES) * SNAP_MINUTES;
}

function dateWithMinute (day: Date, minute: number): string {
  const d = new Date (day);
  d.setHours (Math.floor (minute / 60), minute % 60, 0, 0);
  return d.toISOString ();
}

function isAllDayAppointment (a: SchedulingAppointment): boolean {
  const start = new Date (a.startTime);
  const end = new Date (a.endTime);
  const durationHours = (end.getTime () - start.getTime ()) / 3600000;
  return start.getHours () === 0 && start.getMinutes () === 0 && durationHours >= 20;
}

function clamp (value: number, min: number, max: number): number {
  return Math.max (min, Math.min (max, value));
}

function statusPillStyle (s: SchedulingAppointment['status']): CSSProperties {
  if (s === 'confirmed') {
    return { background: 'var(--green-bg)', color: 'var(--green)' };
  }
  if (s === 'cancelled') {
    return { background: 'var(--bg3)', color: 'var(--text3)', textDecoration: 'line-through' };
  }
  return { background: 'var(--neutral-bg)', color: 'var(--text2)' };
}

export function CalendarView ({ appointments, onCreateAppointment }: Props) {
  const [mode, setMode] = useState<CalMode> ('month');
  const [cursor, setCursor] = useState (() => new Date ());
  const [preview, setPreview] = useState<PreviewState | null> (null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null> (null);

  const monthYearLabel = useMemo (() => {
    return cursor.toLocaleDateString (undefined, { month: 'long', year: 'numeric' });
  }, [cursor]);

  const weekLabel = useMemo (() => {
    const start = startOfWeekSunday (cursor);
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
    const lead = first.getDay ();
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
    const start = startOfWeekSunday (cursor);
    return Array.from ({ length: 7 }, (_, i) => {
      const d = new Date (start);
      d.setDate (start.getDate () + i);
      return d;
    });
  }, [cursor]);

  function appsForDay (day: Date): SchedulingAppointment[] {
    return appointments
      .filter ((a) => sameLocalDay (a.startTime, day))
      .sort ((a, b) => new Date (a.startTime).getTime () - new Date (b.startTime).getTime ());
  }

  function timedAppsForDay (day: Date): SchedulingAppointment[] {
    return appsForDay (day).filter ((a) => !isAllDayAppointment (a));
  }

  function allDayAppsForDay (day: Date): SchedulingAppointment[] {
    return appsForDay (day).filter (isAllDayAppointment);
  }

  function openPreview (appointment: SchedulingAppointment, event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation ();
    const rect = event.currentTarget.getBoundingClientRect ();
    const width = 360;
    const left = clamp (rect.left + rect.width / 2 - width / 2, 16, window.innerWidth - width - 16);
    const estimatedHeight = Math.min (520, window.innerHeight - 32);
    const top = clamp (rect.top + 18, 16, Math.max (16, window.innerHeight - estimatedHeight - 16));
    setPreview ({ appointment, left, top });
    setQuickCreate (null);
  }

  function openQuickCreate (range: { startTime: string; endTime: string }, anchor: { x: number; y: number }) {
    const width = 360;
    const estimatedHeight = Math.min (620, window.innerHeight - 32);
    setPreview (null);
    setQuickCreate ({
      ...range,
      left: clamp (anchor.x - width / 2, 16, window.innerWidth - width - 16),
      top: clamp (anchor.y - 96, 16, Math.max (16, window.innerHeight - estimatedHeight - 16)),
    });
  }

  function goPrev () {
    const n = new Date (cursor);
    if (mode === 'month') n.setMonth (n.getMonth () - 1);
    else n.setDate (n.getDate () - 7);
    setCursor (n);
  }

  function goNext () {
    const n = new Date (cursor);
    if (mode === 'month') n.setMonth (n.getMonth () + 1);
    else n.setDate (n.getDate () + 7);
    setCursor (n);
  }

  // Notion-style tokens (resolved from app shell vars in scheduling-island.css)
  const surface = 'var(--bg2, #ffffff)';
  const muted = 'var(--text3, #a1a1aa)';
  const text = 'var(--text, #0a0a0a)';
  const hairline = 'var(--border, rgba(0,0,0,0.06))';

  const ghostBtn: CSSProperties = {
    background: 'transparent',
    border: '1px solid transparent',
    color: text,
    fontSize: '13px',
    fontWeight: 500,
    padding: '4px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    lineHeight: 1.2,
  };

  const iconBtn: CSSProperties = {
    ...ghostBtn,
    padding: '4px 6px',
    color: muted,
  };

  const segmentBtn = (active: boolean): CSSProperties => ({
    background: active ? 'var(--bg3)' : 'transparent',
    border: '1px solid transparent',
    color: active ? text : muted,
    fontSize: '12px',
    fontWeight: 500,
    padding: '4px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    lineHeight: 1.2,
  });

  return (
    <div
      onMouseDown={() => {
        if (preview) setPreview (null);
        if (quickCreate) setQuickCreate (null);
      }}
      style={{
        background: surface,
        borderRadius: '10px',
        border: `1px solid ${hairline}`,
        overflow: 'hidden',
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px 10px',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ fontSize: '20px', fontWeight: 700, color: text, letterSpacing: '-0.01em' }}>
          {mode === 'month' ? monthYearLabel : weekLabel}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <div
            role="group"
            aria-label="Calendar scale"
            style={{
              display: 'inline-flex',
              padding: '2px',
              background: 'var(--bg3)',
              borderRadius: '8px',
            }}
          >
            <button type="button" style={segmentBtn (mode === 'month')} onClick={() => setMode ('month')}>
              Month
            </button>
            <button type="button" style={segmentBtn (mode === 'week')} onClick={() => setMode ('week')}>
              Week
            </button>
          </div>
          <button type="button" style={ghostBtn} onClick={() => setCursor (new Date ())}>
            Today
          </button>
          <div style={{ display: 'inline-flex', gap: '2px' }}>
            <button type="button" aria-label="Previous" style={iconBtn} onClick={goPrev}>
              <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
            <button type="button" aria-label="Next" style={iconBtn} onClick={goNext}>
              <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* Weekday header */}
      {mode === 'month' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            borderTop: `1px solid ${hairline}`,
            borderBottom: `1px solid ${hairline}`,
          }}
        >
          {WEEKDAYS.map ((w) => (
            <div
              key={w}
              style={{
                padding: '8px 12px',
                fontSize: '12px',
                fontWeight: 500,
                color: muted,
                textAlign: 'left',
              }}
            >
              {w}
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `${WEEK_GUTTER_WIDTH}px repeat(7, minmax(0, 1fr))`,
            borderTop: `1px solid ${hairline}`,
            borderBottom: `1px solid ${hairline}`,
          }}
        >
          <div style={{ borderRight: `1px solid ${hairline}` }} />
          {weekDays.map ((day, idx) => {
            const today = isTodayLocal (day);
            return (
              <div
                key={day.toISOString ()}
                style={{
                  padding: '8px 8px 7px',
                  borderRight: idx < 6 ? `1px solid ${hairline}` : 'none',
                  textAlign: 'center',
                  color: muted,
                }}
              >
                <div style={{ fontSize: '11px', fontWeight: 500 }}>{WEEKDAYS[day.getDay ()]}</div>
                <div style={{ marginTop: '2px', fontSize: '11px', fontWeight: 500 }}>
                  {today ? (
                    <span
                      aria-label="Today"
                      style={{
                        display: 'inline-flex',
                        minWidth: '19px',
                        height: '18px',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        background: 'var(--red)',
                        color: '#fff',
                        fontWeight: 700,
                      }}
                    >
                      {day.getDate ()}
                    </span>
                  ) : (
                    <span>{MONTHS_SHORT[day.getMonth ()]} {day.getDate ()}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mode === 'month' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            gridAutoRows: 'minmax(120px, 1fr)',
          }}
        >
          {monthCells.map ((cell, idx) => {
            const dayApps = appsForDay (cell.date);
            const today = isTodayLocal (cell.date);
            const isFirstOfMonth = cell.date.getDate () === 1;
            const col = idx % 7;
            const row = Math.floor (idx / 7);
            const cellStyle: CSSProperties = {
              background: surface,
              padding: '8px 10px',
              minHeight: '120px',
              borderRight: col < 6 ? `1px solid ${hairline}` : 'none',
              borderBottom: row < 5 ? `1px solid ${hairline}` : 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              overflow: 'hidden',
            };
            const numColor = cell.inMonth ? (today ? '#ffffff' : text) : muted;
            const numWeight = today ? 600 : 500;

            return (
              <div key={idx} style={cellStyle}>
                <div style={{ display: 'flex', alignItems: 'center', minHeight: '22px' }}>
                  {today ? (
                    <span
                      aria-label="Today"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--red)',
                        color: numColor,
                        minWidth: '22px',
                        height: '22px',
                        padding: '0 6px',
                        borderRadius: '5px',
                        fontSize: '12px',
                        fontWeight: 600,
                      }}
                    >
                      {isFirstOfMonth ? `${MONTHS_SHORT[cell.date.getMonth ()]} 1` : cell.date.getDate ()}
                    </span>
                  ) : (
                    <span
                      style={{
                        fontSize: '12px',
                        fontWeight: numWeight,
                        color: numColor,
                        opacity: cell.inMonth ? 1 : 0.55,
                      }}
                    >
                      {isFirstOfMonth ? `${MONTHS_SHORT[cell.date.getMonth ()]} 1` : cell.date.getDate ()}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', overflow: 'hidden' }}>
                  {dayApps.slice (0, 3).map ((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={(e) => openPreview (a, e)}
                      style={{
                        textAlign: 'left',
                        border: 'none',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '11px',
                        fontWeight: 500,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        cursor: 'pointer',
                        lineHeight: 1.4,
                        ...statusPillStyle (a.status),
                      }}
                    >
                      <span style={{ opacity: 0.75, marginRight: '4px' }}>{formatTime (a.startTime)}</span>
                      {a.title}
                    </button>
                  ))}
                  {dayApps.length > 3 ? (
                    <div style={{ fontSize: '10px', color: muted, padding: '0 6px' }}>
                      +{dayApps.length - 3} more
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <WeekTimeGrid
          weekDays={weekDays}
          appointments={appointments}
          onCreateRange={onCreateAppointment ? openQuickCreate : undefined}
          openPreview={openPreview}
          surface={surface}
          text={text}
          muted={muted}
          hairline={hairline}
        />
      )}

      {preview ? (
        <EventPreview
          preview={preview}
          onClose={() => setPreview (null)}
          text={text}
          muted={muted}
          hairline={hairline}
        />
      ) : null}

      {quickCreate && onCreateAppointment ? (
        <QuickCreatePopover
          range={quickCreate}
          text={text}
          muted={muted}
          hairline={hairline}
          onClose={() => setQuickCreate (null)}
          onCreate={async (payload) => {
            await onCreateAppointment (payload);
            setQuickCreate (null);
          }}
        />
      ) : null}
    </div>
  );
}

function WeekTimeGrid ({
  weekDays,
  appointments,
  onCreateRange,
  openPreview,
  surface,
  text,
  muted,
  hairline,
}: {
  weekDays: Date[];
  appointments: SchedulingAppointment[];
  onCreateRange?: (range: { startTime: string; endTime: string }, anchor: { x: number; y: number }) => void;
  openPreview: (appointment: SchedulingAppointment, event: MouseEvent<HTMLButtonElement>) => void;
  surface: string;
  text: string;
  muted: string;
  hairline: string;
}) {
  const now = new Date ();
  const firstHour = WEEK_HOURS[0];
  const lastMinute = (WEEK_HOURS[WEEK_HOURS.length - 1] + 1) * 60;
  const gridHeight = WEEK_HOURS.length * HOUR_HEIGHT;
  const nowMinute = now.getHours () * 60 + now.getMinutes ();
  const nowTop = ((nowMinute - firstHour * 60) / 60) * HOUR_HEIGHT;
  const showNowLine = nowMinute >= firstHour * 60 && nowMinute <= lastMinute;
  const [drag, setDrag] = useState<DragState | null> (null);

  function dayAppointments (day: Date): SchedulingAppointment[] {
    return appointments
      .filter ((a) => sameLocalDay (a.startTime, day))
      .sort ((a, b) => new Date (a.startTime).getTime () - new Date (b.startTime).getTime ());
  }

  function allDayAppointments (day: Date): SchedulingAppointment[] {
    return dayAppointments (day).filter (isAllDayAppointment);
  }

  function timedAppointments (day: Date): SchedulingAppointment[] {
    return dayAppointments (day).filter ((a) => !isAllDayAppointment (a));
  }

  function timedStyle (a: SchedulingAppointment): CSSProperties {
    if (a.status === 'cancelled') {
      return { background: 'rgba(228,228,231,0.55)', color: muted, borderLeft: '3px solid var(--text3)', textDecoration: 'line-through' };
    }
    return { background: 'rgba(56,189,248,0.18)', color: '#23637b', borderLeft: '3px solid #38bdf8' };
  }

  function eventPosition (a: SchedulingAppointment): CSSProperties {
    const start = minutesFromWeekStart (a.startTime);
    const end = Math.max (start + 30, minutesFromWeekStart (a.endTime));
    const clippedStart = clamp (start, firstHour * 60, lastMinute);
    const clippedEnd = clamp (end, firstHour * 60, lastMinute);
    const top = ((clippedStart - firstHour * 60) / 60) * HOUR_HEIGHT;
    const height = Math.max (28, ((clippedEnd - clippedStart) / 60) * HOUR_HEIGHT);
    return {
      position: 'absolute',
      top,
      left: '4px',
      right: '4px',
      height,
    };
  }

  function minuteFromPointer (event: PointerEvent<HTMLDivElement>): number {
    const rect = event.currentTarget.getBoundingClientRect ();
    const y = clamp (event.clientY - rect.top, 0, gridHeight);
    return clamp (snapMinute (firstHour * 60 + (y / HOUR_HEIGHT) * 60), firstHour * 60, lastMinute);
  }

  function selectionPosition (startMinute: number, endMinute: number): CSSProperties {
    const top = ((startMinute - firstHour * 60) / 60) * HOUR_HEIGHT;
    const height = Math.max (14, ((endMinute - startMinute) / 60) * HOUR_HEIGHT);
    return {
      position: 'absolute',
      top,
      left: '4px',
      right: '4px',
      height,
    };
  }

  function handlePointerDown (dayIndex: number, event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !onCreateRange) return;
    const minute = minuteFromPointer (event);
    event.currentTarget.setPointerCapture (event.pointerId);
    setDrag ({ dayIndex, anchorMinute: minute, currentMinute: minute, moved: false });
  }

  function handlePointerMove (dayIndex: number, event: PointerEvent<HTMLDivElement>) {
    const minute = minuteFromPointer (event);
    setDrag ((current) => {
      if (!current || current.dayIndex !== dayIndex) return current;
      const nextMoved = current.moved || Math.abs (minute - current.anchorMinute) >= SNAP_MINUTES;
      return {
        ...current,
        currentMinute: minute,
        moved: nextMoved,
      };
    });
  }

  function handlePointerUp (day: Date, dayIndex: number, event: PointerEvent<HTMLDivElement>) {
    if (drag?.dayIndex !== dayIndex) return;
    if (event.currentTarget.hasPointerCapture (event.pointerId)) {
      event.currentTarget.releasePointerCapture (event.pointerId);
    }
    const startMinute = Math.min (drag.anchorMinute, drag.currentMinute);
    var endMinute = Math.max (drag.anchorMinute, drag.currentMinute);
    if (drag.moved && endMinute - startMinute < MIN_SELECTION_MINUTES) {
      endMinute = clamp (startMinute + MIN_SELECTION_MINUTES, firstHour * 60, lastMinute);
    }
    setDrag (null);
    if (!drag.moved || endMinute <= startMinute || !onCreateRange) return;
    onCreateRange ({
      startTime: dateWithMinute (day, startMinute),
      endTime: dateWithMinute (day, endMinute),
    }, {
      x: event.clientX,
      y: event.clientY,
    });
  }

  function handlePointerCancel (dayIndex: number, event: PointerEvent<HTMLDivElement>) {
    if (drag?.dayIndex !== dayIndex) return;
    if (event.currentTarget.hasPointerCapture (event.pointerId)) {
      event.currentTarget.releasePointerCapture (event.pointerId);
    }
    setDrag (null);
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${WEEK_GUTTER_WIDTH}px repeat(7, minmax(132px, 1fr))`,
          minWidth: '980px',
          borderBottom: `1px solid ${hairline}`,
        }}
      >
        <div
          style={{
            minHeight: '42px',
            padding: '5px 8px',
            borderRight: `1px solid ${hairline}`,
            color: muted,
            fontSize: '10px',
            lineHeight: 1.4,
          }}
        >
          <div>+ GMT</div>
          <div style={{ marginTop: '7px' }}>All-day</div>
        </div>
        {weekDays.map ((day, idx) => (
          <div
            key={`all-day-${day.toISOString ()}`}
            style={{
              minHeight: '42px',
              padding: '6px 4px',
              borderRight: idx < 6 ? `1px solid ${hairline}` : 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
            }}
          >
            {allDayAppointments (day).slice (0, 2).map ((a) => (
              <button
                key={a.id}
                type="button"
                onPointerDown={(e) => e.stopPropagation ()}
                onClick={(e) => openPreview (a, e)}
                style={{
                  border: 'none',
                  borderRadius: '4px',
                  background: 'rgba(34,197,94,0.2)',
                  color: '#2f7d48',
                  cursor: 'pointer',
                  fontSize: '10px',
                  fontWeight: 500,
                  lineHeight: 1.3,
                  overflow: 'hidden',
                  padding: '2px 5px',
                  textAlign: 'left',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {a.title}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${WEEK_GUTTER_WIDTH}px repeat(7, minmax(132px, 1fr))`,
          minWidth: '980px',
          background: surface,
        }}
      >
        <div style={{ position: 'relative', height: gridHeight, borderRight: `1px solid ${hairline}` }}>
          {WEEK_HOURS.map ((hour, idx) => (
            <div
              key={hour}
              style={{
                position: 'absolute',
                top: idx * HOUR_HEIGHT - 7,
                right: '8px',
                color: muted,
                fontSize: '10px',
                lineHeight: 1,
              }}
            >
              {formatHourLabel (hour)}
            </div>
          ))}
          {showNowLine && weekDays.some (isTodayLocal) ? (
            <div
              style={{
                position: 'absolute',
                top: nowTop - 8,
                right: '3px',
                borderRadius: '3px',
                background: 'var(--red)',
                color: '#fff',
                fontSize: '9px',
                fontWeight: 700,
                lineHeight: '14px',
                padding: '0 3px',
              }}
            >
              {formatTime (now.toISOString ())}
            </div>
          ) : null}
        </div>

        {weekDays.map ((day, idx) => {
          const today = isTodayLocal (day);
          return (
            <div
              key={`timed-${day.toISOString ()}`}
              onPointerDown={(e) => handlePointerDown (idx, e)}
              onPointerMove={(e) => handlePointerMove (idx, e)}
              onPointerUp={(e) => handlePointerUp (day, idx, e)}
              onPointerCancel={(e) => handlePointerCancel (idx, e)}
              style={{
                position: 'relative',
                height: gridHeight,
                borderRight: idx < 6 ? `1px solid ${hairline}` : 'none',
                background: today ? 'rgba(250,250,250,0.62)' : surface,
              }}
            >
              {WEEK_HOURS.map ((hour, hourIdx) => (
                <div
                  key={hour}
                  style={{
                    position: 'absolute',
                    top: hourIdx * HOUR_HEIGHT,
                    left: 0,
                    right: 0,
                    borderTop: `1px solid ${hairline}`,
                  }}
                />
              ))}

              {today && showNowLine ? (
                <div
                  aria-label="Current time"
                  style={{
                    position: 'absolute',
                    top: nowTop,
                    left: 0,
                    right: 0,
                    height: '1px',
                    background: 'var(--red)',
                    zIndex: 2,
                  }}
                />
              ) : null}

              {drag && drag.dayIndex === idx && drag.moved ? (
                <div
                  aria-hidden
                  style={{
                    ...selectionPosition (Math.min (drag.anchorMinute, drag.currentMinute), Math.max (drag.anchorMinute, drag.currentMinute)),
                    background: 'rgba(56,189,248,0.12)',
                    borderLeft: '3px solid #38bdf8',
                    borderRadius: '5px',
                    outline: '1px dashed rgba(56,189,248,0.42)',
                    zIndex: 4,
                    pointerEvents: 'none',
                  }}
                />
              ) : null}

              {timedAppointments (day).map ((a) => (
                <button
                  key={a.id}
                  type="button"
                  onPointerDown={(e) => e.stopPropagation ()}
                  onClick={(e) => openPreview (a, e)}
                  style={{
                    ...eventPosition (a),
                    ...timedStyle (a),
                    borderTop: 'none',
                    borderRight: 'none',
                    borderBottom: 'none',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    fontSize: '10px',
                    fontWeight: 600,
                    lineHeight: 1.25,
                    overflow: 'hidden',
                    padding: '6px 7px',
                    textAlign: 'left',
                    zIndex: 3,
                  }}
                >
                  <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.title}</div>
                  <div style={{ marginTop: '2px', opacity: 0.75 }}>{formatTime (a.startTime)}–{formatTime (a.endTime)}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuickCreatePopover ({
  range,
  onClose,
  onCreate,
  text,
  muted,
  hairline,
}: {
  range: QuickCreateState;
  onClose: () => void;
  onCreate: (payload: {
    title: string;
    clientId: string | null;
    startTime: string;
    endTime: string;
    location: string | null;
    notes: string | null;
    syncToGoogle: boolean;
  }) => Promise<void>;
  text: string;
  muted: string;
  hairline: string;
}) {
  const [title, setTitle] = useState ('');
  const [location, setLocation] = useState ('');
  const [notes, setNotes] = useState ('');
  const [saving, setSaving] = useState (false);
  const duration = formatDuration (range.startTime, range.endTime);
  const iconStyle: CSSProperties = {
    width: '18px',
    height: '18px',
    color: 'rgba(0,0,0,0.24)',
    marginTop: '2px',
  };
  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '24px 1fr',
    gap: '12px',
    alignItems: 'start',
  };
  const placeholderStyle: CSSProperties = {
    color: 'rgba(0,0,0,0.33)',
    fontSize: '15px',
    lineHeight: 1.35,
  };

  async function save () {
    setSaving (true);
    try {
      await onCreate ({
        title: title.trim () || 'Untitled',
        clientId: null,
        startTime: range.startTime,
        endTime: range.endTime,
        location: location.trim () || null,
        notes: notes.trim () || null,
        syncToGoogle: false,
      });
    } finally {
      setSaving (false);
    }
  }

  return (
    <form
      role="dialog"
      aria-label="Create event"
      onSubmit={(e) => {
        e.preventDefault ();
        void save ();
      }}
      onMouseDown={(e) => e.stopPropagation ()}
      style={{
        position: 'fixed',
        zIndex: 155,
        left: range.left,
        top: range.top,
        width: '360px',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: `calc(100vh - ${range.top + 16}px)`,
        overflow: 'auto',
        background: 'rgba(255,255,255,0.98)',
        border: `1px solid ${hairline}`,
        borderRadius: '16px',
        boxShadow: '0 22px 70px rgba(15,23,42,0.18), 0 4px 18px rgba(15,23,42,0.08)',
        color: text,
        transformOrigin: 'top center',
        animation: 'calendarQuickCreateIn 150ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '17px', fontWeight: 600 }}>
          Event
          <ChevronRight style={{ width: '14px', height: '14px', color: muted, transform: 'rotate(90deg)' }} aria-hidden />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              border: 'none',
              borderRadius: '7px',
              background: 'var(--text)',
              color: 'var(--bg2)',
              cursor: saving ? 'default' : 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              opacity: saving ? 0.65 : 1,
              padding: '5px 10px',
            }}
          >
            {saving ? 'Saving' : 'Save'}
          </button>
          <button
            type="button"
            aria-label="Close event creator"
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', color: muted, cursor: 'pointer', padding: 0, lineHeight: 0 }}
          >
            <X className="h-5 w-5" strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      </div>

      <div style={{ padding: '0 18px 16px' }}>
        <input
          autoFocus
          aria-label="Event title"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle (e.target.value)}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            borderRadius: '8px',
            background: 'rgba(0,0,0,0.045)',
            color: text,
            fontSize: '18px',
            fontWeight: 500,
            padding: '10px 12px',
          }}
        />
      </div>

      <div style={{ borderTop: `1px solid ${hairline}`, padding: '18px', display: 'grid', gap: '14px' }}>
        <div style={rowStyle}>
          <Clock3 style={iconStyle} strokeWidth={1.8} aria-hidden />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '17px' }}>
              <span>{formatTime (range.startTime)}</span>
              <span style={{ color: 'rgba(0,0,0,0.25)' }}>→</span>
              <span>{formatTime (range.endTime)}</span>
              {duration ? <span style={{ color: muted, fontSize: '14px' }}>{duration}</span> : null}
            </div>
            <div style={{ marginTop: '10px', fontSize: '15px' }}>{formatDateLine (range.startTime)}</div>
            <div style={{ display: 'flex', gap: '22px', marginTop: '18px', ...placeholderStyle }}>
              <span>All-day</span>
              <span>Time zone</span>
              <span>Repeat</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${hairline}`, padding: '18px', display: 'grid', gap: '16px' }}>
        <div style={rowStyle}>
          <UserRound style={iconStyle} strokeWidth={1.8} aria-hidden />
          <div style={placeholderStyle}>Participants</div>
        </div>
        <div style={rowStyle}>
          <CalendarDays style={iconStyle} strokeWidth={1.8} aria-hidden />
          <div style={placeholderStyle}>Conferencing</div>
        </div>
        <div style={rowStyle}>
          <Link2 style={{ ...iconStyle, opacity: 0.5 }} strokeWidth={1.8} aria-hidden />
          <div style={{ ...placeholderStyle, opacity: 0.55 }}>Add AI meeting notes</div>
        </div>
        <div style={rowStyle}>
          <MapPin style={iconStyle} strokeWidth={1.8} aria-hidden />
          <input
            aria-label="Location"
            placeholder="Location"
            value={location}
            onChange={(e) => setLocation (e.target.value)}
            style={{
              border: 'none',
              outline: 'none',
              color: text,
              fontSize: '15px',
              background: 'transparent',
              padding: 0,
            }}
          />
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${hairline}`, padding: '18px' }}>
        <textarea
          aria-label="Description"
          placeholder="Description"
          value={notes}
          onChange={(e) => setNotes (e.target.value)}
          rows={2}
          style={{
            width: '100%',
            resize: 'vertical',
            border: 'none',
            outline: 'none',
            color: text,
            fontSize: '15px',
            lineHeight: 1.35,
            background: 'transparent',
            padding: 0,
          }}
        />
      </div>

      <div style={{ borderTop: `1px solid ${hairline}`, padding: '18px', display: 'grid', gap: '16px' }}>
        <div style={{ ...rowStyle, alignItems: 'center' }}>
          <span style={{ width: '14px', height: '14px', borderRadius: '4px', background: '#38bdf8', marginLeft: '2px' }} />
          <div style={{ fontSize: '15px' }}>Workspace calendar</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 1fr', gap: '12px', alignItems: 'center' }}>
          <span />
          <div style={{ fontSize: '15px' }}>Busy</div>
          <div style={{ fontSize: '15px' }}>Default visibility</div>
        </div>
        <div style={rowStyle}>
          <Bell style={iconStyle} strokeWidth={1.8} aria-hidden />
          <div>
            <div style={placeholderStyle}>Reminders</div>
            <div style={{ marginTop: '14px', fontSize: '14px' }}>30 min before</div>
          </div>
        </div>
      </div>
    </form>
  );
}

function EventPreview ({
  preview,
  onClose,
  text,
  muted,
  hairline,
}: {
  preview: PreviewState;
  onClose: () => void;
  text: string;
  muted: string;
  hairline: string;
}) {
  const appointment = preview.appointment;
  const duration = formatDuration (appointment.startTime, appointment.endTime);
  const lineStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '24px 1fr',
    gap: '12px',
    alignItems: 'start',
    color: text,
  };
  const iconStyle: CSSProperties = {
    width: '18px',
    height: '18px',
    color: 'rgba(0,0,0,0.28)',
    marginTop: '2px',
  };

  return (
    <div
      role="dialog"
      aria-label={`${appointment.title} preview`}
      onMouseDown={(e) => e.stopPropagation ()}
      style={{
        position: 'fixed',
        zIndex: 150,
        left: preview.left,
        top: preview.top,
        width: '360px',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 32px)',
        overflow: 'auto',
        background: 'rgba(255,255,255,0.98)',
        border: `1px solid ${hairline}`,
        borderRadius: '16px',
        boxShadow: '0 22px 70px rgba(15,23,42,0.18), 0 4px 18px rgba(15,23,42,0.08)',
        color: text,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 20px 16px' }}>
        <div style={{ fontSize: '16px', fontWeight: 600 }}>Event</div>
        <button
          type="button"
          aria-label="Close event preview"
          onClick={onClose}
          style={{
            border: 'none',
            background: 'transparent',
            color: muted,
            cursor: 'pointer',
            padding: '2px',
            lineHeight: 0,
          }}
        >
          <X className="h-5 w-5" strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      <div style={{ padding: '20px', borderTop: `1px solid ${hairline}`, fontSize: '18px', fontWeight: 500 }}>
        {appointment.title}
      </div>

      <div style={{ padding: '18px 20px', borderTop: `1px solid ${hairline}`, display: 'grid', gap: '14px' }}>
        <div style={lineStyle}>
          <Clock3 style={iconStyle} strokeWidth={1.8} aria-hidden />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '15px' }}>
              <span>{formatTime (appointment.startTime)}</span>
              <span style={{ color: muted }}>→</span>
              <span>{formatTime (appointment.endTime)}</span>
              {duration ? <span style={{ color: muted, fontSize: '13px' }}>{duration}</span> : null}
            </div>
            <div style={{ marginTop: '8px', fontSize: '14px' }}>{formatDateLine (appointment.startTime)}</div>
          </div>
        </div>

        <div style={lineStyle}>
          <UserRound style={iconStyle} strokeWidth={1.8} aria-hidden />
          <div style={{ fontSize: '14px' }}>
            {appointment.clientName || 'No client'}
            <div style={{ color: muted, marginTop: '2px' }}>Participant</div>
          </div>
        </div>

        {appointment.location ? (
          <div style={lineStyle}>
            <MapPin style={iconStyle} strokeWidth={1.8} aria-hidden />
            <div style={{ fontSize: '14px', lineHeight: 1.35 }}>{appointment.location}</div>
          </div>
        ) : null}
      </div>

      {appointment.notes ? (
        <div style={{ padding: '18px 20px', borderTop: `1px solid ${hairline}`, display: 'grid', gap: '12px' }}>
          <div style={lineStyle}>
            <Link2 style={iconStyle} strokeWidth={1.8} aria-hidden />
            <div style={{ fontSize: '14px', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{appointment.notes}</div>
          </div>
        </div>
      ) : null}

      <div style={{ padding: '16px 20px', borderTop: `1px solid ${hairline}`, display: 'grid', gap: '14px' }}>
        <div style={lineStyle}>
          <CalendarDays style={{ ...iconStyle, color: 'var(--neutral)' }} strokeWidth={1.8} aria-hidden />
          <div style={{ fontSize: '14px' }}>
            <span
              style={{
                display: 'inline-block',
                width: '12px',
                height: '12px',
                borderRadius: '4px',
                background: appointment.status === 'confirmed' ? 'var(--green)' : 'var(--neutral)',
                marginRight: '10px',
                verticalAlign: '-1px',
              }}
            />
            Workspace calendar
          </div>
        </div>
        <div style={lineStyle}>
          <Bell style={iconStyle} strokeWidth={1.8} aria-hidden />
          <div style={{ fontSize: '14px', color: muted }}>Reminders</div>
        </div>
      </div>
    </div>
  );
}
