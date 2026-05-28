import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssemblyAiStreamingMessage, TranscriptionStatus } from '@/components/scheduling/types';
import { isDemoMode } from '@/lib/demoMode';

export const BIZDASH_ORG_CONTEXT_EVENT = 'bizdash:org-context';

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};
type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor (): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

function readOrganizationIdFromWindow (): string | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    currentOrganizationId?: string | null;
    bizDashGetCurrentOrgId?: () => string | null;
  };
  const fromFn = typeof w.bizDashGetCurrentOrgId === 'function' ? w.bizDashGetCurrentOrgId () : null;
  const id =
    (fromFn && String (fromFn).trim ()) ||
    String (w.currentOrganizationId || '').trim ();
  return id || null;
}

type UseTranscriptionState = {
  status: TranscriptionStatus;
  transcript: string;
  interimText: string;
  error: string | null;
  duration: number;
};

type UseTranscriptionResult = UseTranscriptionState & {
  analyserRef: RefObject<AnalyserNode | null>;
  start: () => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  setTranscript: (value: string) => void;
};

const TARGET_SAMPLE_RATE = 16000;
/** Primary model — requires Universal-3 Pro streaming on the AssemblyAI account. */
const SPEECH_MODEL_PRIMARY = 'u3-rt-pro';
/** Fallback when the account only has legacy Universal Streaming English. */
const SPEECH_MODEL_FALLBACK = 'universal-streaming-english';
const BEGIN_TIMEOUT_MS = 12000;

function readSpeechModelOverride (): string | null {
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const fromEnv = String (
      (import.meta.env as { VITE_ASSEMBLYAI_STREAMING_SPEECH_MODEL?: string })
        .VITE_ASSEMBLYAI_STREAMING_SPEECH_MODEL || '',
    ).trim ();
    if (fromEnv) return fromEnv;
  }
  return null;
}

function speechModelsToTry (): string[] {
  const override = readSpeechModelOverride ();
  if (override) return [override];
  return [SPEECH_MODEL_PRIMARY, SPEECH_MODEL_FALLBACK];
}
/** AssemblyAI rejects PCM frames shorter than 50 ms at 16 kHz (code 3007). */
const MIN_PCM_SAMPLES_16K = 800;
const SCRIPT_PROCESSOR_SIZES = [256, 512, 1024, 2048, 4096, 8192, 16384] as const;

/** ScriptProcessor buffer must be a power of two and yield ≥50 ms after resample to 16 kHz. */
function scriptProcessorBufferSize (inputRate: number): number {
  const minInputSamples = Math.ceil (inputRate * 0.052);
  for (const size of SCRIPT_PROCESSOR_SIZES) {
    if (size >= minInputSamples) return size;
  }
  return 16384;
}

function getSupabase (): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { supabaseClient?: SupabaseClient }).supabaseClient;
  return c ?? null;
}

export function isWorkspaceReadyForTranscription (): boolean {
  return !!readOrganizationIdFromWindow ();
}

async function hasTranscriptionSession (): Promise<boolean> {
  const supabase = getSupabase ();
  if (!supabase) return false;
  const { data } = await supabase.auth.getSession ();
  return !!data.session?.access_token;
}

/** True when signed in (session) or workspace org is on window — either is enough to start mic/streaming. */
export function useTranscriptionReady (): boolean {
  const [ready, setReady] = useState (() => !isDemoMode () && !!readOrganizationIdFromWindow ());

  useEffect (() => {
    let cancelled = false;

    const sync = async () => {
      if (cancelled) return;
      if (isDemoMode ()) {
        setReady (false);
        return;
      }
      if (readOrganizationIdFromWindow ()) {
        setReady (true);
        return;
      }
      if (await hasTranscriptionSession ()) {
        setReady (true);
      }
    };

    void sync ();

    const intervalId = window.setInterval (() => {
      void sync ();
    }, 400);

    const supabase = getSupabase ();
    const sub = supabase?.auth.onAuthStateChange (() => {
      void sync ();
    });

    const onOrg = () => {
      void sync ();
    };
    window.addEventListener (BIZDASH_ORG_CONTEXT_EVENT, onOrg);

    return () => {
      cancelled = true;
      window.clearInterval (intervalId);
      sub?.data.subscription.unsubscribe ();
      window.removeEventListener (BIZDASH_ORG_CONTEXT_EVENT, onOrg);
    };
  }, []);

  return ready;
}

