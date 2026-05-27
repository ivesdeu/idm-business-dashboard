import { AudioLines, Copy, RefreshCw, Settings2, Sparkles, UserPlus, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

export function MeetingNotesPage () {
  const [organizationId, setOrganizationId] = useState<string | null> (() => getOrgId ());
  const supabase = getSupabase ();
  const transcriptionReady = useTranscriptionReady ();
  const [pageVisible, setPageVisible] = useState (false);

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
    const page = document.getElementById ('page-meeting-notes');
    if (!page) return;
    const sync = () => setPageVisible (page.classList.contains ('on'));
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
  });

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
    void summarize (captured || undefined);
  }, [stop, summarize, transcript, interimText, rawNotes, organizationId, supabase]);

  const hasTranscript = !!(rawNotes.trim () || transcript.trim ());
  const hasSummaryContent = !!(summary.trim () || actionItems.length || topics.length || decisions.length);
  const showOnboardingCard = !isActive && !hasTranscript && !hasSummarized;

  const liveTranscript = interimText
    ? `${rawNotes}${rawNotes ? ' ' : ''}${interimText}`.trim ()
    : rawNotes;

  return (
    <div className="meeting-notes-root mx-auto w-full max-w-[1040px] px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
        {headerDate}
      </h1>

      <Card className="mt-4 rounded-2xl border-[var(--border)] bg-[var(--bg2)] shadow-none">
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between gap-4">
            <div
              className="flex items-center gap-2"
            >
              <CardTitle className="text-[34px] leading-none text-[var(--text)]">Meeting</CardTitle>
              <span className="text-[34px] font-semibold leading-none tracking-tight text-[var(--text3)]">@Today</span>
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-end gap-2 sm:max-w-[62%]">
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
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-9 w-9 rounded-xl border-[var(--border)] text-[var(--text3)] shadow-none"
                    aria-label="Meeting transcription settings"
                  >
                    <Settings2 className="h-4 w-4" aria-hidden />
                  </Button>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center justify-center rounded-xl border-0 bg-[#2f5f92] px-4 text-sm font-medium text-white shadow-none transition-colors hover:bg-[#3e6e9f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2f5f92] disabled:cursor-not-allowed disabled:opacity-50"
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
                <AudioLines className="h-3.5 w-3.5 text-[var(--text3)]" strokeWidth={1.8} aria-hidden />
                Notes
              </span>
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-white text-[var(--text2)] shadow-none transition-colors hover:border-[var(--border2)] hover:bg-[var(--bg3)]"
                style={{
                  background: '#ffffff',
                  backgroundImage: 'none',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                  boxShadow: 'none',
                }}
                aria-label="Add attendee"
              >
                <UserPlus className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
              </button>
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
              Sign in to enable transcription.
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
            {showOnboardingCard ? (
              <div className="rounded-2xl border border-[#cfe0f2] bg-[#edf5ff] px-4 py-3">
                <p className="text-sm font-semibold text-[#2f5f92]">Choose how you notify others</p>
                <p className="mt-1 max-w-[920px] text-sm leading-relaxed text-[#3e6e9f]">
                  To let others know you're transcribing, Notion can play an audio message or you can continue to
                  get consent yourself. Set your default for all meetings:
                </p>
                <div
                  className="mt-3 flex flex-wrap gap-2"
                >
                  <button
                    type="button"
                    className="inline-flex h-8 items-center justify-center rounded-xl border border-[#8fb9e3] bg-white px-3 text-sm font-medium text-[#2f5f92] transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8fb9e3]"
                    style={{
                      background: '#ffffff',
                      backgroundImage: 'none',
                      borderStyle: 'solid',
                      WebkitAppearance: 'none',
                      appearance: 'none',
                      boxShadow: 'none',
                      filter: 'none',
                    }}
                  >
                    Get consent myself
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center justify-center rounded-xl border border-[#8fb9e3] bg-white px-3 text-sm font-medium text-[#2f5f92] transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8fb9e3]"
                    style={{
                      background: '#ffffff',
                      backgroundImage: 'none',
                      borderStyle: 'solid',
                      WebkitAppearance: 'none',
                      appearance: 'none',
                      boxShadow: 'none',
                      filter: 'none',
                    }}
                  >
                    Automatically play audio
                  </button>
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
              </div>
            ) : null}

            {summarizing ? (
              <div className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--bg)] px-4 py-3 text-sm text-[var(--text2)]">
                <Sparkles className="h-4 w-4 text-[#2f5f92]" aria-hidden />
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
                  onClick={() => void summarize ()}
                  disabled={!hasTranscript}
                >
                  <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
                  Try again
                </Button>
              </div>
            ) : null}

            {!summarizing && hasSummaryContent ? (
              <div className="space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--bg)] px-4 py-4">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-[#2f5f92]" aria-hidden />
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

        <CardFooter className="flex items-center justify-between gap-4 border-t border-[var(--border)] pt-4">
          <div className="flex items-center gap-4 text-sm text-[var(--text3)]">
            <span className="font-medium text-[var(--text2)]">
              Instructions: <span className="ml-1 text-[var(--text)]">Auto</span>
            </span>
            <span className="h-5 w-px bg-[var(--border2)]" aria-hidden />
            <span>By starting, you confirm everyone being transcribed has given consent.</span>
          </div>
          <div className="flex items-center gap-2 text-[var(--text3)]">
            <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-xl border-[var(--border)] shadow-none" aria-label="Play notice">
              <Volume2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-xl border-[var(--border)] shadow-none" aria-label="Copy notice">
              <Copy className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
