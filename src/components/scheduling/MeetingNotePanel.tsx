import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Sparkles, X } from 'lucide-react';
import { RecordingBar } from '@/components/scheduling/RecordingBar';
import type { MeetingActionItem, MeetingNote, SchedulingAppointment } from '@/components/scheduling/types';
import { rowToMeetingNote, type MeetingNoteRow } from '@/lib/scheduling/supabase';
import { isWorkspaceReadyForTranscription, useTranscription } from '@/lib/scheduling/useTranscription';

type MeetingNotePanelProps = {
  open: boolean;
  organizationId: string | null;
  supabase: SupabaseClient | null;
  appointment: SchedulingAppointment | null;
  onClose: () => void;
};

type AdvisorPayload = {
  summary: string;
  action_items: Array<{ task: string; owner: string; due_date: string | null }>;
  key_decisions: string[];
  topics: string[];
};

const SAVE_DEBOUNCE_MS = 700;

function emptyMeetingActionItems (): MeetingActionItem[] {
  return [];
}

function normalizeActionItems (
  arr: Array<{ task: string; owner: string; due_date: string | null }>,
): MeetingActionItem[] {
  return (arr || [])
    .map ((item) => ({
      task: String (item.task || '').trim (),
      owner: String (item.owner || '').trim (),
      dueDate: item.due_date ? String (item.due_date) : null,
      completed: false,
    }))
    .filter ((item) => !!item.task);
}

function safeJsonParse<T> (raw: string): T | null {
  try {
    return JSON.parse (raw) as T;
  } catch {
    return null;
  }
}

function parseMeetingSummaryFromAdvisorPayload (payload: unknown): AdvisorPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as {
    meetingSummary?: unknown;
    draft?: unknown;
    error?: unknown;
    details?: unknown;
  };
  if (body.meetingSummary && typeof body.meetingSummary === 'object') {
    const ms = body.meetingSummary as AdvisorPayload;
    if (typeof ms.summary === 'string' && Array.isArray (ms.action_items) && Array.isArray (ms.topics)) {
      return ms;
    }
  }
  const draft =
    typeof body.draft === 'string'
      ? body.draft.trim ()
      : '';
  if (draft) {
    const direct = safeJsonParse<AdvisorPayload> (draft);
    if (direct && typeof direct.summary === 'string' && Array.isArray (direct.action_items) && Array.isArray (direct.topics)) {
      return direct;
    }
    const firstBrace = draft.indexOf ('{');
    const lastBrace = draft.lastIndexOf ('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = safeJsonParse<AdvisorPayload> (draft.slice (firstBrace, lastBrace + 1));
      if (sliced && typeof sliced.summary === 'string' && Array.isArray (sliced.action_items) && Array.isArray (sliced.topics)) {
        return sliced;
      }
    }
  }
  return null;
}