/** @deprecated Use useTranscriptionReady */
export function useWorkspaceReadyForTranscription (): boolean {
  return useTranscriptionReady ();
}

async function fetchAssemblyAiToken (): Promise<string> {
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
  if (!accessToken) {
    throw new Error ('Sign in to start transcribing.');
  }
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

function streamingCloseErrorMessage (
  code: number,
  reason: string,
  speechModel?: string,
): string {
  const detail = reason.trim ();
  const modelHint = speechModel ? ` (model: ${speechModel})` : '';
  if (code === 1008) {
    return (
      detail ||
      `Transcription authentication failed${modelHint}. Sign in again, confirm ASSEMBLYAI_API_KEY is set, and retry.`
    );
  }
  if (code === 3005) return detail || `Transcription session ended due to a server error${modelHint}.`;
  if (code === 3007) {
    return detail || 'Audio chunks were too small or too large. Try stopping and starting recording again.';
  }
  if (code === 3008) return detail || 'Transcription session timed out (3 hour limit).';
  if (code === 3009) return detail || 'Too many active transcription sessions. Try again shortly.';
  if (detail) return `${detail}${modelHint}`;
  if (code > 0) return `Transcription connection closed (code ${code})${modelHint}.`;
  return `Transcription connection closed${modelHint}. Enable AssemblyAI Streaming on your account or set VITE_ASSEMBLYAI_STREAMING_SPEECH_MODEL=universal-streaming-english.`;
}

function wsUrlForAssemblyAi (token: string, speechModel: string): string {
  const params = new URLSearchParams ({
    sample_rate: String (TARGET_SAMPLE_RATE),
    speech_model: speechModel,
    format_turns: 'true',
    token,
  });
  return `wss://streaming.assemblyai.com/v3/ws?${params.toString ()}`;
}

type StreamingMessageHandlers = {
  onTurn: (msg: AssemblyAiStreamingMessage) => void;
  onServerError: (detail: string) => void;
};

/** Opens WS, waits for AssemblyAI `Begin`, then resolves. Rejects on timeout or abnormal close. */
function establishStreamingSession (
  token: string,
  speechModel: string,
  handlers: StreamingMessageHandlers,
): Promise<WebSocket> {
  return new Promise ((resolve, reject) => {
    const ws = new WebSocket (wsUrlForAssemblyAi (token, speechModel));
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout (beginTimer);
      try {
        ws.close ();
      } catch (_) {}
      reject (err);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout (beginTimer);
      resolve (ws);
    };

    const beginTimer = window.setTimeout (() => {
      fail (
        new Error (
          `Transcription session did not start within ${BEGIN_TIMEOUT_MS / 1000}s (model: ${speechModel}). ` +
            'Check that AssemblyAI Streaming is enabled for your API key.',
        ),
      );
    }, BEGIN_TIMEOUT_MS);

    ws.addEventListener ('message', (ev) => {
      let msg: AssemblyAiStreamingMessage;
      try {
        msg = JSON.parse (String (ev.data || '{}')) as AssemblyAiStreamingMessage;
      } catch {
        return;
      }
      const type = typeof msg.type === 'string' ? msg.type : '';
      if (type === 'Begin') {
        succeed ();
        return;
      }
      if (type === 'Turn') {
        handlers.onTurn (msg);
        return;
      }
      if (type === 'Termination') {
        return;
      }
      if (type === 'Error') {
        const detail = typeof msg.error === 'string' ? msg.error : 'Transcription service unavailable.';
        handlers.onServerError (detail);
        fail (new Error (detail));
      }
    });

    ws.addEventListener ('error', () => {
      fail (new Error ('Could not connect to transcription service.'));
    });

    ws.addEventListener ('close', (ev) => {
      if (settled) return;
      fail (
        new Error (
          streamingCloseErrorMessage (ev.code, String (ev.reason || ''), speechModel),
        ),
      );
    });
  });
}

function cleanText (value: string): string {
  return value.replace (/\s+/g, ' ').trim ();
}

function appendText (current: string, chunk: string): string {
  const next = cleanText (chunk);
  if (!next) return current;
  return current ? `${current} ${next}` : next;
}

