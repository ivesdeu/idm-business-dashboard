import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  MeetingActionItem,
  MeetingNote,
  SchedulingAppointment,
} from '@/components/scheduling/types';
import { rowToMeetingNote, type MeetingNoteRow } from '@/lib/scheduling/supabase';
import {
  callAdvisorForMeetingSummary,
  normalizeActionItems,
} from '@/lib/scheduling/meetingSummary';
import { isDemoMode } from '@/lib/demoMode';

function splitSentences (text: string): string[] {
  return text
    .split (/(?<=[.!?])\s+|\n+/)
    .map ((s) => s.trim ())
    .filter (Boolean);
}

function buildDemoSummary (transcript: string): {
  summary: string;
  actionItemsRaw: Array<{ task: string; owner: string; due_date: string | null }>;
  topics: string[];
  decisions: string[];
} {
  const text = transcript.trim ();
  if (!text) {
    return { summary: '', actionItemsRaw: [], topics: [], decisions: [] };
  }
  const sentences = splitSentences (text);

  const actionRegex = /\b(action item|todo|to-?do|follow up|next step|let's|we (should|will|need to)|i'?ll|i will|please)\b/i;
  const decisionRegex = /\b(decided|agreed|approved|we'?ll go with|plan to|conclusion)\b/i;

  const actionItemsRaw = sentences
    .filter ((s) => actionRegex.test (s))
    .slice (0, 6)
    .map ((s) => ({
      task: s.replace (/^\s*[-*]\s*/, '').replace (/^action item:?\s*/i, '').trim (),
      owner: '',
      due_date: null,
    }));

  const decisions = sentences
    .filter ((s) => decisionRegex.test (s))
    .slice (0, 4)
    .map ((s) => s.replace (/^\s*[-*]\s*/, '').trim ());

  const headlineBullets = sentences.slice (0, Math.min (8, sentences.length))
    .map ((s) => `- ${s.replace (/^\s*[-*]\s*/, '').trim ()}`);

  const summary =
    '### Meeting Recap (demo)\n\n' +
    'This is an on-device summary of your live transcript. Sign in to get a full Advisor summary.\n\n' +
    headlineBullets.join ('\n');

  return {
    summary,
    actionItemsRaw,
    topics: [],
    decisions,
  };
}

const SAVE_DEBOUNCE_MS = 700;

type UseMeetingNoteOptions = {
  organizationId: string | null;
  supabase: SupabaseClient | null;
  appointment: SchedulingAppointment | null;
  transcript: string;
  duration: number;
  setTranscript: (value: string) => void;
};

type UseMeetingNoteResult = {
  note: MeetingNote | null;
  saveError: string | null;
  loading: boolean;
  rawNotes: string;
  summary: string;
  actionItems: MeetingActionItem[];
  decisions: string[];
  topics: string[];
  summarizing: boolean;
  summaryError: string | null;
  hasSummarized: boolean;
  summarize: (transcriptOverride?: string) => Promise<void>;
  clearSummary: () => void;
};

function actionItemsToRows (
  items: MeetingActionItem[],
): Array<{ task: string; owner: string; due_date: string | null; completed: boolean }> {
  return items.map ((item) => ({
    task: item.task,
    owner: item.owner,
    due_date: item.dueDate,
    completed: item.completed,
  }));
}

export function useMeetingNote ({
  organizationId,
  supabase,
  appointment,
  transcript,
  duration,
  setTranscript,
}: UseMeetingNoteOptions): UseMeetingNoteResult {
  const [note, setNote] = useState<MeetingNote | null> (null);
  const [loading, setLoading] = useState (false);
  const [saveError, setSaveError] = useState<string | null> (null);
  const [rawNotes, setRawNotes] = useState ('');
  const [summary, setSummary] = useState ('');
  const [actionItems, setActionItems] = useState<MeetingActionItem[]> ([]);
  const [decisions, setDecisions] = useState<string[]> ([]);
  const [topics, setTopics] = useState<string[]> ([]);
  const [summarizing, setSummarizing] = useState (false);
  const [summaryError, setSummaryError] = useState<string | null> (null);
  const [hasSummarized, setHasSummarized] = useState (false);
  const saveDebounceRef = useRef<number | null> (null);
  const prevTranscriptRef = useRef ('');
  const transcriptRef = useRef ('');
  const rawNotesRef = useRef ('');

  useEffect (() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect (() => {
    rawNotesRef.current = rawNotes;
  }, [rawNotes]);

  useEffect (() => {
    if (!supabase || !organizationId) return;
    let cancelled = false;
    const localTranscript = transcript;
    const preserveLocalTranscript = !!(localTranscript.trim () || duration > 0);
    setLoading (true);
    setSaveError (null);
    void (async () => {
      const { data, error } = await supabase
        .from ('meeting_notes')
        .select ('*')
        .eq ('organization_id', organizationId)
        .order ('updated_at', { ascending: false })
        .limit (1);
      if (cancelled) return;
      if (error) {
        setLoading (false);
        setSaveError ('Sorry, we could not complete your request.');
        return;
      }
      if (data && data.length > 0) {
        const mapped = rowToMeetingNote (data[0] as MeetingNoteRow);
        setNote (mapped);
        const initial = mapped.transcript || mapped.rawNotes || '';
        if (preserveLocalTranscript) {
          setRawNotes (localTranscript);
          prevTranscriptRef.current = localTranscript;
        } else {
          setRawNotes (initial);
          prevTranscriptRef.current = initial;
          setTranscript (initial);
        }
        setSummary (mapped.summary || '');
        setActionItems (mapped.actionItems || []);
        setTopics (mapped.topics || []);
        setDecisions (
          mapped.decisions
            ? mapped.decisions
                .split (/\r?\n/)
                .map ((s) => s.trim ())
                .filter (Boolean)
            : [],
        );
        setHasSummarized (
          !!(mapped.summary
            || (mapped.actionItems && mapped.actionItems.length)
            || (mapped.topics && mapped.topics.length)),
        );
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
        if (preserveLocalTranscript) {
          setRawNotes (localTranscript);
          prevTranscriptRef.current = localTranscript;
        } else {
          setRawNotes ('');
          prevTranscriptRef.current = '';
          setTranscript ('');
        }
        setSummary ('');
        setActionItems ([]);
        setDecisions ([]);
        setTopics ([]);
        setHasSummarized (false);
      }
      setLoading (false);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, organizationId, appointment?.clientId, appointment?.startTime, appointment?.title, setTranscript]);

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
    if (!note || !supabase || !organizationId) return;
    if (saveDebounceRef.current != null) window.clearTimeout (saveDebounceRef.current);
    saveDebounceRef.current = window.setTimeout (() => {
      void (async () => {
        const { error } = await supabase
          .from ('meeting_notes')
          .update ({
            raw_notes: rawNotes,
            transcript,
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
  }, [note, supabase, organizationId, rawNotes, transcript, duration]);

  const summarize = useCallback (async (transcriptOverride?: string) => {
    const demo = isDemoMode ();
    console.info ('[meeting-notes] summarize() called', {
      demo,
      hasOverride: !!transcriptOverride,
      overrideLen: (transcriptOverride || '').length,
      hasSupabase: !!supabase,
      organizationId,
      transcriptRefLen: transcriptRef.current.length,
      rawNotesRefLen: rawNotesRef.current.length,
    });

    const currentTranscript = (
      transcriptOverride
      || transcriptRef.current
      || rawNotesRef.current
    ).trim ();
    if (!currentTranscript) {
      setSummaryError ('Nothing was transcribed. Start recording and try again.');
      console.warn ('[meeting-notes] summarize aborted: empty transcript');
      return;
    }

    if (demo) {
      setSummarizing (true);
      setSummaryError (null);
      await new Promise ((r) => window.setTimeout (r, 600));
      const built = buildDemoSummary (currentTranscript);
      setSummary (built.summary);
      setActionItems (normalizeActionItems (built.actionItemsRaw));
      setTopics (built.topics);
      setDecisions (built.decisions);
      setHasSummarized (true);
      setSummarizing (false);
      console.info ('[meeting-notes] summarize -> demo summary applied', {
        actionItems: built.actionItemsRaw.length,
        decisions: built.decisions.length,
      });
      return;
    }

    if (!supabase || !organizationId) {
      setSummaryError ('Sign in to summarize this meeting.');
      console.warn ('[meeting-notes] summarize aborted: no supabase or org');
      return;
    }
    setSummarizing (true);
    setSummaryError (null);
    console.info ('[meeting-notes] summarize -> calling Advisor', {
      transcriptLen: currentTranscript.length,
    });
    try {
      const parsed = await callAdvisorForMeetingSummary ({
        supabase,
        organizationId,
        title: appointment?.title || note?.title || 'Untitled meeting',
        attendees: '',
        transcript: currentTranscript,
        manualNotes: '',
      });
      const nextActionItems = normalizeActionItems (parsed.action_items);
      const nextTopics = (parsed.topics || [])
        .map ((x) => String (x || '').trim ())
        .filter (Boolean);
      const nextDecisions = (parsed.key_decisions || [])
        .map ((x) => String (x || '').trim ())
        .filter (Boolean);
      const nextSummary = parsed.summary || '';

      setSummary (nextSummary);
      setActionItems (nextActionItems);
      setTopics (nextTopics);
      setDecisions (nextDecisions);
      setHasSummarized (true);

      if (note) {
        const { error } = await supabase
          .from ('meeting_notes')
          .update ({
            summary: nextSummary,
            action_items: actionItemsToRows (nextActionItems),
            topics: nextTopics,
            decisions: nextDecisions.join ('\n'),
            status: 'complete',
            updated_at: new Date ().toISOString (),
          })
          .eq ('id', note.id)
          .eq ('organization_id', organizationId);
        if (error) {
          setSaveError ('Summary generated, but could not be saved.');
        }
      }
      console.info ('[meeting-notes] summarize -> Advisor success', {
        summaryLen: nextSummary.length,
        actionItems: nextActionItems.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String (err || '');
      console.error ('[meeting-notes] summarize failed', message, err);
      setSummaryError (
        message || 'Could not summarize this meeting. Try again in a moment.',
      );
    } finally {
      setSummarizing (false);
    }
  }, [supabase, organizationId, appointment?.title, note]);

  const clearSummary = useCallback (() => {
    setSummary ('');
    setActionItems ([]);
    setDecisions ([]);
    setTopics ([]);
    setSummaryError (null);
    setHasSummarized (false);
  }, []);

  return {
    note,
    saveError,
    loading,
    rawNotes,
    summary,
    actionItems,
    decisions,
    topics,
    summarizing,
    summaryError,
    hasSummarized,
    summarize,
    clearSummary,
  };
}
