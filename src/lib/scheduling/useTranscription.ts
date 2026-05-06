import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  DeepgramMessage,
  DeepgramResultsMessage,
  TranscriptionStatus,
} from '@/components/scheduling/types';

type UseTranscriptionState = {
  status: TranscriptionStatus;
  transcript: string;
  interimText: string;
  error: string | null;
  duration: number;
};

type UseTranscriptionResult = UseTranscriptionState & {
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setTranscript: (value: string) => void;
};

function getSupabase (): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { supabaseClient?: SupabaseClient }).supabaseClient;
  return c ?? null;
}

async function fetchDeepgramTempKey (): Promise<string> {
  const supabase = getSupabase ();
  const base = typeof window !== 'undefined'
    ? String ((window as unknown as { __bizdashSupabaseUrl?: string }).__bizdashSupabaseUrl || '').trim ().replace (/\/$/, '')
    : '';
  const anon = typeof window !== 'undefined'
    ? String ((window as unknown as { __bizdashSupabaseAnonKey?: string }).__bizdashSupabaseAnonKey || '').trim ()
    : '';
  if (!supabase || !base || !anon) throw new Error ('Sorry, we could not complete your request.');
  const sessionRes = await supabase.auth.getSession ();
  const accessToken = sessionRes.data.session?.access_token || '';
  if (!accessToken) throw new Error ('Sorry, we could not complete your request.');
  const res = await fetch (`${base}/functions/v1/deepgram-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: anon,
    },
    body: JSON.stringify ({ requested_at: new Date ().toISOString () }),
  });
  const payload = await res.json ().catch (() => ({}));
  if (!res.ok) {
    const detail = typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : 'Transcription service unavailable. Your notes are saved locally.';
    throw new Error (detail || 'Transcription service unavailable. Your notes are saved locally.');
  }
  const key = typeof (payload as { key?: unknown }).key === 'string' ? (payload as { key: string }).key.trim () : '';
  if (!key) throw new Error ('Transcription service unavailable. Your notes are saved locally.');
  return key;
}

function wsUrlForListen (key: string): string {
  const params = new URLSearchParams ({
    model: 'nova-2',
    language: 'en-US',
    smart_format: 'true',
    interim_results: 'true',
    utterance_end_ms: '1000',
    punctuate: 'true',
  });
  return `wss://api.deepgram.com/v1/listen?${params.toString ()}&token=${encodeURIComponent (key)}`;
}

function preferredMimeType (): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  if (MediaRecorder.isTypeSupported ('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported ('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
  if (MediaRecorder.isTypeSupported ('audio/webm')) return 'audio/webm';
  return '';
}

function cleanText (value: string): string {
  return value.replace (/\s+/g, ' ').trim ();
}

function appendText (current: string, chunk: string): string {
  const next = cleanText (chunk);
  if (!next) return current;
  return current ? `${current} ${next}` : next;
}

function transcriptFromResults (msg: DeepgramResultsMessage): string {
  const alt = msg.channel?.alternatives?.[0];
  const tx = typeof alt?.transcript === 'string' ? alt.transcript : '';
  return cleanText (tx);
}

export function useTranscription (): UseTranscriptionResult {
  const [status, setStatus] = useState<TranscriptionStatus> ('idle');
  const [transcript, setTranscriptState] = useState ('');
  const [interimText, setInterimText] = useState ('');
  const [error, setError] = useState<string | null> (null);
  const [duration, setDuration] = useState (0);

  const recorderRef = useRef<MediaRecorder | null> (null);
  const streamRef = useRef<MediaStream | null> (null);
  const wsRef = useRef<WebSocket | null> (null);
  const timerRef = useRef<number | null> (null);
  const permissionKnownRef = useRef<'granted' | 'denied' | 'unknown'> ('unknown');
  const pendingChunkRef = useRef('');

  const clearTimer = useCallback (() => {
    if (timerRef.current != null) window.clearInterval (timerRef.current);
    timerRef.current = null;
  }, []);

  const startTimer = useCallback (() => {
    clearTimer ();
    timerRef.current = window.setInterval (() => {
      setDuration ((d) => d + 1);
    }, 1000);
  }, [clearTimer]);

  const stopTracks = useCallback (() => {
    if (streamRef.current) {
      streamRef.current.getTracks ().forEach ((t) => t.stop ());
    }
    streamRef.current = null;
  }, []);

  const closeWs = useCallback (() => {
    const ws = wsRef.current;
    if (!ws) return;
    wsRef.current = null;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send (JSON.stringify ({ type: 'CloseStream' }));
      }
    } catch (_) {}
    try {
      ws.close ();
    } catch (_) {}
  }, []);

  const stop = useCallback (() => {
    clearTimer ();
    if (recorderRef.current) {
      try {
        const rec = recorderRef.current;
        if (rec.state !== 'inactive') rec.stop ();
      } catch (_) {}
    }
    recorderRef.current = null;
    closeWs ();
    stopTracks ();
    if (pendingChunkRef.current) {
      setTranscriptState ((prev) => appendText (prev, pendingChunkRef.current));
      pendingChunkRef.current = '';
    }
    setInterimText ('');
    setStatus ('stopped');
  }, [clearTimer, closeWs, stopTracks]);

  const pause = useCallback (() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'recording') return;
    rec.pause ();
    clearTimer ();
    setStatus ('paused');
    try {
      wsRef.current?.send (JSON.stringify ({ type: 'Pause' }));
    } catch (_) {}
  }, [clearTimer]);

  const resume = useCallback (() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'paused') return;
    rec.resume ();
    startTimer ();
    setStatus ('recording');
    try {
      wsRef.current?.send (JSON.stringify ({ type: 'Resume' }));
    } catch (_) {}
  }, [startTimer]);

  const start = useCallback (async () => {
    if (status === 'recording' || status === 'paused' || status === 'requesting') return;
    setError (null);
    setInterimText ('');
    pendingChunkRef.current = '';
    setDuration (0);
    setStatus ('requesting');

    if (typeof window === 'undefined' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError ('Recording requires a secure connection (HTTPS) and a supported browser.');
      setStatus ('idle');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      setError ('Recording requires a secure connection (HTTPS) and a supported browser.');
      setStatus ('idle');
      return;
    }

    const mimeType = preferredMimeType ();
    if (mimeType == null) {
      setError ('Recording requires a secure connection (HTTPS) and a supported browser.');
      setStatus ('idle');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia ({ audio: true });
      permissionKnownRef.current = 'granted';
      streamRef.current = stream;

      const deepgramToken = await fetchDeepgramTempKey ();
      const ws = new WebSocket (wsUrlForListen (deepgramToken));
      wsRef.current = ws;

      ws.addEventListener ('message', (ev) => {
        let msg: DeepgramMessage;
        try {
          msg = JSON.parse (String (ev.data || '{}')) as DeepgramMessage;
        } catch {
          return;
        }
        const type = typeof (msg as { type?: unknown }).type === 'string' ? String ((msg as { type?: string }).type) : '';
        if (type === 'UtteranceEnd') {
          if (pendingChunkRef.current) {
            setTranscriptState ((prev) => appendText (prev, pendingChunkRef.current));
            pendingChunkRef.current = '';
            setInterimText ('');
          }
          return;
        }
        if (type === 'Error') {
          setError ('Transcription service unavailable. Your notes are saved locally.');
          stop ();
          return;
        }
        const tx = transcriptFromResults (msg as DeepgramResultsMessage);
        const isFinal = (msg as DeepgramResultsMessage).is_final === true;
        if (!tx) return;
        if (isFinal) {
          setTranscriptState ((prev) => appendText (prev, tx));
          pendingChunkRef.current = '';
          setInterimText ('');
        } else {
          pendingChunkRef.current = tx;
          setInterimText (tx);
        }
      });
      ws.addEventListener ('error', () => {
        setError ('Transcription service unavailable. Your notes are saved locally.');
      });
      ws.addEventListener ('close', () => {
        clearTimer ();
        stopTracks ();
        recorderRef.current = null;
        if (pendingChunkRef.current) {
          setTranscriptState ((prev) => appendText (prev, pendingChunkRef.current));
          pendingChunkRef.current = '';
        }
        setInterimText ('');
        setStatus ('stopped');
      });

      const recorder = mimeType ? new MediaRecorder (stream, { mimeType }) : new MediaRecorder (stream);
      recorderRef.current = recorder;
      recorder.addEventListener ('dataavailable', async (event: BlobEvent) => {
        if (!event.data || event.data.size === 0) return;
        const wsLive = wsRef.current;
        if (!wsLive || wsLive.readyState !== WebSocket.OPEN) return;
        try {
          const buf = await event.data.arrayBuffer ();
          wsLive.send (buf);
        } catch (_) {}
      });
      recorder.addEventListener ('error', () => {
        setError ('Transcription service unavailable. Your notes are saved locally.');
        stop ();
      });
      recorder.start (250);

      setStatus ('recording');
      startTimer ();
    } catch (err) {
      const message = err instanceof Error ? err.message : String (err || '');
      if (message.toLowerCase ().includes ('denied') || message.toLowerCase ().includes ('permission')) {
        permissionKnownRef.current = 'denied';
        setError ('Microphone access was denied. Check your browser permissions.');
      } else if (message) {
        setError (message);
      } else {
        setError ('Transcription service unavailable. Your notes are saved locally.');
      }
      clearTimer ();
      stopTracks ();
      closeWs ();
      setStatus ('idle');
    }
  }, [clearTimer, closeWs, startTimer, status, stop, stopTracks]);

  useEffect (() => {
    return () => {
      clearTimer ();
      if (recorderRef.current) {
        try {
          if (recorderRef.current.state !== 'inactive') recorderRef.current.stop ();
        } catch (_) {}
      }
      recorderRef.current = null;
      closeWs ();
      stopTracks ();
    };
  }, [clearTimer, closeWs, stopTracks]);

  return {
    status,
    transcript,
    interimText,
    error,
    duration,
    start,
    pause,
    resume,
    stop,
    setTranscript: setTranscriptState,
  };
}
