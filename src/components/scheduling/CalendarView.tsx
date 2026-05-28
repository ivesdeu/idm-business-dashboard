import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, MouseEvent, PointerEvent, RefObject } from 'react';
import {
  BellIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  LinkIcon,
  MapPinIcon,
  PencilIcon,
  TrashIcon,
  UserIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { AppointmentColor, ClientOption, SchedulingAppointment } from '@/components/scheduling/types';

type CalMode = 'month' | 'week';

type AppointmentUpdatePayload = {
  title: string;
  clientId: string | null;
  startTime: string;
  endTime: string;
  location: string | null;
  notes: string | null;
  color: AppointmentColor | null;
};

type AppointmentColorPalette = {
  label: string;
  solid: string;
  background: string;
  foreground: string;
};

const APPOINTMENT_COLOR_PALETTE: Record<AppointmentColor, AppointmentColorPalette> = {
  blue: { label: 'Blue', solid: '#3b82f6', background: '#dbeafe', foreground: '#1d4ed8' },
  green: { label: 'Green', solid: '#10b981', background: '#d1fae5', foreground: '#047857' },
  red: { label: 'Red', solid: '#ef4444', background: '#fee2e2', foreground: '#b91c1c' },
  amber: { label: 'Amber', solid: '#f59e0b', background: '#fef3c7', foreground: '#b45309' },
  purple: { label: 'Purple', solid: '#8b5cf6', background: '#ede9fe', foreground: '#6d28d9' },
  rose: { label: 'Rose', solid: '#f43f5e', background: '#ffe4e6', foreground: '#be123c' },
  slate: { label: 'Slate', solid: '#64748b', background: '#e2e8f0', foreground: '#334155' },
  teal: { label: 'Teal', solid: '#14b8a6', background: '#ccfbf1', foreground: '#0f766e' },
  pink: { label: 'Pink', solid: '#ec4899', background: '#fce7f3', foreground: '#be185d' },
};

const APPOINTMENT_COLOR_ORDER: AppointmentColor[] = [
  'blue',
  'green',
  'amber',
  'red',
  'rose',
  'pink',
  'purple',
  'teal',
  'slate',
];

/**
 * Portaled popovers don't share a React parent with the calendar, so the calendar's
 * onMouseDown "click-outside" doesn't fire for clicks elsewhere on the page (sidebar,
 * top nav, settings). Without this hook the popover stays up forever and z-index 150
 * absorbs clicks that overlap it. Attach a document-level pointerdown listener while
 * the popover is mounted, and close on Escape too.
 */
function useDismissOnOutside (
  ref: RefObject<HTMLElement>,
  onClose: () => void,
) {
  useEffect (() => {
    function handlePointerDown (event: globalThis.PointerEvent | globalThis.MouseEvent) {
      const node = ref.current;
      const target = event.target as Node | null;
      if (!node || !target) return;
      if (node.contains (target)) return;
      onClose ();
    }
    function handleKey (event: KeyboardEvent) {
      if (event.key === 'Escape') onClose ();
    }
    document.addEventListener ('mousedown', handlePointerDown, true);
    document.addEventListener ('keydown', handleKey);
    return () => {
      document.removeEventListener ('mousedown', handlePointerDown, true);
      document.removeEventListener ('keydown', handleKey);
    };
  }, [ref, onClose]);
}

function colorPillStyle (color: AppointmentColor): CSSProperties {
  const palette = APPOINTMENT_COLOR_PALETTE[color];
  return { background: palette.background, color: palette.foreground };
}

function colorDot (color: AppointmentColor | null): string {
  return color ? APPOINTMENT_COLOR_PALETTE[color].solid : 'var(--neutral, #64748b)';
}

type Props = {
  appointments: SchedulingAppointment[];
  clientOptions?: ClientOption[];
  onSelect: (a: SchedulingAppointment) => void;
  onCreateAppointment?: (payload: AppointmentUpdatePayload & { syncToGoogle: boolean }) => Promise<void>;
  onUpdateAppointment?: (id: string, payload: AppointmentUpdatePayload) => Promise<void>;
  onDeleteAppointment?: (id: string) => Promise<void>;
};

type PreviewState = {
  appointment: SchedulingAppointment;
  left: number;
  top: number;
  width: number;
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
const CAL_MODE_STORAGE_KEY = 'scheduling:calendar-view-mode:v1';

function readPersistedCalMode (): CalMode {
  if (typeof window === 'undefined') return 'month';
  try {
    const raw = window.localStorage.getItem (CAL_MODE_STORAGE_KEY);
    if (raw === 'month' || raw === 'week') return raw;
  } catch (_) {}
  return 'month';
}

function writePersistedCalMode (mode: CalMode) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem (CAL_MODE_STORAGE_KEY, mode);
  } catch (_) {}
}

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

