import {
  SpeakerWaveIcon,
  CheckIcon,
  DocumentDuplicateIcon,
  ArrowPathIcon,
  Cog6ToothIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { InlineRecordingBar } from '@/components/scheduling/InlineRecordingBar';
import { MeetingSummaryMarkdown } from '@/components/scheduling/MeetingSummaryMarkdown';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { isDemoMode } from '@/lib/demoMode';
import { useMeetingNote } from '@/lib/scheduling/useMeetingNote';
import {
  BIZDASH_ORG_CONTEXT_EVENT,
  useTranscription,
  useTranscriptionReady,
} from '@/lib/scheduling/useTranscription';

function getSupabase (): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { supabaseClient?: SupabaseClient }).supabaseClient;
  return c ?? null;
}

function getOrgId (): string | null {
  if (typeof window === 'undefined') return null;
  const fn = (window as unknown as { bizDashGetCurrentOrgId?: () => string | null }).bizDashGetCurrentOrgId;
  const id = typeof fn === 'function' ? fn () : null;
  return id && String (id).trim () ? String (id).trim () : null;
}

function readSelectedNoteId (): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const mode = sessionStorage.getItem ('meeting-notes-mode');
    if (mode === 'new') return '__new';
    const id = sessionStorage.getItem ('meeting-notes-active-id');
    return id && id.trim () ? id.trim () : null;
  } catch (_) {
    return null;
  }
}

const CONSENT_ACK_STORAGE_KEY = 'meeting-notes:consent-ack:v1';
const MEETING_PREFS_STORAGE_KEY = 'meeting-notes:prefs:v1';

type SummaryStyle = 'auto' | 'bullets' | 'actions' | 'decisions';

type MeetingNotesPrefs = {
  summaryStyle: SummaryStyle;
  autoSummarizeOnStop: boolean;
};

function readConsentAcknowledged (): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem (CONSENT_ACK_STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function readMeetingNotesPrefs (): MeetingNotesPrefs {
  const defaults: MeetingNotesPrefs = {
    summaryStyle: 'auto',
    autoSummarizeOnStop: true,
  };
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = localStorage.getItem (MEETING_PREFS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse (raw) as Partial<MeetingNotesPrefs>;
    const summaryStyle = parsed.summaryStyle;
    const safeSummaryStyle: SummaryStyle =
      summaryStyle === 'bullets' || summaryStyle === 'actions' || summaryStyle === 'decisions'
        ? summaryStyle
        : 'auto';
    return {
      summaryStyle: safeSummaryStyle,
      autoSummarizeOnStop: parsed.autoSummarizeOnStop !== false,
    };
  } catch (_) {
    return defaults;
  }
}

function writeMeetingNotesPrefs (prefs: MeetingNotesPrefs) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem (MEETING_PREFS_STORAGE_KEY, JSON.stringify (prefs));
  } catch (_) {}
}

/**
 * The consent-ack button needs explicit inline styles to defeat Safari's native button
 * chrome (gradient, shadow, appearance), which means Tailwind's :hover/:active classes
 * never win. Track interaction state in React and apply the background via inline style.
 */
function ConsentAckButton ({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState (false);
  const [active, setActive] = useState (false);
  const background = active ? '#cfe0f2' : hover ? '#dbeaff' : '#ffffff';
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover (true)}
      onMouseLeave={() => {
        setHover (false);
        setActive (false);
      }}
      onMouseDown={() => setActive (true)}
      onMouseUp={() => setActive (false)}
      onBlur={() => setActive (false)}
      className="inline-flex h-8 cursor-pointer items-center justify-center rounded-xl border border-[#8fb9e3] px-3 text-sm font-medium text-[#2f5f92] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8fb9e3]"
      style={{
        background,
        backgroundImage: 'none',
        borderStyle: 'solid',
        WebkitAppearance: 'none',
        appearance: 'none',
        boxShadow: 'none',
        filter: 'none',
        transition: 'background-color 120ms ease',
      }}
    >
      I have received consent to record
    </button>
  );
}

