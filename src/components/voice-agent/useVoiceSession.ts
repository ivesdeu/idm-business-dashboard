import { useCallback, useRef, useState } from 'react';

type SpeechRecognitionCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export type VoiceSessionStatus = 'idle' | 'listening' | 'processing';

type Options = {
  onFinalTranscript: (text: string) => void;
  silenceMs?: number;
};

export function useVoiceSession({ onFinalTranscript, silenceMs = 1400 }: Options) {
  const [status, setStatus] = useState<VoiceSessionStatus>('idle');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<InstanceType<SpeechRecognitionCtor> | null>(null);
  const activeRef = useRef(false);
  const finalBufferRef = useRef('');
  const silenceTimerRef = useRef<number | null>(null);

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current != null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
  }, []);

  const scheduleFinalize = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = window.setTimeout(() => {
      const text = finalBufferRef.current.trim();
      finalBufferRef.current = '';
      setInterim('');
      activeRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch (_) {}
        recognitionRef.current = null;
      }
      setStatus('idle');
      if (text) {
        setStatus('processing');
        onFinalTranscript(text);
        window.setTimeout(() => setStatus('idle'), 400);
      }
    }, silenceMs);
  }, [clearSilenceTimer, onFinalTranscript, silenceMs]);

  const stop = useCallback(() => {
    clearSilenceTimer();
    activeRef.current = false;
    const text = `${finalBufferRef.current} ${interim}`.trim();
    finalBufferRef.current = '';
    setInterim('');
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
      recognitionRef.current = null;
    }
    setStatus('idle');
    if (text) {
      setStatus('processing');
      onFinalTranscript(text);
      window.setTimeout(() => setStatus('idle'), 400);
    }
  }, [clearSilenceTimer, interim, onFinalTranscript]);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError('Voice input requires Chrome, Edge, or Safari.');
      return;
    }
    setError(null);
    finalBufferRef.current = '';
    setInterim('');
    activeRef.current = true;
    setStatus('listening');

    const sr = new Ctor();
    sr.continuous = true;
    sr.interimResults = true;
    sr.lang = 'en-US';
    sr.onresult = (event: SpeechRecognitionEvent) => {
      if (!activeRef.current) return;
      let interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const chunk = res[0]?.transcript ?? '';
        if (res.isFinal) {
          finalBufferRef.current = `${finalBufferRef.current} ${chunk}`.trim();
        } else {
          interimText = `${interimText} ${chunk}`.trim();
        }
      }
      setInterim(interimText);
      if (finalBufferRef.current) scheduleFinalize();
    };
    sr.onerror = (ev) => {
      const code = ev?.error || '';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        setError('Microphone permission denied.');
        activeRef.current = false;
        setStatus('idle');
      }
    };
    sr.onend = () => {
      if (activeRef.current && recognitionRef.current === sr) {
        try {
          sr.start();
        } catch (_) {}
      }
    };
    recognitionRef.current = sr;
    try {
      sr.start();
    } catch {
      setError('Could not start microphone.');
      activeRef.current = false;
      setStatus('idle');
    }
  }, [scheduleFinalize]);

  const toggle = useCallback(() => {
    if (status === 'listening') {
      stop();
    } else if (status === 'idle') {
      start();
    }
  }, [start, status, stop]);

  return { status, interim, error, toggle, stop, start };
}