function sendPcmInAssemblyChunks (ws: WebSocket, pcm16k: Int16Array, remainderRef: { current: Int16Array }) {
  if (!pcm16k.length) return;
  const prev = remainderRef.current;
  const merged = new Int16Array (prev.length + pcm16k.length);
  merged.set (prev, 0);
  merged.set (pcm16k, prev.length);
  let offset = 0;
  while (offset + MIN_PCM_SAMPLES_16K <= merged.length) {
    const frame = merged.subarray (offset, offset + MIN_PCM_SAMPLES_16K);
    ws.send (frame.buffer.slice (frame.byteOffset, frame.byteOffset + frame.byteLength));
    offset += MIN_PCM_SAMPLES_16K;
  }
  remainderRef.current = offset < merged.length ? merged.subarray (offset) : new Int16Array (0);
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
  const analyserRef = useRef<AnalyserNode | null> (null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null> (null);
  const timerRef = useRef<number | null> (null);
  const pausedRef = useRef (false);
  const permissionKnownRef = useRef<'granted' | 'denied' | 'unknown'> ('unknown');
  const terminatingRef = useRef (false);
  const sessionReadyRef = useRef (false);
  const activeSpeechModelRef = useRef<string | null> (null);
  const pcmSendRemainderRef = useRef<Int16Array> (new Int16Array (0));
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null> (null);
  const demoActiveRef = useRef (false);

  const stopSpeechRecognition = useCallback (() => {
    const sr = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    demoActiveRef.current = false;
    if (sr) {
      sr.onresult = null;
      sr.onerror = null;
      sr.onend = null;
      try {
        sr.stop ();
      } catch (_) {}
      try {
        sr.abort ();
      } catch (_) {}
    }
  }, []);

  const startSpeechRecognition = useCallback ((): boolean => {
    const Ctor = getSpeechRecognitionCtor ();
    if (!Ctor) {
      setError (
        'Demo transcription requires a browser with the Web Speech API (Chrome, Edge, or Safari).',
      );
      return false;
    }
    const sr = new Ctor ();
    sr.continuous = true;
    sr.interimResults = true;
    sr.lang = 'en-US';
    sr.onresult = (event) => {
      if (pausedRef.current) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const text = res[0]?.transcript ?? '';
        if (res.isFinal) {
          setTranscriptState ((prev) => appendText (prev, text));
        } else {
          interim += `${interim ? ' ' : ''}${text}`;
        }
      }
      setInterimText (cleanText (interim));
    };
    sr.onerror = (event) => {
      const code = event?.error || '';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError ('Microphone access was denied. Check your browser permissions.');
      } else if (code === 'no-speech') {
        // Ignored — silence is fine; recognition will restart on 'end'.
      } else if (code === 'aborted') {
        // Ignored — we aborted intentionally on stop/pause.
      } else if (code) {
        console.warn ('[transcription demo] speech recognition error', code);
      }
    };
    sr.onend = () => {
      if (demoActiveRef.current && !pausedRef.current) {
        try {
          sr.start ();
        } catch (_) {}
      }
    };
    speechRecognitionRef.current = sr;
    demoActiveRef.current = true;
    try {
      sr.start ();
    } catch (err) {
      console.warn ('[transcription demo] speech recognition start failed', err);
      setError ('Demo transcription could not start. Try reloading the page.');
      stopSpeechRecognition ();
      return false;
    }
    return true;
  }, [stopSpeechRecognition]);

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
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect ();
      } catch (_) {}
    }
    analyserRef.current = null;
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
    stopSpeechRecognition ();
    pausedRef.current = false;
    sessionReadyRef.current = false;
    activeSpeechModelRef.current = null;
    teardownAudioGraph ();
    closeWs (true);
    stopTracks ();
    setInterimText ((interim) => {
      const pending = cleanText (interim);
      if (pending) {
        setTranscriptState ((prev) => appendText (prev, pending));
      }
      return '';
    });
    setError (null);
    setStatus ('stopped');
  }, [clearTimer, stopSpeechRecognition, closeWs, stopTracks, teardownAudioGraph]);

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
    setTranscriptState ('');
    setDuration (0);
    setStatus ('requesting');
    pausedRef.current = false;
    terminatingRef.current = false;
    sessionReadyRef.current = false;
    pcmSendRemainderRef.current = new Int16Array (0);

    if (typeof window === 'undefined' || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError ('Recording requires a secure connection (HTTPS) and a supported browser.');
      setStatus ('idle');
      return;
    }

    if (isDemoMode ()) {
      setError ('Meeting transcription is disabled in demo mode. Sign in to a real workspace to record.');
      setStatus ('idle');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia ({ audio: true });
      permissionKnownRef.current = 'granted';
      streamRef.current = stream;

      const token = await fetchAssemblyAiToken ();
      const models = speechModelsToTry ();
      const turnHandlers: StreamingMessageHandlers = {
        onTurn: (msg) => {
          const tx = transcriptFromTurn (msg);
          if (!tx) return;
          if (msg.end_of_turn) {
            setTranscriptState ((prev) => appendText (prev, tx));
            setInterimText ('');
          } else {
            setInterimText (tx);
          }
        },
        onServerError: (detail) => {
          setError (detail);
          stop ();
        },
      };

      let ws: WebSocket | null = null;
      let lastConnectError: Error | null = null;

      for (let i = 0; i < models.length; i += 1) {
        const speechModel = models[i];
        try {
          ws = await establishStreamingSession (token, speechModel, turnHandlers);
          activeSpeechModelRef.current = speechModel;
          break;
        } catch (err) {
          lastConnectError = err instanceof Error ? err : new Error (String (err || ''));
          if (i < models.length - 1) {
            console.warn (
              `[transcription] model ${speechModel} failed, retrying with ${models[i + 1]}`,
              lastConnectError.message,
            );
          }
        }
      }

      if (!ws) {
        throw lastConnectError || new Error ('Could not start transcription session.');
      }

      sessionReadyRef.current = true;
      wsRef.current = ws;

      ws.addEventListener ('close', (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        const wasUserInitiated = terminatingRef.current;
        const speechModel = activeSpeechModelRef.current;
        terminatingRef.current = false;
        sessionReadyRef.current = false;
        activeSpeechModelRef.current = null;
        clearTimer ();
        teardownAudioGraph ();
        stopTracks ();
        setInterimText ('');
        const isCleanClose = ev.code === 1000 || ev.code === 1005;
        console.info (
          '[transcription] ws closed',
          { code: ev.code, reason: ev.reason, wasUserInitiated, isCleanClose, speechModel },
        );
        if (wasUserInitiated || isCleanClose) {
          setError (null);
        } else if (ev.code > 0 || ev.reason) {
          setError (
            streamingCloseErrorMessage (ev.code, String (ev.reason || ''), speechModel || undefined),
          );
        }
        setStatus ((s) => (s === 'requesting' ? 'idle' : 'stopped'));
      });

      const audioContext = new AudioContext ({ sampleRate: TARGET_SAMPLE_RATE });
      audioContextRef.current = audioContext;
      const inputRate = audioContext.sampleRate;
      const source = audioContext.createMediaStreamSource (stream);
      sourceRef.current = source;
      const analyser = audioContext.createAnalyser ();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      analyserRef.current = analyser;
      const processorSize = scriptProcessorBufferSize (inputRate);
      const processor = audioContext.createScriptProcessor (processorSize, 1, 1);
      processorRef.current = processor;
      const pcmRemainder = { current: pcmSendRemainderRef.current };
      processor.onaudioprocess = (event) => {
        if (pausedRef.current || !sessionReadyRef.current) return;
        const wsLive = wsRef.current;
        if (!wsLive || wsLive.readyState !== WebSocket.OPEN) return;
        const channel = event.inputBuffer.getChannelData (0);
        const pcm = resampleFloatTo16k (channel, inputRate);
        try {
          sendPcmInAssemblyChunks (wsLive, pcm, pcmRemainder);
          pcmSendRemainderRef.current = pcmRemainder.current;
        } catch (_) {}
      };
      source.connect (analyser);
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
      stopSpeechRecognition ();
      teardownAudioGraph ();
      closeWs (true);
      stopTracks ();
    };
  }, [clearTimer, stopSpeechRecognition, closeWs, stopTracks, teardownAudioGraph]);

  return {
    status,
    transcript,
    interimText,
    error,
    duration,
    analyserRef,
    start,
    pause,
    resume,
    stop,
    setTranscript: setTranscriptState,
  };
}