function buildCopyText (params: {
  headerDate: string;
  transcript: string;
  summary: string;
  actionItems: Array<{ task: string; owner?: string; dueDate?: string | null }>;
  decisions: string[];
  topics: string[];
}): string {
  const transcript = params.transcript.trim ();
  const summary = params.summary.trim ();
  const sections: string[] = ['# Meeting', params.headerDate];

  if (transcript) {
    sections.push ('', '## Transcript', transcript);
  }
  if (summary) {
    sections.push ('', '## Summary', summary);
  }
  if (params.actionItems.length) {
    sections.push ('', '## Action items');
    for (const item of params.actionItems) {
      const owner = String (item.owner || '').trim ();
      const due = item.dueDate ? String (item.dueDate) : '';
      const tail = owner || due
        ? ` (${[owner, due].filter (Boolean).join (' - ')})`
        : '';
      sections.push (`- [ ] ${item.task}${tail}`);
    }
  }
  if (params.decisions.length) {
    sections.push ('', '## Decisions');
    for (const decision of params.decisions) {
      sections.push (`- ${decision}`);
    }
  }
  if (params.topics.length) {
    sections.push ('', '## Topics', params.topics.map ((topic) => `- ${topic}`).join ('\n'));
  }
  return sections.join ('\n');
}

