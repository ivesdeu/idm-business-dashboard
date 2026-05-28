import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CalendarIcon, QueueListIcon, PlusCircleIcon } from '@heroicons/react/24/outline';
import { AppointmentDetailDrawer } from '@/components/scheduling/AppointmentDetailDrawer';
import { AppointmentsList } from '@/components/scheduling/AppointmentsList';
import { CalendarView } from '@/components/scheduling/CalendarView';
import { GoogleCalendarModal } from '@/components/scheduling/GoogleCalendarModal';
import { NewAppointmentForm } from '@/components/scheduling/NewAppointmentForm';
import type {
  AppointmentColor,
  ClientOption,
  SchedulingAppointment,
  SchedulingToast,
} from '@/components/scheduling/types';
import { isDemoMode } from '@/lib/demoMode';
import { syncToGoogleCalendar } from '@/lib/googleCalendar';
import { getSchedulingMockAppointments } from '@/lib/mockData/appointments';
import { schedulingAppointmentFromDemoSeed } from '@/lib/scheduling/mapDemo';
import {
  isTransientFetchError,
  logSchedulingFetchError,
  withTransientRetry,
} from '@/lib/scheduling/fetchWithRetry';
import type { AppointmentRow } from '@/lib/scheduling/supabase';
import { rowToSchedulingAppointment } from '@/lib/scheduling/supabase';

type SubView = 'calendar' | 'list' | 'new';

function getSupabase (): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { supabaseClient?: SupabaseClient }).supabaseClient;
  return c ?? null;
}

function getOrgId (): string | null {
  if (typeof window === 'undefined') return null;
  const fn = (window as unknown as { bizDashGetCurrentOrgId?: () => string | null }).bizDashGetCurrentOrgId;
  const fromFn = typeof fn === 'function' ? fn () : null;
  const id =
    (fromFn && String (fromFn).trim ()) ||
    String ((window as unknown as { currentOrganizationId?: string | null }).currentOrganizationId || '').trim ();
  return id || null;
}

function uid (): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID ();
  return `tmp_${Date.now ()}_${Math.random ().toString (36).slice (2)}`;
}

