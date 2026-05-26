import { useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MeetingNote, SchedulingAppointment } from '@/components/scheduling/types';
import { rowToMeetingNote, type MeetingNoteRow } from '@/lib/scheduling/supabase';

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
};

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
  const saveDebounceRef = useRef<number | null> (null);
  const prevTranscriptRef = useRef ('');

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

  return {
    note,
    saveError,
    loading,
  };
}