async function callAdvisorForMeetingSummary (
  supabase: SupabaseClient,
  organizationId: string,
  title: string,
  attendees: string,
  transcript: string,
  manualNotes: string,
): Promise<AdvisorPayload> {
  const sessionRes = await supabase.auth.getSession ();
  const accessToken = sessionRes.data.session?.access_token || '';
  const base = typeof window !== 'undefined'
    ? String ((window as unknown as { __bizdashSupabaseUrl?: string }).__bizdashSupabaseUrl || '').trim ().replace (/\/$/, '')
    : '';
  const anon = typeof window !== 'undefined'
    ? String ((window as unknown as { __bizdashSupabaseAnonKey?: string }).__bizdashSupabaseAnonKey || '').trim ()
    : '';
  if (!accessToken || !base || !anon) {
    throw new Error ('Sign in again to use Advisor summarization.');
  }

  const message =
    `Meeting: ${title}\n` +
    `Attendees: ${attendees || '(not specified)'}\n` +
    `Transcript:\n${transcript || '(empty)'}\n\n` +
    `Manual notes from user:\n${manualNotes || '(empty)'}`;

  const res = await fetch (`${base}/functions/v1/ai-assistant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: anon,
    },
    body: JSON.stringify ({
      organizationId,
      task: 'meeting_summary',
      message,
    }),
  });
  const payload = await res.json ().catch (() => ({}));
  if (!res.ok) {
    const errMsg =
      typeof (payload as { error?: unknown }).error === 'string'
        ? String ((payload as { error: string }).error)
        : `Advisor request failed (${res.status}).`;
    throw new Error (errMsg);
  }

  const parsed = parseMeetingSummaryFromAdvisorPayload (payload);
  if (!parsed) {
    const degraded =
      typeof (payload as { error?: unknown }).error === 'string'
        ? String ((payload as { error: string }).error)
        : '';
    const details =
      typeof (payload as { details?: unknown }).details === 'string'
        ? String ((payload as { details: string }).details)
        : '';
    throw new Error (
      degraded || details
        ? `${degraded}${details ? ` (${details})` : ''}`
        : 'Could not parse meeting summary from Advisor. Try again or add more transcript text.',
    );
  }
  return parsed;
}

export function MeetingNotePanel ({
  open,
  organizationId,
  supabase,
  appointment,
  onClose,
}: MeetingNotePanelProps) {
  const [note, setNote] = useState<MeetingNote | null> (null);
  const [loading, setLoading] = useState (false);
  const [saveError, setSaveError] = useState<string | null> (null);
  const [rawNotes, setRawNotes] = useState ('');
  const [manualNotes, setManualNotes] = useState ('');
  const [summary, setSummary] = useState ('');
  const [actionItems, setActionItems] = useState<MeetingActionItem[]> (emptyMeetingActionItems ());
  const [decisions, setDecisions] = useState<string[]> ([]);
  const [topics, setTopics] = useState<string[]> ([]);
  const [summarizing, setSummarizing] = useState (false);
  const [advisorError, setAdvisorError] = useState<string | null> (null);
  const [hasSummarized, setHasSummarized] = useState (false);
  const transcriptScrollRef = useRef<HTMLTextAreaElement | null> (null);
  const saveDebounceRef = useRef<number | null> (null);
  const prevTranscriptRef = useRef ('');

  const {
    status: transcriptionStatus,
    transcript,
    interimText,
    error: transcriptionError,
    duration,
    start,
    pause,
    resume,
    stop,
    setTranscript,
  } = useTranscription ();

  const title = useMemo (() => {
    if (note?.title) return note.title;
    return appointment?.title || 'Untitled meeting';
  }, [note?.title, appointment?.title]);
  const attendeesLabel = useMemo (() => {
    if (!note?.attendees?.length) return '';
    return note.attendees.map ((a) => a.name || a.email).filter (Boolean).join (', ');
  }, [note?.attendees]);

  const isRecording = transcriptionStatus === 'recording' || transcriptionStatus === 'paused' || transcriptionStatus === 'requesting';

  const closeWithGuard = useCallback (() => {
    if (!isRecording) {
      onClose ();
      return;
    }
    const ok = window.confirm ('Recording is in progress. Stop recording before closing?');
    if (!ok) return;
    stop ();
    onClose ();
  }, [isRecording, onClose, stop]);

  useEffect (() => {
    if (!open || !supabase || !organizationId) return;
    let cancelled = false;
    setLoading (true);
    setSaveError (null);
    setAdvisorError (null);
    void (async () => {
      const query = supabase
        .from ('meeting_notes')
        .select ('*')
        .eq ('organization_id', organizationId)
        .order ('updated_at', { ascending: false })
        .limit (1);
      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        setLoading (false);
        setSaveError ('Sorry, we could not complete your request.');
        return;
      }
      if (data && data.length > 0) {
        const mapped = rowToMeetingNote (data[0] as MeetingNoteRow);
        setNote (mapped);
        setRawNotes (mapped.rawNotes || '');
        setManualNotes (mapped.manualNotes || '');
        setSummary (mapped.summary || '');
        setActionItems (mapped.actionItems || []);
        setDecisions ((mapped.decisions || '').split ('\n').map ((x) => x.trim ()).filter (Boolean));
        setTopics (mapped.topics || []);
        setTranscript (mapped.transcript || mapped.rawNotes || '');
        prevTranscriptRef.current = mapped.transcript || mapped.rawNotes || '';
      } else {
        const insertBody = {
          organization_id: organizationId,
          contact_id: appointment?.clientId ?? null,
          title: appointment?.title || 'Untitled meeting',
          attendees: [],
          scheduled_at: appointment?.startTime || null,
          raw_notes: '',
          manual_notes: '',
          action_items: [],
          decisions: '',
          summary: '',
          topics: [],
          transcript_duration: 0,
          status: 'draft',
        };
        const { data: created, error: createErr } = await supabase
          .from ('meeting_notes')
          .insert (insertBody)
          .select ('*')
          .single ();
        if (cancelled) return;
        if (createErr || !created) {
          setSaveError ('Sorry, we could not complete your request.');
          setLoading (false);
          return;
        }
        const mapped = rowToMeetingNote (created as MeetingNoteRow);
        setNote (mapped);
        setRawNotes ('');
        setManualNotes ('');
        setSummary ('');
        setActionItems (emptyMeetingActionItems ());
        setDecisions ([]);
        setTopics ([]);
        setTranscript ('');
        prevTranscriptRef.current = '';
      }
      setLoading (false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, supabase, organizationId, appointment?.clientId, appointment?.startTime, appointment?.title, setTranscript]);

  useEffect (() => {
    if (!transcript) return;
    const prev = prevTranscriptRef.current;
    prevTranscriptRef.current = transcript;
    if (!prev) {
      setRawNotes (transcript);
      return;
    }
    if (transcript.startsWith (prev)) {
      const delta = transcript.slice (prev.length).trim ();
      if (delta) {
        setRawNotes ((r) => `${r}${r ? ' ' : ''}${delta}`.trim ());
      }
      return;
    }
    setRawNotes (transcript);
  }, [transcript]);

  useEffect (() => {
    if (!open || !note || !supabase || !organizationId) return;
    if (saveDebounceRef.current != null) window.clearTimeout (saveDebounceRef.current);
    saveDebounceRef.current = window.setTimeout (() => {
      void (async () => {
        const { error } = await supabase
          .from ('meeting_notes')
          .update ({
            raw_notes: rawNotes,
            manual_notes: manualNotes,
            transcript: transcript,
            transcript_duration: duration,
            updated_at: new Date ().toISOString (),
          })
          .eq ('id', note.id)
          .eq ('organization_id', organizationId);
        if (error) setSaveError ('Sorry, we could not complete your request.');
      })();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveDebounceRef.current != null) window.clearTimeout (saveDebounceRef.current);
    };
  }, [open, note, supabase, organizationId, rawNotes, manualNotes, transcript, duration]);

  useEffect (() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [rawNotes, interimText]);

  const summarizeWithAdvisor = useCallback (async () => {
    if (!supabase || !organizationId || !note) {
      setAdvisorError ('Workspace is still loading. Wait a moment and try again.');
      return;
    }
    if (!rawNotes.trim () && !manualNotes.trim ()) {
      setAdvisorError ('Add a transcript or notes before summarizing.');
      return;
    }
    setSummarizing (true);
    setAdvisorError (null);
    try {
      const parsed = await callAdvisorForMeetingSummary (
        supabase,
        organizationId,
        title,
        attendeesLabel,
        rawNotes,
        manualNotes,
      );
      const normalizedActionItems = normalizeActionItems (parsed.action_items);
      const normalizedTopics = (parsed.topics || []).map ((x) => String (x || '').trim ()).filter (Boolean);
      const normalizedDecisions = (parsed.key_decisions || []).map ((x) => String (x || '').trim ()).filter (Boolean);
      setSummary (parsed.summary);
      setActionItems (normalizedActionItems);
      setTopics (normalizedTopics);
      setDecisions (normalizedDecisions);
      setHasSummarized (true);
      const { error } = await supabase
        .from ('meeting_notes')
        .update ({
          summary: parsed.summary,
          action_items: normalizedActionItems.map ((x) => ({
            task: x.task,
            owner: x.owner,
            due_date: x.dueDate,
            completed: x.completed,
          })),
          decisions: normalizedDecisions.join ('\n'),
          topics: normalizedTopics,
          raw_notes: rawNotes,
          manual_notes: manualNotes,
          updated_at: new Date ().toISOString (),
        })
        .eq ('id', note.id)
        .eq ('organization_id', organizationId);
      if (error) throw new Error ('Sorry, we could not complete your request.');
    } catch (err) {
      setAdvisorError (err instanceof Error ? err.message : 'Sorry, we could not complete your request.');
    } finally {
      setSummarizing (false);
    }
  }, [attendeesLabel, manualNotes, note, organizationId, rawNotes, supabase, title]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[180] bg-black/35" onClick={closeWithGuard}>
      <div
        className="ml-auto flex h-full w-full max-w-[980px] flex-col border-l border-[var(--border)] bg-[var(--bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation ()}
      >
        <div className="flex items-start justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">{title}</h2>
            <p className="text-xs text-[var(--text3)]">Meeting note intelligence</p>
          </div>
          <button type="button" className="btn inline-flex items-center gap-2" onClick={closeWithGuard}>
            <X className="h-4 w-4" aria-hidden />
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <RecordingBar
            status={transcriptionStatus}
            duration={duration}
            error={transcriptionError}
            workspaceReady={!!organizationId && isWorkspaceReadyForTranscription ()}
            onStart={() => {
              void start ();
            }}
            onPause={pause}
            onResume={resume}
            onStop={stop}
          />

          {loading ? <p className="text-sm text-[var(--text3)]">Loading meeting note…</p> : null}

          <div className="space-y-4">
            {rawNotes.trim () ? (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-5">
                <div className="lg:col-span-3">
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text3)]">
                    Transcript
                  </label>
                  <textarea
                    ref={transcriptScrollRef}
                    className="fi min-h-[260px] w-full resize-y"
                    value={rawNotes}
                    onChange={(e) => {
                      setRawNotes (e.target.value);
                      setHasSummarized (false);
                    }}
                  />
                  {interimText ? (
                    <p className="mt-2 text-xs text-[var(--text3)]">{interimText}</p>
                  ) : null}
                </div>
                <div className="lg:col-span-2">
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text3)]">
                    Your Notes
                  </label>
                  <textarea
                    className="fi min-h-[260px] w-full resize-y"
                    value={manualNotes}
                    onChange={(e) => {
                      setManualNotes (e.target.value);
                      setHasSummarized (false);
                    }}
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-[var(--text3)]">
                  Raw Notes
                </label>
                <textarea
                  className="fi min-h-[260px] w-full resize-y"
                  value={rawNotes}
                  onChange={(e) => {
                    setRawNotes (e.target.value);
                    setHasSummarized (false);
                  }}
                />
                {interimText ? (
                  <p className="mt-2 text-xs text-[var(--text3)]">{interimText}</p>
                ) : null}
              </div>
            )}

            {(transcriptionStatus === 'stopped' || rawNotes.trim () || manualNotes.trim ()) ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg2)] p-3">
                <button
                  type="button"
                  className="btn btn-p inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void summarizeWithAdvisor ()}
                  disabled={summarizing || !organizationId}
                >
                  <Sparkles className="h-4 w-4" aria-hidden />
                  {summarizing ? 'Summarizing…' : hasSummarized ? 'Regenerate' : 'Summarize with Advisor'}
                </button>
                {advisorError ? <p className="mt-2 text-xs text-[var(--red)]">{advisorError}</p> : null}
              </div>
            ) : null}

            {summary ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg2)] p-4">
                <h3 className="text-sm font-semibold text-[var(--text)]">Summary</h3>
                <p className="mt-2 text-sm text-[var(--text2)]">{summary}</p>
              </div>
            ) : null}

            {actionItems.length ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--bg)] p-4">
                <h3 className="text-sm font-semibold text-[var(--text)]">Action Items</h3>
                <ul className="mt-2 space-y-2">
                  {actionItems.map ((item, idx) => (
                    <li key={`${item.task}-${idx}`} className="rounded-lg border border-[var(--border)] bg-[var(--bg2)] px-3 py-2 text-sm">
                      <div className="font-medium text-[var(--text)]">{item.task}</div>
                      <div className="text-xs text-[var(--text3)]">
                        {item.owner || 'Unassigned'}
                        {item.dueDate ? ` · ${item.dueDate}` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {topics.length ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-[var(--text)]">Topics</h3>
                <div className="flex flex-wrap gap-2">
                  {topics.map ((topic, idx) => (
                    <span key={`${topic}-${idx}`} className="rounded-full border border-[var(--border)] bg-[var(--bg2)] px-3 py-1 text-xs text-[var(--text2)]">
                      {topic}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {decisions.length ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-[var(--text)]">Key Decisions</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--text2)]">
                  {decisions.map ((decision, idx) => <li key={`${decision}-${idx}`}>{decision}</li>)}
                </ul>
              </div>
            ) : null}

            {saveError ? <p className="text-xs text-[var(--red)]">{saveError}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