export function MeetingNotesPage () {
  const [organizationId, setOrganizationId] = useState<string | null> (() => getOrgId ());
  const supabase = getSupabase ();
  const transcriptionReady = useTranscriptionReady ();
  const [pageVisible, setPageVisible] = useState (false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null> (() => readSelectedNoteId ());
  const [consentAcknowledged, setConsentAcknowledged] = useState<boolean> (() => readConsentAcknowledged ());
  const [prefs, setPrefs] = useState<MeetingNotesPrefs> (() => readMeetingNotesPrefs ());
  const [copyState, setCopyState] = useState<'idle' | 'copied'> ('idle');

  const acknowledgeConsent = useCallback (() => {
    setConsentAcknowledged (true);
    try {
      localStorage.setItem (CONSENT_ACK_STORAGE_KEY, '1');
    } catch (_) {}
  }, []);

  const setSummaryStyle = useCallback ((summaryStyle: SummaryStyle) => {
    setPrefs ((prev) => {
      const next = { ...prev, summaryStyle };
      writeMeetingNotesPrefs (next);
      return next;
    });
  }, []);

  const setAutoSummarizeOnStop = useCallback ((enabled: boolean) => {
    setPrefs ((prev) => {
      const next = { ...prev, autoSummarizeOnStop: enabled };
      writeMeetingNotesPrefs (next);
      return next;
    });
  }, []);

  useEffect (() => {
    const syncOrg = () => setOrganizationId (getOrgId ());
    syncOrg ();
    window.addEventListener (BIZDASH_ORG_CONTEXT_EVENT, syncOrg);
    const intervalId = window.setInterval (syncOrg, 400);
    return () => {
      window.removeEventListener (BIZDASH_ORG_CONTEXT_EVENT, syncOrg);
      window.clearInterval (intervalId);
    };
  }, []);

  useEffect (() => {
    const onOpen = (ev: Event) => {
      const detail = (ev as CustomEvent<{ id?: string; mode?: string }>).detail || {};
      if (detail.mode === 'new') {
        setSelectedNoteId ('__new');
        return;
      }
      if (detail.mode === 'latest') {
        setSelectedNoteId (null);
        return;
      }
      if (detail.id) {
        setSelectedNoteId (String (detail.id));
        return;
      }
      setSelectedNoteId (readSelectedNoteId ());
    };
    window.addEventListener ('meeting-note-open', onOpen);
    return () => window.removeEventListener ('meeting-note-open', onOpen);
  }, []);

  useEffect (() => {
    const page = document.getElementById ('page-meeting-notes');
    if (!page) return;
    const sync = () => {
      const visible = page.classList.contains ('on');
      setPageVisible (visible);
      if (visible) setSelectedNoteId (readSelectedNoteId ());
    };
    const obs = new MutationObserver (sync);
    obs.observe (page, { attributes: true, attributeFilter: ['class'] });
    sync ();
    return () => obs.disconnect ();
  }, []);

  const {
    status: transcriptionStatus,
    transcript,
    interimText,
    error: transcriptionError,
    duration,
    analyserRef,
    start,
    pause,
    resume,
    stop,
    setTranscript,
  } = useTranscription ();

  const {
    note,
    saveError,
    rawNotes,
    summary,
    actionItems,
    decisions,
    topics,
    summarizing,
    summaryError,
    hasSummarized,
    summarize,
  } = useMeetingNote ({
    organizationId,
    supabase,
    appointment: null,
    transcript,
    duration,
    setTranscript,
    selectedNoteId,
  });

  useEffect (() => {
    if (!note?.id) return;
    if (selectedNoteId === '__new') {
      try {
        sessionStorage.removeItem ('meeting-notes-mode');
        sessionStorage.setItem ('meeting-notes-active-id', String (note.id));
      } catch (_) {}
      setSelectedNoteId (String (note.id));
    }
    const refresh = (window as unknown as {
      bizDashRefreshMeetingNotesSidebar?: () => void;
    }).bizDashRefreshMeetingNotesSidebar;
    if (typeof refresh === 'function') {
      try { refresh (); } catch (_) {}
    }
  }, [note?.id, selectedNoteId]);

  const now = new Date ();
  const headerDate = `@${now.toLocaleDateString (undefined, { weekday: 'long' })} ${now.toLocaleTimeString ([], { hour: 'numeric', minute: '2-digit' })}`;

  const isActive =
    transcriptionStatus === 'recording' ||
    transcriptionStatus === 'paused' ||
    transcriptionStatus === 'requesting';

  const handleStop = useCallback (() => {
    const captured = interimText
      ? `${transcript}${transcript ? ' ' : ''}${interimText}`.trim ()
      : transcript.trim () || rawNotes.trim ();
    console.info ('[meeting-notes] stop clicked', {
      capturedLen: captured.length,
      transcriptLen: transcript.length,
      interimLen: interimText.length,
      rawNotesLen: rawNotes.length,
      organizationId,
      hasSupabase: !!supabase,
    });
    stop ();
    if (prefs.autoSummarizeOnStop) {
      void summarize (captured || undefined, { summaryStyle: prefs.summaryStyle });
    }
  }, [stop, summarize, transcript, interimText, rawNotes, organizationId, supabase, prefs]);

  const hasTranscript = !!(rawNotes.trim () || transcript.trim ());
  const hasSummaryContent = !!(summary.trim () || actionItems.length || topics.length || decisions.length);
  const showOnboardingCard = !isActive && !hasTranscript && !hasSummarized;

  const liveTranscript = interimText
    ? `${rawNotes}${rawNotes ? ' ' : ''}${interimText}`.trim ()
    : rawNotes;

  const onCopy = useCallback (async () => {
    const text = buildCopyText ({
      headerDate,
      transcript: liveTranscript || rawNotes,
      summary,
      actionItems,
      decisions,
      topics,
    }).trim ();
    if (!text) return;
    await navigator.clipboard.writeText (text);
    setCopyState ('copied');
    window.setTimeout (() => setCopyState ('idle'), 1600);
  }, [headerDate, liveTranscript, rawNotes, summary, actionItems, decisions, topics]);

  return (
    <div className="meeting-notes-root mx-auto w-full max-w-[1040px] px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
        {headerDate}
      </h1>

      <Card className="mt-4 rounded-2xl border-[var(--border)] bg-[var(--bg2)] shadow-none">
        <CardHeader className="pb-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div
              className="flex flex-wrap items-center gap-2"
            >
              <CardTitle className="text-[26px] leading-none text-[var(--text)] sm:text-[34px]">Meeting</CardTitle>
              <span className="text-[26px] font-semibold leading-none tracking-tight text-[var(--text3)] sm:text-[34px]">@Today</span>
            </div>
            <div className="flex w-full flex-row items-center justify-start gap-2 sm:w-auto sm:min-w-0 sm:flex-1 sm:flex-col sm:items-end sm:max-w-[62%]">
              {isActive ? (
                <InlineRecordingBar
                  status={transcriptionStatus}
                  analyserRef={analyserRef}
                  error={transcriptionError}
                  onPause={pause}
                  onResume={resume}
                  onStop={handleStop}
                />
              ) : (
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        className="h-9 w-9 rounded-xl border-[var(--border)] text-[var(--text3)] shadow-none"
                        aria-label="Meeting transcription settings"
                      >
                        <Cog6ToothIcon className="h-4 w-4" aria-hidden />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent>
                      <div className="space-y-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text3)]">
                            Summary style
                          </p>
                          <select
                            value={prefs.summaryStyle}
                            onChange={(event) => setSummaryStyle (event.target.value as SummaryStyle)}
                            className="mt-1 h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 text-sm text-[var(--text)] outline-none focus-visible:border-[var(--border2)]"
                          >
                            <option value="auto">Auto</option>
                            <option value="bullets">Bullets</option>
                            <option value="actions">Action items only</option>
                            <option value="decisions">Decisions only</option>
                          </select>
                        </div>
                        <label className="flex items-center justify-between gap-3 text-sm text-[var(--text2)]">
                          <span>Auto-summarize when recording stops</span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={prefs.autoSummarizeOnStop}
                            onClick={() => setAutoSummarizeOnStop (!prefs.autoSummarizeOnStop)}
                            className={`relative inline-flex h-6 w-10 items-center rounded-full transition-colors ${
                              prefs.autoSummarizeOnStop ? 'bg-[#2f5f92]' : 'bg-[var(--border2)]'
                            }`}
                          >
                            <span
                              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                prefs.autoSummarizeOnStop ? 'translate-x-5' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        </label>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <button
                    type="button"
                    className="inline-flex h-9 flex-1 items-center justify-center rounded-xl border-0 bg-[#2f5f92] px-4 text-sm font-medium text-white shadow-none transition-colors hover:bg-[#3e6e9f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f5f92] disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
                    style={{
                      WebkitAppearance: 'none',
                      appearance: 'none',
                      boxShadow: 'none',
                      border: 'none',
                    }}
                    onClick={() => void start ()}
                    disabled={!transcriptionReady}
                    aria-label={hasTranscript ? 'Start a new recording' : 'Start transcribing'}
                  >
                    {hasTranscript ? 'Record again' : 'Start transcribing'}
                  </button>
                </div>
              )}
            </div>
          </div>
          {!isActive ? (
            <div className="mt-3 flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg3)] px-3 py-1 text-xs font-medium text-[var(--text2)]">
                <SpeakerWaveIcon className="h-3.5 w-3.5 text-[var(--text3)]" aria-hidden />
                Notes
              </span>
            </div>
          ) : null}
          <CardDescription className="mt-3 text-sm">
            {summarizing
              ? 'Summarizing your meeting…'
              : hasSummaryContent
                ? 'AI summary generated from your transcript.'
                : isActive
                  ? 'Listening — your transcript and summary will appear here.'
                  : hasTranscript
                    ? 'Your transcript is ready below.'
                    : 'Notion AI will summarize the notes and transcript'}
          </CardDescription>
          {!isActive && !transcriptionReady && pageVisible ? (
            <p className="mt-2 text-xs text-[var(--text3)]">
              {isDemoMode ()
                ? 'Meeting transcription is disabled in demo mode. Sign in to a real workspace to record.'
                : 'Sign in to enable transcription.'}
            </p>
          ) : null}
          {!isActive && transcriptionError ? (
            <p className="mt-2 text-xs text-[var(--red)]">{transcriptionError}</p>
          ) : null}
          {saveError ? (
            <p className="mt-2 text-xs text-[var(--red)]">{saveError}</p>
          ) : null}
        </CardHeader>

        {(showOnboardingCard || isActive || hasTranscript || summarizing || summaryError) ? (
          <CardContent className="space-y-4 pt-0">
            {showOnboardingCard && !consentAcknowledged ? (
              <div className="rounded-2xl border border-[#cfe0f2] bg-[#edf5ff] px-4 py-3">
                <p className="text-sm font-semibold text-[#2f5f92]">Before you record</p>
                <p className="mt-1 max-w-[920px] text-sm leading-relaxed text-[#3e6e9f]">
                  Make sure everyone in the meeting knows you're transcribing and has agreed to it. Confirm below
                  to dismiss this reminder for future meetings.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <ConsentAckButton onClick={acknowledgeConsent} />
                </div>
              </div>
            ) : null}

            {(isActive || hasTranscript) ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[var(--text)]">Transcript</p>
                  {duration > 0 ? (
                    <span className="text-xs text-[var(--text3)]">
                      {Math.floor (duration / 60)}:{String (duration % 60).padStart (2, '0')}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap text-sm leading-relaxed text-[var(--text2)]">
                  {liveTranscript
                    ? liveTranscript
                    : (
                      <span className="text-[var(--text3)]">
                        Listening… start speaking and your words will appear here.
                      </span>
                    )}
                </div>
                {!prefs.autoSummarizeOnStop && hasTranscript && !summarizing && !hasSummaryContent ? (
                  <div className="mt-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-xl border-[var(--border)] text-[var(--text2)] shadow-none"
                      onClick={() => void summarize (undefined, { summaryStyle: prefs.summaryStyle })}
                    >
                      <SparklesIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
                      Summarize
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {summarizing ? (
              <div className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-sm text-[var(--text2)]">
                <SparklesIcon className="h-4 w-4 text-[#2f5f92]" aria-hidden />
                <span>Generating AI summary…</span>
              </div>
            ) : null}

            {!summarizing && summaryError ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--red)]/30 bg-[var(--red)]/5 px-4 py-3 text-sm text-[var(--red)]">
                <span>{summaryError}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-xl border-[var(--border)] text-[var(--text2)] shadow-none"
                  onClick={() => void summarize (undefined, { summaryStyle: prefs.summaryStyle })}
                  disabled={!hasTranscript}
                >
                  <ArrowPathIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Try again
                </Button>
              </div>
            ) : null}

            {!summarizing && hasSummaryContent ? (
              <div className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--bg)] px-4 py-4">
                <div className="flex items-center gap-2">
                  <SparklesIcon className="h-4 w-4 text-[#2f5f92]" aria-hidden />
                  <p className="text-sm font-semibold text-[var(--text)]">AI summary</p>
                </div>
                {summary ? (
                  <MeetingSummaryMarkdown summary={summary} actionItems={actionItems} />
                ) : null}
                {!summary && actionItems.length ? (
                  <MeetingSummaryMarkdown summary="" actionItems={actionItems} />
                ) : null}
                {topics.length ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text3)]">Topics</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {topics.map ((t) => (
                        <span
                          key={t}
                          className="inline-flex items-center rounded-full bg-[var(--bg3)] px-2.5 py-0.5 text-xs font-medium text-[var(--text2)]"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                {decisions.length ? (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text3)]">Key decisions</p>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5">
                      {decisions.map ((d) => (
                        <li key={d} className="text-sm text-[var(--text2)]">{d}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        ) : null}

        <CardFooter className="flex flex-col items-stretch gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="min-w-0 flex-1 text-sm text-[var(--text3)]">
            <span className="block leading-snug">By starting, you confirm everyone being transcribed has given consent.</span>
          </div>
          <div className="flex items-center justify-end gap-2 text-[var(--text3)]">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 rounded-xl border-[var(--border)] shadow-none"
              aria-label={copyState === 'copied' ? 'Copied' : 'Copy transcript and summary'}
              title={copyState === 'copied' ? 'Copied' : 'Copy transcript and summary'}
              onClick={() => void onCopy ()}
              disabled={!hasTranscript && !hasSummaryContent}
            >
              {copyState === 'copied'
                ? <CheckIcon className="h-4 w-4" aria-hidden />
                : <DocumentDuplicateIcon className="h-4 w-4" aria-hidden />}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