/**
 * Visual style for an event pill. Cancelled events are always struck through
 * with a neutral background, otherwise an explicit color category wins
 * over the default status palette so users can group events visually.
 */
function eventPillStyle (a: SchedulingAppointment): CSSProperties {
  if (a.status === 'cancelled') return statusPillStyle ('cancelled');
  if (a.color) return colorPillStyle (a.color);
  return statusPillStyle (a.status);
}

export function CalendarView ({
  appointments,
  clientOptions,
  onCreateAppointment,
  onUpdateAppointment,
  onDeleteAppointment,
}: Props) {
  const [mode, setModeState] = useState<CalMode> (() => readPersistedCalMode ());
  const setMode = (next: CalMode) => {
    setModeState (next);
    writePersistedCalMode (next);
  };
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
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = Math.min (380, Math.max (260, viewportW - 24));
    const maxLeft = Math.max (12, viewportW - width - 12);
    const left = clamp (rect.left + rect.width / 2 - width / 2, 12, maxLeft);
    const estimatedHeight = Math.min (520, viewportH - 32);
    const top = clamp (rect.top + 18, 16, Math.max (16, viewportH - estimatedHeight - 16));
    setPreview ({ appointment, left, top, width });
    setQuickCreate (null);
  }

  function openQuickCreate (range: { startTime: string; endTime: string }, anchor: { x: number; y: number }) {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = Math.min (360, Math.max (240, viewportW - 32));
    const maxLeft = Math.max (16, viewportW - width - 16);
    const estimatedHeight = Math.min (620, viewportH - 32);
    setPreview (null);
    setQuickCreate ({
      ...range,
      left: clamp (anchor.x - width / 2, 16, maxLeft),
      top: clamp (anchor.y - 96, 16, Math.max (16, viewportH - estimatedHeight - 16)),
    });
  }

  /**
   * Double-click a month-grid cell to spawn the quick-create popover for that day,
   * pre-populated with a 9–10 AM range. Honors the cell's text selection prevention
   * and stops the dblclick from re-triggering preview when it bubbles up.
   */
  function openMonthCellQuickCreate (day: Date, event: MouseEvent<HTMLDivElement>) {
    if (!onCreateAppointment) return;
    event.preventDefault ();
    event.stopPropagation ();
    const start = new Date (day);
    start.setHours (9, 0, 0, 0);
    const end = new Date (start);
    end.setHours (10, 0, 0, 0);
    openQuickCreate (
      { startTime: start.toISOString (), endTime: end.toISOString () },
      { x: event.clientX, y: event.clientY },
    );
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
              <ChevronLeftIcon className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" aria-label="Next" style={iconBtn} onClick={goNext}>
              <ChevronRightIcon className="h-4 w-4" aria-hidden />
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
      ) : null}

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
              <div
                key={idx}
                style={{
                  ...cellStyle,
                  cursor: onCreateAppointment ? 'copy' : 'default',
                  userSelect: 'none',
                }}
                onDoubleClick={onCreateAppointment ? (e) => openMonthCellQuickCreate (cell.date, e) : undefined}
                title={onCreateAppointment ? 'Double-click to add event' : undefined}
              >
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
                      onDoubleClick={(e) => e.stopPropagation ()}
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
                        ...eventPillStyle (a),
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

      {preview && typeof document !== 'undefined'
        ? createPortal (
            <EventPreview
              preview={preview}
              clientOptions={clientOptions ?? []}
              onClose={() => setPreview (null)}
              onUpdate={onUpdateAppointment}
              onDelete={onDeleteAppointment}
              text={text}
              muted={muted}
              hairline={hairline}
            />,
            document.body,
          )
        : null}

      {quickCreate && onCreateAppointment && typeof document !== 'undefined'
        ? createPortal (
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
            />,
            document.body,
          )
        : null}
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
    if (a.color) {
      const palette = APPOINTMENT_COLOR_PALETTE[a.color];
      return { background: palette.background, color: palette.foreground, borderLeft: `3px solid ${palette.solid}` };
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
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${WEEK_GUTTER_WIDTH}px repeat(7, minmax(132px, 1fr))`,
          minWidth: '980px',
          borderTop: `1px solid ${hairline}`,
          borderBottom: `1px solid ${hairline}`,
        }}
      >
        <div style={{ borderRight: `1px solid ${hairline}` }} />
        {weekDays.map ((day, idx) => {
          const today = isTodayLocal (day);
          return (
            <div
              key={`hdr-${day.toISOString ()}`}
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
                  cursor: 'pointer',
                  fontSize: '10px',
                  fontWeight: 500,
                  lineHeight: 1.3,
                  overflow: 'hidden',
                  padding: '2px 5px',
                  textAlign: 'left',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(a.color
                    ? { background: APPOINTMENT_COLOR_PALETTE[a.color].background, color: APPOINTMENT_COLOR_PALETTE[a.color].foreground }
                    : { background: 'rgba(34,197,94,0.2)', color: '#2f7d48' }),
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
          position: 'relative',
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

        {showNowLine && weekDays.some (isTodayLocal) ? (
          <div
            aria-label="Current time"
            style={{
              position: 'absolute',
              top: nowTop,
              left: `${WEEK_GUTTER_WIDTH}px`,
              right: 0,
              height: '1px',
              background: 'var(--red)',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
        ) : null}

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

function AppointmentColorPicker ({
  value,
  onChange,
  hairline,
  muted,
}: {
  value: AppointmentColor | null;
  onChange: (next: AppointmentColor | null) => void;
  hairline: string;
  muted: string;
}) {
  const swatchSize = 22;
  return (
    <div
      role="radiogroup"
      aria-label="Event color"
      style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}
    >
      <button
        type="button"
        role="radio"
        aria-checked={value == null}
        aria-label="No color"
        onClick={() => onChange (null)}
        title="No color"
        style={{
          width: swatchSize,
          height: swatchSize,
          borderRadius: '50%',
          border: `1px ${value == null ? 'solid' : 'dashed'} ${value == null ? 'var(--text)' : hairline}`,
          padding: 0,
          background: '#ffffff',
          color: muted,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 0,
          boxShadow: value == null ? '0 0 0 2px rgba(0,0,0,0.06)' : 'none',
        }}
      >
        <XMarkIcon style={{ width: 12, height: 12 }} aria-hidden />
      </button>
      {APPOINTMENT_COLOR_ORDER.map ((c) => {
        const palette = APPOINTMENT_COLOR_PALETTE[c];
        const selected = value === c;
        return (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={palette.label}
            title={palette.label}
            onClick={() => onChange (c)}
            style={{
              width: swatchSize,
              height: swatchSize,
              borderRadius: '50%',
              border: selected ? `2px solid var(--text)` : '1px solid rgba(0,0,0,0.08)',
              padding: 0,
              background: palette.solid,
              cursor: 'pointer',
              boxShadow: selected ? '0 0 0 2px rgba(0,0,0,0.08)' : 'none',
            }}
          />
        );
      })}
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
    color: AppointmentColor | null;
    syncToGoogle: boolean;
  }) => Promise<void>;
  text: string;
  muted: string;
  hairline: string;
}) {
  const [title, setTitle] = useState ('');
  const [location, setLocation] = useState ('');
  const [notes, setNotes] = useState ('');
  const [color, setColor] = useState<AppointmentColor | null> (null);
  const [saving, setSaving] = useState (false);
  const popoverRef = useRef<HTMLFormElement | null> (null);
  useDismissOnOutside (popoverRef, onClose);
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
        color,
        syncToGoogle: false,
      });
    } finally {
      setSaving (false);
    }
  }

  return (
    <form
      ref={popoverRef}
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
          <ChevronRightIcon style={{ width: '14px', height: '14px', color: muted, transform: 'rotate(90deg)' }} aria-hidden />
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
            <XMarkIcon className="h-5 w-5" aria-hidden />
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
          <ClockIcon style={iconStyle} aria-hidden />
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
          <UserIcon style={iconStyle} aria-hidden />
          <div style={placeholderStyle}>Participants</div>
        </div>
        <div style={rowStyle}>
          <CalendarDaysIcon style={iconStyle} aria-hidden />
          <div style={placeholderStyle}>Conferencing</div>
        </div>
        <div style={rowStyle}>
          <LinkIcon style={{ ...iconStyle, opacity: 0.5 }} aria-hidden />
          <div style={{ ...placeholderStyle, opacity: 0.55 }}>Add AI meeting notes</div>
        </div>
        <div style={rowStyle}>
          <MapPinIcon style={iconStyle} aria-hidden />
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
          <span
            style={{
              width: '14px',
              height: '14px',
              borderRadius: '4px',
              background: colorDot (color),
              marginLeft: '2px',
            }}
          />
          <div style={{ fontSize: '15px' }}>Color</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: '12px', alignItems: 'center' }}>
          <span />
          <AppointmentColorPicker value={color} onChange={setColor} hairline={hairline} muted={muted} />
        </div>
        <div style={rowStyle}>
          <BellIcon style={iconStyle} aria-hidden />
          <div>
            <div style={placeholderStyle}>Reminders</div>
            <div style={{ marginTop: '14px', fontSize: '14px' }}>30 min before</div>
          </div>
        </div>
      </div>
    </form>
  );
}

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

type EventPreviewMode = 'view' | 'edit' | 'confirm-delete';

function EventPreview ({
  preview,
  clientOptions,
  onClose,
  onUpdate,
  onDelete,
  text,
  muted,
  hairline,
}: {
  preview: PreviewState;
  clientOptions: ClientOption[];
  onClose: () => void;
  onUpdate?: (id: string, payload: AppointmentUpdatePayload) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  text: string;
  muted: string;
  hairline: string;
}) {
  const appointment = preview.appointment;
  const canEdit = typeof onUpdate === 'function';
  const canDelete = typeof onDelete === 'function';

  const [mode, setMode] = useState<EventPreviewMode> ('view');
  const [title, setTitle] = useState (appointment.title);
  const [clientId, setClientId] = useState<string | null> (appointment.clientId);
  const [dateStr, setDateStr] = useState (() => isoToDateInput (appointment.startTime));
  const [startT, setStartT] = useState (() => isoToTimeInput (appointment.startTime));
  const [endT, setEndT] = useState (() => isoToTimeInput (appointment.endTime));
  const [location, setLocation] = useState (appointment.location ?? '');
  const [notes, setNotes] = useState (appointment.notes ?? '');
  const [color, setColor] = useState<AppointmentColor | null> (appointment.color);
  const [saving, setSaving] = useState (false);
  const [deleting, setDeleting] = useState (false);
  const [errorMsg, setErrorMsg] = useState<string | null> (null);
  const [quickColorOpen, setQuickColorOpen] = useState (false);
  const [savingQuickColor, setSavingQuickColor] = useState (false);
  const popoverRef = useRef<HTMLFormElement | null> (null);
  useDismissOnOutside (popoverRef, onClose);

  async function handleQuickColorChange (next: AppointmentColor | null) {
    if (!onUpdate) return;
    setSavingQuickColor (true);
    setErrorMsg (null);
    try {
      await onUpdate (appointment.id, {
        title: appointment.title,
        clientId: appointment.clientId,
        startTime: appointment.startTime,
        endTime: appointment.endTime,
        location: appointment.location ?? null,
        notes: appointment.notes ?? null,
        color: next,
      });
      setColor (next);
      setQuickColorOpen (false);
    } catch (err) {
      setErrorMsg (err instanceof Error && err.message ? err.message : 'Could not update color.');
    } finally {
      setSavingQuickColor (false);
    }
  }

  const duration = formatDuration (appointment.startTime, appointment.endTime);
  const lineStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '22px minmax(0, 1fr)',
    gap: '10px',
    alignItems: 'start',
    color: text,
  };
  const lineValueStyle: CSSProperties = {
    minWidth: 0,
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
  };
  const iconStyle: CSSProperties = {
    width: '18px',
    height: '18px',
    color: 'rgba(0,0,0,0.28)',
    marginTop: '2px',
    flexShrink: 0,
  };
  const inputBase: CSSProperties = {
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'rgba(0,0,0,0.045)',
    borderRadius: '6px',
    color: text,
    fontSize: '14px',
    padding: '6px 10px',
  };

  function startEditing () {
    setMode ('edit');
    setTitle (appointment.title);
    setClientId (appointment.clientId);
    setDateStr (isoToDateInput (appointment.startTime));
    setStartT (isoToTimeInput (appointment.startTime));
    setEndT (isoToTimeInput (appointment.endTime));
    setLocation (appointment.location ?? '');
    setNotes (appointment.notes ?? '');
    setColor (appointment.color);
    setErrorMsg (null);
  }

  async function handleSave () {
    if (!onUpdate) return;
    if (!dateStr || !startT || !endT) {
      setErrorMsg ('Date, start, and end are required.');
      return;
    }
    const startIso = combineLocalDateTime (dateStr, startT);
    const endIso = combineLocalDateTime (dateStr, endT);
    if (new Date (endIso).getTime () <= new Date (startIso).getTime ()) {
      setErrorMsg ('End time must be after the start time.');
      return;
    }
    setSaving (true);
    setErrorMsg (null);
    try {
      await onUpdate (appointment.id, {
        title: title.trim () || 'Untitled',
        clientId,
        startTime: startIso,
        endTime: endIso,
        location: location.trim () || null,
        notes: notes.trim () || null,
        color,
      });
      onClose ();
    } catch (err) {
      setErrorMsg (err instanceof Error && err.message ? err.message : 'Could not save changes.');
    } finally {
      setSaving (false);
    }
  }

  async function handleDelete () {
    if (!onDelete) return;
    setDeleting (true);
    setErrorMsg (null);
    try {
      await onDelete (appointment.id);
      onClose ();
    } catch (err) {
      setErrorMsg (err instanceof Error && err.message ? err.message : 'Could not delete event.');
    } finally {
      setDeleting (false);
    }
  }

  const headerActionsView = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      {canEdit ? (
        <button
          type="button"
          aria-label="Edit event"
          onClick={startEditing}
          title="Edit"
          style={{
            border: 'none',
            background: 'transparent',
            color: muted,
            cursor: 'pointer',
            padding: '6px',
            borderRadius: '6px',
            lineHeight: 0,
          }}
        >
          <PencilIcon className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          aria-label="Delete event"
          onClick={() => setMode ('confirm-delete')}
          title="Delete"
          style={{
            border: 'none',
            background: 'transparent',
            color: muted,
            cursor: 'pointer',
            padding: '6px',
            borderRadius: '6px',
            lineHeight: 0,
          }}
        >
          <TrashIcon className="h-4 w-4" aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Close event preview"
        onClick={onClose}
        style={{
          border: 'none',
          background: 'transparent',
          color: muted,
          cursor: 'pointer',
          padding: '6px',
          borderRadius: '6px',
          lineHeight: 0,
        }}
      >
        <XMarkIcon className="h-5 w-5" aria-hidden />
      </button>
    </div>
  );

  const headerActionsEdit = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <button
        type="button"
        onClick={() => {
          setMode ('view');
          setErrorMsg (null);
        }}
        disabled={saving}
        style={{
          border: `1px solid ${hairline}`,
          background: 'transparent',
          color: text,
          cursor: saving ? 'default' : 'pointer',
          fontSize: '12px',
          fontWeight: 500,
          padding: '5px 10px',
          borderRadius: '7px',
          opacity: saving ? 0.6 : 1,
        }}
      >
        Cancel
      </button>
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
    </div>
  );

  return (
    <form
      ref={popoverRef}
      role="dialog"
      aria-label={`${appointment.title} ${mode === 'edit' ? 'editor' : 'preview'}`}
      onMouseDown={(e) => e.stopPropagation ()}
      onSubmit={(e) => {
        e.preventDefault ();
        if (mode === 'edit') void handleSave ();
      }}
      style={{
        position: 'fixed',
        zIndex: 150,
        left: preview.left,
        top: preview.top,
        width: `${preview.width}px`,
        maxWidth: 'calc(100vw - 24px)',
        maxHeight: `calc(100vh - ${preview.top + 16}px)`,
        overflow: 'auto',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
        background: 'rgba(255,255,255,0.98)',
        border: `1px solid ${hairline}`,
        borderRadius: '16px',
        boxShadow: '0 22px 70px rgba(15,23,42,0.18), 0 4px 18px rgba(15,23,42,0.08)',
        color: text,
        transformOrigin: 'top center',
        animation: 'calendarQuickCreateIn 150ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px 12px' }}>
        <div style={{ fontSize: '16px', fontWeight: 600 }}>
          {mode === 'edit' ? 'Edit event' : mode === 'confirm-delete' ? 'Delete event?' : 'Event'}
        </div>
        {mode === 'edit' ? headerActionsEdit : mode === 'view' ? headerActionsView : null}
      </div>

      {mode === 'confirm-delete' ? (
        <div style={{ padding: '20px', borderTop: `1px solid ${hairline}`, display: 'grid', gap: '14px' }}>
          <div style={{ fontSize: '14px', lineHeight: 1.5 }}>
            <span style={{ fontWeight: 600 }}>{appointment.title}</span> will be permanently removed from your calendar.
            This can&apos;t be undone.
          </div>
          {errorMsg ? <div style={{ color: 'var(--red, #dc2626)', fontSize: '13px' }}>{errorMsg}</div> : null}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button"
              onClick={() => {
                setMode ('view');
                setErrorMsg (null);
              }}
              disabled={deleting}
              style={{
                border: `1px solid ${hairline}`,
                background: 'transparent',
                color: text,
                cursor: deleting ? 'default' : 'pointer',
                fontSize: '13px',
                fontWeight: 500,
                padding: '6px 12px',
                borderRadius: '8px',
                opacity: deleting ? 0.6 : 1,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDelete ()}
              disabled={deleting}
              style={{
                border: 'none',
                background: 'var(--red, #dc2626)',
                color: '#fff',
                cursor: deleting ? 'default' : 'pointer',
                fontSize: '13px',
                fontWeight: 600,
                padding: '6px 12px',
                borderRadius: '8px',
                opacity: deleting ? 0.65 : 1,
              }}
            >
              {deleting ? 'Deleting' : 'Delete'}
            </button>
          </div>
        </div>
      ) : mode === 'edit' ? (
        <>
          <div style={{ padding: '0 16px 16px' }}>
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

          <div style={{ borderTop: `1px solid ${hairline}`, padding: '16px 18px', display: 'grid', gap: '12px' }}>
            <div style={lineStyle}>
              <ClockIcon style={iconStyle} aria-hidden />
              <div style={{ display: 'grid', gap: '8px' }}>
                <input
                  type="date"
                  aria-label="Date"
                  value={dateStr}
                  onChange={(e) => setDateStr (e.target.value)}
                  style={inputBase}
                />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '8px', alignItems: 'center' }}>
                  <input
                    type="time"
                    aria-label="Start time"
                    value={startT}
                    onChange={(e) => setStartT (e.target.value)}
                    style={inputBase}
                  />
                  <span style={{ color: muted, fontSize: '13px' }}>→</span>
                  <input
                    type="time"
                    aria-label="End time"
                    value={endT}
                    onChange={(e) => setEndT (e.target.value)}
                    style={inputBase}
                  />
                </div>
              </div>
            </div>

            {clientOptions.length > 0 ? (
              <div style={lineStyle}>
                <UserIcon style={iconStyle} aria-hidden />
                <select
                  aria-label="Client"
                  value={clientId ?? ''}
                  onChange={(e) => setClientId (e.target.value || null)}
                  style={{ ...inputBase, appearance: 'auto', cursor: 'pointer' }}
                >
                  <option value="">No client</option>
                  {clientOptions.map ((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div style={lineStyle}>
              <MapPinIcon style={iconStyle} aria-hidden />
              <input
                aria-label="Location"
                placeholder="Location"
                value={location}
                onChange={(e) => setLocation (e.target.value)}
                style={inputBase}
              />
            </div>

            <div style={lineStyle}>
              <span
                aria-hidden
                style={{
                  width: '14px',
                  height: '14px',
                  borderRadius: '4px',
                  background: colorDot (color),
                  marginTop: '4px',
                  marginLeft: '2px',
                  border: color ? 'none' : `1px solid ${hairline}`,
                }}
              />
              <div>
                <div style={{ fontSize: '13px', color: muted, marginBottom: '6px' }}>Color</div>
                <AppointmentColorPicker value={color} onChange={setColor} hairline={hairline} muted={muted} />
              </div>
            </div>
          </div>

          <div style={{ borderTop: `1px solid ${hairline}`, padding: '16px 18px' }}>
            <textarea
              aria-label="Notes"
              placeholder="Notes"
              value={notes}
              onChange={(e) => setNotes (e.target.value)}
              rows={3}
              style={{
                ...inputBase,
                resize: 'vertical',
                lineHeight: 1.4,
                padding: '8px 10px',
              }}
            />
          </div>

          {errorMsg ? (
            <div style={{ padding: '0 18px 14px', color: 'var(--red, #dc2626)', fontSize: '13px' }}>{errorMsg}</div>
          ) : null}

          {canDelete ? (
            <div style={{ borderTop: `1px solid ${hairline}`, padding: '12px 18px', display: 'flex', justifyContent: 'flex-start' }}>
              <button
                type="button"
                onClick={() => setMode ('confirm-delete')}
                disabled={saving}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--red, #dc2626)',
                  cursor: saving ? 'default' : 'pointer',
                  fontSize: '13px',
                  fontWeight: 500,
                  padding: '4px 6px',
                  borderRadius: '6px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                <TrashIcon className="h-4 w-4" aria-hidden />
                Delete event
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div
            style={{
              padding: '18px 18px',
              borderTop: `1px solid ${hairline}`,
              fontSize: '18px',
              fontWeight: 500,
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
              lineHeight: 1.3,
            }}
          >
            {appointment.title}
          </div>

          <div style={{ padding: '16px 18px', borderTop: `1px solid ${hairline}`, display: 'grid', gap: '14px' }}>
            <div style={lineStyle}>
              <ClockIcon style={iconStyle} aria-hidden />
              <div style={lineValueStyle}>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', columnGap: '8px', rowGap: '2px', fontSize: '15px' }}>
                  <span>{formatTime (appointment.startTime)}</span>
                  <span style={{ color: muted }}>→</span>
                  <span>{formatTime (appointment.endTime)}</span>
                  {duration ? <span style={{ color: muted, fontSize: '13px' }}>{duration}</span> : null}
                </div>
                <div style={{ marginTop: '6px', fontSize: '14px' }}>{formatDateLine (appointment.startTime)}</div>
              </div>
            </div>

            <div style={lineStyle}>
              <UserIcon style={iconStyle} aria-hidden />
              <div style={{ ...lineValueStyle, fontSize: '14px' }}>
                {appointment.clientName || 'No client'}
                <div style={{ color: muted, marginTop: '2px' }}>Participant</div>
              </div>
            </div>

            {appointment.location ? (
              <div style={lineStyle}>
                <MapPinIcon style={iconStyle} aria-hidden />
                <div style={{ ...lineValueStyle, fontSize: '14px', lineHeight: 1.35 }}>{appointment.location}</div>
              </div>
            ) : null}
          </div>

          {appointment.notes ? (
            <div style={{ padding: '16px 18px', borderTop: `1px solid ${hairline}`, display: 'grid', gap: '12px' }}>
              <div style={lineStyle}>
                <LinkIcon style={iconStyle} aria-hidden />
                <div style={{ ...lineValueStyle, fontSize: '14px', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
                  {appointment.notes}
                </div>
              </div>
            </div>
          ) : null}

          <div style={{ padding: '14px 18px', borderTop: `1px solid ${hairline}`, display: 'grid', gap: '12px' }}>
            <div style={lineStyle}>
              <CalendarDaysIcon style={{ ...iconStyle, color: 'var(--neutral)' }} aria-hidden />
              <div style={{ ...lineValueStyle, fontSize: '14px' }}>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setQuickColorOpen ((v) => !v)}
                    aria-expanded={quickColorOpen}
                    aria-label="Change color category"
                    title="Change color"
                    disabled={savingQuickColor}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '10px',
                      background: 'transparent',
                      border: 'none',
                      padding: '2px 6px',
                      margin: '-2px -6px',
                      borderRadius: '6px',
                      color: text,
                      cursor: savingQuickColor ? 'default' : 'pointer',
                      font: 'inherit',
                      fontSize: '14px',
                      textAlign: 'left',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.045)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-block',
                        width: '12px',
                        height: '12px',
                        borderRadius: '4px',
                        background: colorDot (appointment.color),
                        verticalAlign: '-1px',
                      }}
                      aria-hidden
                    />
                    <span>
                      {appointment.color
                        ? APPOINTMENT_COLOR_PALETTE[appointment.color].label
                        : 'Workspace calendar'}
                    </span>
                    <span style={{ color: muted, fontSize: '12px', marginLeft: '4px' }}>
                      {quickColorOpen ? '▴' : '▾'}
                    </span>
                  </button>
                ) : (
                  <>
                    <span
                      style={{
                        display: 'inline-block',
                        width: '12px',
                        height: '12px',
                        borderRadius: '4px',
                        background: colorDot (appointment.color),
                        marginRight: '10px',
                        verticalAlign: '-1px',
                      }}
                    />
                    {appointment.color
                      ? APPOINTMENT_COLOR_PALETTE[appointment.color].label
                      : 'Workspace calendar'}
                  </>
                )}
                {canEdit && quickColorOpen ? (
                  <div style={{ marginTop: '10px' }}>
                    <AppointmentColorPicker
                      value={appointment.color}
                      onChange={(next) => {
                        if (!savingQuickColor) void handleQuickColorChange (next);
                      }}
                      hairline={hairline}
                      muted={muted}
                    />
                    {savingQuickColor ? (
                      <div style={{ fontSize: '12px', color: muted, marginTop: '6px' }}>Saving…</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <div style={lineStyle}>
              <BellIcon style={iconStyle} aria-hidden />
              <div style={{ ...lineValueStyle, fontSize: '14px', color: muted }}>Reminders</div>
            </div>
          </div>
        </>
      )}
    </form>
  );
}