export function SchedulingPage () {
  const demoMode = isDemoMode ();
  const hasLoadedOnceRef = useRef (false);
  const [subView, setSubView] = useState<SubView> ('calendar');
  const [appointments, setAppointments] = useState<SchedulingAppointment[]> ([]);
  const [clientOptions, setClientOptions] = useState<ClientOption[]> ([]);
  const [loading, setLoading] = useState (true);
  const [refreshToken, setRefreshToken] = useState (0);
  const [detail, setDetail] = useState<SchedulingAppointment | null> (null);
  const [connectOpen, setConnectOpen] = useState (false);
  const [editTarget, setEditTarget] = useState<SchedulingAppointment | null> (null);
  const [toasts, setToasts] = useState<SchedulingToast[]> ([]);
  const [syncLoadingId, setSyncLoadingId] = useState<string | null> (null);

  const pushToast = useCallback ((t: Omit<SchedulingToast, 'id'>) => {
    const id = uid ();
    setToasts ((prev) => [...prev, { ...t, id }]);
    window.setTimeout (() => {
      setToasts ((prev) => prev.filter ((x) => x.id !== id));
    }, 5200);
  }, []);

  const reloadGenerationRef = useRef (0);

  const reloadLive = useCallback (async () => {
    const generation = reloadGenerationRef.current + 1;
    reloadGenerationRef.current = generation;

    const supabase = getSupabase ();
    const orgId = getOrgId ();
    if (!supabase || !orgId) {
      setAppointments ([]);
      setClientOptions ([]);
      setLoading (false);
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession ();
    if (!sessionData.session) {
      setAppointments ([]);
      setClientOptions ([]);
      setLoading (false);
      return;
    }

    if (reloadGenerationRef.current !== generation) return;

    const { data: clients, error: cErr } = await withTransientRetry (() =>
      supabase
        .from ('clients')
        .select ('id, company_name, contact_name')
        .eq ('organization_id', orgId)
        .order ('created_at', { ascending: true }),
    );

    if (reloadGenerationRef.current !== generation) return;

    if (cErr) logSchedulingFetchError ('scheduling clients', cErr);

    const opts: ClientOption[] =
      (clients ?? []).map ((r: { id: string; company_name: string | null; contact_name: string | null }) => ({
        id: r.id,
        label: (r.company_name || '').trim () || (r.contact_name || '').trim () || 'Untitled client',
      }));
    setClientOptions (opts);

    const nameMap: Record<string, string> = {};
    opts.forEach ((o) => {
      nameMap[o.id] = o.label;
    });

    const { data: rows, error } = await withTransientRetry (() =>
      supabase
        .from ('appointments')
        .select ('*')
        .eq ('organization_id', orgId)
        .order ('start_time', { ascending: true }),
    );

    if (reloadGenerationRef.current !== generation) return;

    if (error) {
      logSchedulingFetchError ('scheduling appointments', error);
      if (!isTransientFetchError (error)) {
        setAppointments ([]);
      }
      setLoading (false);
      return;
    }

    setAppointments ((rows as AppointmentRow[]).map ((r) => rowToSchedulingAppointment (r, nameMap)));
    setLoading (false);
  }, []);

  useEffect (() => {
    if (demoMode) {
      setAppointments (getSchedulingMockAppointments ().map (schedulingAppointmentFromDemoSeed));
      setClientOptions (
        Array.from (
          new Map (
            getSchedulingMockAppointments ().map ((s) => [s.demoClientId, { id: s.demoClientId, label: s.clientName }]),
          ).values (),
        ),
      );
      setLoading (false);
      hasLoadedOnceRef.current = true;
      return;
    }

    let cancelled = false;
    if (!hasLoadedOnceRef.current) setLoading (true);
    void (async () => {
      await reloadLive ();
      if (cancelled) return;
      hasLoadedOnceRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [demoMode, refreshToken, reloadLive]);

  /** When Supabase auth finishes after first paint, reload live rows (never affects demo fixtures). */
  useEffect (() => {
    if (demoMode) return;
    const supabase = getSupabase ();
    if (!supabase) return;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange (() => {
      setRefreshToken ((x) => x + 1);
    });
    return () => subscription.unsubscribe ();
  }, [demoMode]);

  /**
   * The scheduling island mounts at bootstrap; the first fetch often runs before workspace org exists,
   * so appointments stay empty until something bumps refreshToken. Re-fetch when this page is shown
   * and retry briefly for late org resolution.
   */
  useEffect (() => {
    if (demoMode) return;
    const page = document.getElementById ('page-scheduling');
    if (!page) return;
    let timerIds: number[] = [];
    const clearTimers = () => {
      timerIds.forEach ((id) => window.clearTimeout (id));
      timerIds = [];
    };
    let bumpDebounce: number | null = null;
    const bump = () => {
      if (bumpDebounce != null) window.clearTimeout (bumpDebounce);
      bumpDebounce = window.setTimeout (() => {
        bumpDebounce = null;
        setRefreshToken ((x) => x + 1);
      }, 120);
    };
    const onShow = () => {
      clearTimers ();
      bump ();
      // Retry only when org context is still initializing; otherwise avoid redundant refetch bursts.
      if (!getOrgId ()) {
        timerIds = [400, 1200].map ((ms) => window.setTimeout (bump, ms));
      }
    };
    const obs = new MutationObserver (() => {
      if (page.classList.contains ('on')) onShow ();
      else clearTimers ();
    });
    obs.observe (page, { attributes: true, attributeFilter: ['class'] });
    if (page.classList.contains ('on')) onShow ();
    return () => {
      obs.disconnect ();
      clearTimers ();
      if (bumpDebounce != null) window.clearTimeout (bumpDebounce);
    };
  }, [demoMode]);

  const clientOptsForFilters = useMemo (() => clientOptions, [clientOptions]);

  const handleSync = useCallback (
    async (a: SchedulingAppointment) => {
      setSyncLoadingId (a.id);
      try {
        const result = await syncToGoogleCalendar ({
          id: a.id,
          title: a.title,
          startTime: a.startTime,
          endTime: a.endTime,
          location: a.location,
          notes: a.notes,
          status: a.status,
          googleCalendarEventId: a.googleCalendarEventId,
        });

        if (!result.success) {
          pushToast ({
            kind: 'error',
            message: result.error || 'Sync failed.',
            actionLabel: 'Retry',
            onAction: () => void handleSync (a),
          });
          return;
        }

        const syncedAt = new Date ().toISOString ();

        if (demoMode) {
          setAppointments ((prev) =>
            prev.map ((row) =>
              row.id === a.id
                ? { ...row, googleCalendarEventId: result.googleEventId, syncedAt }
                : row,
            ),
          );
        } else {
          const supabase = getSupabase ();
          const orgId = getOrgId ();
          if (supabase && orgId) {
            const { error } = await supabase
              .from ('appointments')
              .update ({
                google_calendar_event_id: result.googleEventId,
                synced_at: syncedAt,
              })
              .eq ('id', a.id)
              .eq ('organization_id', orgId);
            if (error) console.error ('sync update', error);
          }
          setRefreshToken ((t) => t + 1);
        }

        pushToast ({ kind: 'success', message: 'Synced to Google Calendar.' });
      } finally {
        setSyncLoadingId (null);
      }
    },
    [demoMode, pushToast],
  );

  const handleCancelAppt = useCallback (
    async (a: SchedulingAppointment) => {
      if (demoMode) {
        setAppointments ((prev) =>
          prev.map ((row) => (row.id === a.id ? { ...row, status: 'cancelled' as const } : row)),
        );
        pushToast ({ kind: 'success', message: 'Appointment cancelled.' });
        return;
      }
      const supabase = getSupabase ();
      const orgId = getOrgId ();
      if (!supabase || !orgId) {
        pushToast ({ kind: 'error', message: 'Sign in and select a workspace to cancel appointments.' });
        return;
      }
      const { error } = await supabase.from ('appointments').update ({ status: 'cancelled' }).eq ('id', a.id).eq ('organization_id', orgId);
      if (error) {
        pushToast ({ kind: 'error', message: error.message });
        return;
      }
      setRefreshToken ((t) => t + 1);
      pushToast ({ kind: 'success', message: 'Appointment cancelled.' });
    },
    [demoMode, pushToast],
  );

  const handleUpdateAppointment = useCallback (
    async (
      id: string,
      payload: {
        title: string;
        clientId: string | null;
        startTime: string;
        endTime: string;
        location: string | null;
        notes: string | null;
        color: AppointmentColor | null;
      },
    ) => {
      if (demoMode) {
        pushToast ({ kind: 'error', message: 'Demo appointments are read-only and are not stored locally.' });
        throw new Error ('demo-mode');
      }

      const supabase = getSupabase ();
      const orgId = getOrgId ();
      if (!supabase || !orgId) {
        pushToast ({ kind: 'error', message: 'Sign in and select a workspace to edit appointments.' });
        throw new Error ('no-session');
      }

      const { error } = await supabase
        .from ('appointments')
        .update ({
          client_id: payload.clientId,
          title: payload.title,
          start_time: payload.startTime,
          end_time: payload.endTime,
          location: payload.location,
          notes: payload.notes,
          color: payload.color,
        })
        .eq ('id', id)
        .eq ('organization_id', orgId);

      if (error) {
        pushToast ({ kind: 'error', message: error.message });
        throw error;
      }

      setRefreshToken ((t) => t + 1);
      pushToast ({ kind: 'success', message: 'Appointment updated.' });
    },
    [demoMode, pushToast],
  );

  const handleDeleteAppointment = useCallback (
    async (id: string) => {
      if (demoMode) {
        pushToast ({ kind: 'error', message: 'Demo appointments are read-only and are not stored locally.' });
        throw new Error ('demo-mode');
      }

      const supabase = getSupabase ();
      const orgId = getOrgId ();
      if (!supabase || !orgId) {
        pushToast ({ kind: 'error', message: 'Sign in and select a workspace to delete appointments.' });
        throw new Error ('no-session');
      }

      const { error } = await supabase
        .from ('appointments')
        .delete ()
        .eq ('id', id)
        .eq ('organization_id', orgId);

      if (error) {
        pushToast ({ kind: 'error', message: error.message });
        throw error;
      }

      setRefreshToken ((t) => t + 1);
      pushToast ({ kind: 'success', message: 'Appointment deleted.' });
    },
    [demoMode, pushToast],
  );

  const handleFormSubmit = useCallback (
    async (payload: {
      title: string;
      clientId: string | null;
      startTime: string;
      endTime: string;
      location: string | null;
      notes: string | null;
      color?: AppointmentColor | null;
      syncToGoogle: boolean;
    }) => {
      if (demoMode) {
        pushToast ({ kind: 'error', message: 'Demo appointments are read-only and are not stored locally.' });
        return;
      }

      const supabase = getSupabase ();
      const orgId = getOrgId ();
      if (!supabase || !orgId) {
        pushToast ({ kind: 'error', message: 'Sign in and select a workspace to save appointments.' });
        return;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser ();
      if (!user) {
        pushToast ({ kind: 'error', message: 'Session expired. Sign in again.' });
        return;
      }

      const labelFromOptions =
        payload.clientId != null ? clientOptions.find ((c) => c.id === payload.clientId)?.label ?? null : null;

      if (editTarget) {
        const { error } = await supabase
          .from ('appointments')
          .update ({
            client_id: payload.clientId,
            title: payload.title,
            start_time: payload.startTime,
            end_time: payload.endTime,
            location: payload.location,
            notes: payload.notes,
            color: payload.color ?? null,
          })
          .eq ('id', editTarget.id)
          .eq ('organization_id', orgId);

        if (error) {
          pushToast ({ kind: 'error', message: error.message });
          return;
        }

        let googleId: string | null = editTarget.googleCalendarEventId;
        let syncedAt: string | null = editTarget.syncedAt;

        if (payload.syncToGoogle) {
          const rowRes = await supabase.from ('appointments').select ('*').eq ('id', editTarget.id).single ();
          const row = rowRes.data as AppointmentRow | null;
          if (row) {
            const mapped = rowToSchedulingAppointment (row, Object.fromEntries (clientOptions.map ((c) => [c.id, c.label])));
            const syn = await syncToGoogleCalendar ({
              id: mapped.id,
              title: mapped.title,
              startTime: mapped.startTime,
              endTime: mapped.endTime,
              location: mapped.location,
              notes: mapped.notes,
              status: mapped.status,
              googleCalendarEventId: mapped.googleCalendarEventId,
            });
            if (syn.success) {
              googleId = syn.googleEventId;
              syncedAt = new Date ().toISOString ();
              await supabase
                .from ('appointments')
                .update ({
                  google_calendar_event_id: googleId,
                  synced_at: syncedAt,
                })
                .eq ('id', editTarget.id)
                .eq ('organization_id', orgId);
              pushToast ({ kind: 'success', message: 'Synced to Google Calendar.' });
            }
          }
        }

        setEditTarget (null);
        setRefreshToken ((t) => t + 1);
        pushToast ({ kind: 'success', message: 'Appointment updated.' });
        setSubView ('calendar');
        return;
      }

      const insertBody = {
        organization_id: orgId,
        user_id: user.id,
        client_id: payload.clientId,
        title: payload.title,
        start_time: payload.startTime,
        end_time: payload.endTime,
        location: payload.location,
        notes: payload.notes,
        color: payload.color ?? null,
        status: 'pending' as const,
      };

      const { data: inserted, error } = await supabase.from ('appointments').insert (insertBody).select ('*').maybeSingle ();

      if (error || !inserted) {
        pushToast ({ kind: 'error', message: error?.message ?? 'Could not create appointment.' });
        return;
      }

      const row = inserted as AppointmentRow;
      const names: Record<string, string> = Object.fromEntries (clientOptions.map ((c) => [c.id, c.label]));
      if (payload.clientId && labelFromOptions) names[payload.clientId] = labelFromOptions;

      let googleId: string | null = null;
      let syncedAt: string | null = null;

      if (payload.syncToGoogle) {
        const mapped = rowToSchedulingAppointment (row, names);
        const syn = await syncToGoogleCalendar ({
          id: mapped.id,
          title: mapped.title,
          startTime: mapped.startTime,
          endTime: mapped.endTime,
          location: mapped.location,
          notes: mapped.notes,
          status: mapped.status,
          googleCalendarEventId: null,
        });
        if (syn.success) {
          googleId = syn.googleEventId;
          syncedAt = new Date ().toISOString ();
          await supabase
            .from ('appointments')
            .update ({
              google_calendar_event_id: googleId,
              synced_at: syncedAt,
            })
            .eq ('id', row.id)
            .eq ('organization_id', orgId);
          pushToast ({ kind: 'success', message: 'Synced to Google Calendar.' });
        }
      }

      setRefreshToken ((t) => t + 1);
      pushToast ({ kind: 'success', message: 'Appointment created.' });
      setSubView ('calendar');
    },
    [clientOptions, demoMode, editTarget, pushToast],
  );

  return (
    <div className="scheduling-root min-h-[420px]">
      <div className="ph">
        <div>
          <div className="pt">Calendar</div>
          <div className="ps">
            Calendar and appointments for your workspace. Google Calendar sync is stubbed until OAuth is enabled.
          </div>
        </div>
        <button type="button" className="btn btn-p" onClick={() => setConnectOpen (true)}>
          Connect Google Calendar
        </button>
      </div>

      <nav className="sched-view-tabs" aria-label="Calendar views">
        <button
          type="button"
          className={`btn spend-ctype sched-tab-btn${subView === 'calendar' ? ' on' : ''}`}
          onClick={() => setSubView ('calendar')}
        >
          <CalendarIcon className="h-4 w-4 shrink-0" aria-hidden />
          Calendar
        </button>
        <button
          type="button"
          className={`btn spend-ctype sched-tab-btn${subView === 'list' ? ' on' : ''}`}
          onClick={() => setSubView ('list')}
        >
          <QueueListIcon className="h-4 w-4 shrink-0" aria-hidden />
          Appointments
        </button>
        <button
          type="button"
          className={`btn spend-ctype sched-tab-btn${subView === 'new' ? ' on' : ''}`}
          onClick={() => {
            setEditTarget (null);
            setSubView ('new');
          }}
        >
          <PlusCircleIcon className="h-4 w-4 shrink-0" aria-hidden />
          New appointment
        </button>
      </nav>

      {loading ? (
        <p style={{ fontSize: '13px', color: 'var(--text3)' }}>Loading appointments…</p>
      ) : (
        <>
          {subView === 'calendar' ? (
            <>
              <CalendarView
                appointments={appointments}
                clientOptions={clientOptions}
                onSelect={(a) => setDetail (a)}
                onCreateAppointment={demoMode ? undefined : handleFormSubmit}
                onUpdateAppointment={demoMode ? undefined : handleUpdateAppointment}
                onDeleteAppointment={demoMode ? undefined : handleDeleteAppointment}
              />
              {appointments.length === 0 ? (
                <p className="sched-empty-sub" style={{ marginTop: '12px', textAlign: 'center' }}>
                  {demoMode
                    ? 'No demo appointments loaded — try leaving and re-opening View Demo.'
                    : 'No appointments yet. Use New appointment to add one, or connect clients under Customers.'}
                </p>
              ) : null}
            </>
          ) : null}
          {subView === 'list' ? (
            <AppointmentsList
              appointments={appointments}
              clientOptions={clientOptsForFilters}
              onSelect={(a) => setDetail (a)}
              onEdit={(a) => {
                setEditTarget (a);
                setSubView ('new');
              }}
              onCancel={handleCancelAppt}
              onSync={handleSync}
              syncLoadingId={syncLoadingId}
            />
          ) : null}
          {subView === 'new' ? (
            <NewAppointmentForm
              clientOptions={clientOptions}
              demoMode={demoMode}
              initial={editTarget}
              onSubmit={handleFormSubmit}
              onCancelEdit={() => setEditTarget (null)}
            />
          ) : null}
        </>
      )}

      <AppointmentDetailDrawer
        appointment={detail}
        onClose={() => setDetail (null)}
        onEdit={(a) => {
          setEditTarget (a);
          setDetail (null);
          setSubView ('new');
        }}
      />

      <GoogleCalendarModal open={connectOpen} onClose={() => setConnectOpen (false)} />

      <div className="pointer-events-none fixed bottom-4 right-4 z-[130] flex max-w-sm flex-col gap-2">
        {toasts.map ((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto border px-4 py-3 text-sm ${
              t.kind === 'success'
                ? 'border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100'
                : 'border-red-500/40 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <span>{t.message}</span>
              {t.actionLabel && t.onAction ? (
                <button type="button" className="shrink-0 font-semibold underline" onClick={t.onAction}>
                  {t.actionLabel}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
