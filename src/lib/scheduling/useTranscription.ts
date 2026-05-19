import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssemblyAiStreamingMessage, TranscriptionStatus } from '@/components/scheduling/types';

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

const TARGET_SAMPLE_RATE = 16000;
const SPEECH_MODEL = 'u3-rt-pro';
/** ~128 ms of audio at 16 kHz (AssemblyAI expects 50–1000 ms binary frames). */
const PCM_BUFFER_SIZE = 2048;

function getSupabase (): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { supabaseClient?: SupabaseClient }).supabaseClient;
  return c ?? null;
}

export function isWorkspaceReadyForTranscription (): boolean {
  if (typeof window === 'undefined') return false;
  const orgId = (window as unknown as { currentOrganizationId?: string | null }).currentOrganizationId;
  return !!(orgId && String (orgId).trim ());
}

async function fetchAssemblyAiToken (): Promise<string> {
  if (!isWorkspaceReadyForTranscription ()) {
    throw new Error ('Workspace is still loading. Wait for sign-in to finish, then try recording again.');
  }
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
  const res = await fetch (`${base}/functions/v1/assemblyai-token`, {
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
    const errBody = typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error.trim ()
      : '';
    const detail =
      errBody ||
      (res.status === 404
        ? 'Transcription service is not deployed. Contact your administrator.'
        : res.status === 402
          ? 'AssemblyAI streaming is not enabled on this account. Upgrade your AssemblyAI plan.'
          : res.status === 500
            ? 'Transcription is not configured on the server (missing AssemblyAI API key).'
            : `Transcription service unavailable (${res.status}). Your notes are saved locally.`);
    throw new Error (detail);
  }
  const body = payload as { token?: unknown; key?: unknown };
  const token =
    (typeof body.token === 'string' ? body.token.trim () : '') ||
    (typeof body.key === 'string' ? body.key.trim () : '');
  if (!token) throw new Error ('Transcription service unavailable. Your notes are saved locally.');
  return token;
}

function streamingCloseErrorMessage (code: number, reason: string): string {
  if (code === 1008) return 'Transcription authentication failed. Sign in again and retry.';
  if (code === 3005) return 'Transcription session ended due to a server error.';
  if (code === 3007) return 'Audio stream was invalid. Try stopping and starting recording again.';
  if (code === 3008) return 'Transcription session timed out (3 hour limit).';
  if (code === 3009) return 'Too many active transcription sessions. Try again shortly.';
  if (reason) return reason;
  return 'Transcription connection closed.';
}

function wsUrlForAssemblyAi (token: string): string {
  const params = new URLSearchParams ({
    sample_rate: String (TARGET_SAMPLE_RATE),
    speech_model: SPEECH_MODEL,
    formatted_finals: 'true',
    token,
  });
  return `wss://streaming.assemblyai.com/v3/ws?${params.toString ()}`;
}

function cleanText (value: string): string {
  return value.replace (/\s+/g, ' ').trim ();
}

function appendText (current: string, chunk: string): string {
  const next = cleanText (chunk);
  if (!next) return current;
  return current ? `${current} ${next}` : next;
}

function resampleFloatTo16k (input: Float32Array, inputRate: number): Int16Array {
  if (inputRate === TARGET_SAMPLE_RATE) {
    return float32ToInt16 (input);
  }
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outLen = Math.max (1, Math.floor (input.length / ratio));
  const out = new Float32Array (outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcIdx = i * ratio;
    const idx = Math.floor (srcIdx);
    const frac = srcIdx - idx;
    const s0 = input[idx] ?? 0;
    const s1 = input[idx + 1] ?? s0;
    out[i] = s0 + (s1 - s0) * frac;
  }
  return float32ToInt16 (out);
}

function float32ToInt16 (input: Float32Array): Int16Array {
  const out = new Int16Array (input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max (-1, Math.min (1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function transcriptFromTurn (msg: AssemblyAiStreamingMessage): string {
  return cleanText (typeof msg.transcript === 'string' ? msg.transcript : '');
}

export function useTranscription (): UseTranscriptionResult {
  const [status, setStatus] = useState<TranscriptionStatus> ('idle');
  const [transcript, setTranscriptState] = useState ('');
  const [interimText, setInterimText] = useState ('');
  const [error, setError] = useState<string | null> (null);
  const [duration, setDuration] = useState (0);

  const streamRef = useRef<MediaStream | null> (null);
  const wsRef = useRef<WebSocket | null> (null);
  const audioContextRef = useRef<AudioContext | null> (null);
  const processorRef = useRef<ScriptProcessorNode | null> (null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null> (null);
  const timerRef = useRef<number | null> (null);
  const pausedRef = useRef (false);
  const permissionKnownRef = useRef<'granted' | 'denied' | 'unknown'> ('unknown');
  const terminatingRef = useRef (false);

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

  const teardownAudioGraph = useCallback (() => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect ();
      } catch (_) {}
    }
    processorRef.current = null;
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect ();
      } catch (_) {}
    }
    sourceRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx) {
      void ctx.close ().catch (() => {});
    }
  }, []);

  const closeWs = useCallback ((sendTerminate: boolean) => {
    const ws = wsRef.current;
    if (!ws) return;
    wsRef.current = null;
    if (sendTerminate) terminatingRef.current = true;
    try {
      if (sendTerminate && ws.readyState === WebSocket.OPEN) {
        ws.send (JSON.stringify ({ type: 'Terminate' }));
      }
    } catch (_) {}
    try {
      ws.close ();
    } catch (_) {}
  }, []);

  const stop = useCallback (() => {
    clearTimer ();
    pausedRef.current = false;
    teardownAudioGraph ();
    closeWs (true);
    stopTracks ();
    setInterimText ('');
    setStatus ('stopped');
    terminatingRef.current = false;
  }, [clearTimer, closeWs, stopTracks, teardownAudioGraph]);

  const pause = useCallback (() => {
    if (status !== 'recording') return;
    pausedRef.current = true;
    clearTimer ();
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === 'running') {
      void ctx.suspend ();
    }
    setStatus ('paused');
  }, [clearTimer, status]);

  const resume = useCallback (() => {
    if (status !== 'paused') return;
    pausedRef.current = false;
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume ();
    }
    startTimer ();
    setStatus ('recording');
  }, [startTimer, status]);

  const start = useCallback (async () => {
    if (status === 'recording' || status === 'paused' || status === 'requesting') return;
    setError (null);
    setInterimText ('');
    setDuration (0);
    setStatus ('requesting');
    pausedRef.current = false;
    terminatingRef.current = false;

    if (typeof window === 'undefined' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError ('Recording requires a secure connection (HTTPS) and a supported browser.');
      setStatus ('idle');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia ({ audio: true });
      permissionKnownRef.current = 'granted';
      streamRef.current = stream;

      const token = await fetchAssemblyAiToken ();
      const ws = new WebSocket (wsUrlForAssemblyAi (token));
      wsRef.current = ws;

      await new Promise<void> ((resolve, reject) => {
        const onOpen = () => {
          ws.removeEventListener ('error', onErr);
          resolve ();
        };
        const onErr = () => {
          ws.removeEventListener ('open', onOpen);
          reject (new Error ('Could not connect to transcription service.'));
        };
        ws.addEventListener ('open', onOpen, { once: true });
        ws.addEventListener ('error', onErr, { once: true });
      });

      ws.addEventListener ('message', (ev) => {
        let msg: AssemblyAiStreamingMessage;
        try {
          msg = JSON.parse (String (ev.data || '{}')) as AssemblyAiStreamingMessage;
        } catch {
          return;
        }
        const type = typeof msg.type === 'string' ? msg.type : '';
        if (type === 'Turn') {
          const tx = transcriptFromTurn (msg);
          if (!tx) return;
          if (msg.end_of_turn) {
            setTranscriptState ((prev) => appendText (prev, tx));
            setInterimText ('');
          } else {
            setInterimText (tx);
          }
          return;
        }
        if (type === 'Termination') {
          return;
        }
        if (type === 'Error') {
          const detail = typeof msg.error === 'string' ? msg.error : 'Transcription service unavailable.';
          setError (detail);
          stop ();
        }
      });

      ws.addEventListener ('error', () => {
        if (!terminatingRef.current) {
          setError ('Transcription service unavailable. Your notes are saved locally.');
        }
      });

      ws.addEventListener ('close', (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        clearTimer ();
        teardownAudioGraph ();
        stopTracks ();
        setInterimText ('');
        if (!terminatingRef.current && ev.code !== 1000) {
          setError (streamingCloseErrorMessage (ev.code, String (ev.reason || '')));
        }
        setStatus ((s) => (s === 'requesting' ? 'idle' : 'stopped'));
        terminatingRef.current = false;
      });

      const audioContext = new AudioContext ({ sampleRate: TARGET_SAMPLE_RATE });
      audioContextRef.current = audioContext;
      const inputRate = audioContext.sampleRate;
      const source = audioContext.createMediaStreamSource (stream);
      sourceRef.current = source;
      const processor = audioContext.createScriptProcessor (PCM_BUFFER_SIZE, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        if (pausedRef.current) return;
        const wsLive = wsRef.current;
        if (!wsLive || wsLive.readyState !== WebSocket.OPEN) return;
        const channel = event.inputBuffer.getChannelData (0);
        const pcm = resampleFloatTo16k (channel, inputRate);
        try {
          wsLive.send (pcm.buffer);
        } catch (_) {}
      };
      source.connect (processor);
      processor.connect (audioContext.destination);

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
      teardownAudioGraph ();
      closeWs (false);
      stopTracks ();
      setStatus ('idle');
    }
  }, [clearTimer, closeWs, startTimer, status, stop, stopTracks, teardownAudioGraph]);

  useEffect (() => {
    return () => {
      clearTimer ();
      teardownAudioGraph ();
      closeWs (true);
      stopTracks ();
    };
  }, [clearTimer, closeWs, stopTracks, teardownAudioGraph]);

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
