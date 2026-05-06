import { Mic, Pause, Play, Square } from 'lucide-react';
import type { TranscriptionStatus } from '@/components/scheduling/types';

type RecordingBarProps = {
  status: TranscriptionStatus;
  duration: number;
  error: string | null;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

function mmss (seconds: number): string {
  const sec = Math.max (0, Math.floor (seconds || 0));
  const mm = String (Math.floor (sec / 60)).padStart (2, '0');
  const ss = String (sec % 60).padStart (2, '0');
  return `${mm}:${ss}`;
}

export function RecordingBar ({
  status,
  duration,
  error,
  onStart,
  onPause,
  onResume,
  onStop,
}: RecordingBarProps) {
  if (status === 'idle') {
    return (
      <div className="sticky top-0 z-20 mb-3 rounded-xl border border-[var(--border)] bg-[var(--bg2)] p-3 shadow-sm">
        <button type="button" className="btn btn-p inline-flex items-center gap-2" onClick={onStart}>
          <Mic className="h-4 w-4" aria-hidden />
          Start Recording
        </button>
        <p className="mt-2 text-xs text-[var(--text3)]">
          Captures your microphone. All speakers in the room will be picked up if on speaker.
        </p>
        {error ? <p className="mt-2 text-xs text-[var(--red)]">{error}</p> : null}
      </div>
    );
  }

  if (status === 'stopped') {
    return (
      <div className="sticky top-0 z-20 mb-3 rounded-xl border border-[var(--border)] bg-[var(--bg2)] p-3 shadow-sm">
        {error ? <p className="text-xs text-[var(--red)]">{error}</p> : <p className="text-xs text-[var(--text3)]">Recording stopped.</p>}
      </div>
    );
  }

  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isRequesting = status === 'requesting';

  return (
    <div className="sticky top-0 z-20 mb-3 rounded-xl border border-[var(--border)] bg-[var(--bg2)] p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            isRecording ? 'animate-pulse bg-red-500' : 'bg-amber-500'
          }`}
          aria-hidden
        />
        <span className="text-sm font-medium text-[var(--text)]">{isRequesting ? 'Preparing recorder…' : mmss (duration)}</span>
        {isRecording ? (
          <button type="button" className="btn inline-flex items-center gap-2" onClick={onPause}>
            <Pause className="h-4 w-4" aria-hidden />
            Pause
          </button>
        ) : null}
        {isPaused ? (
          <button type="button" className="btn inline-flex items-center gap-2" onClick={onResume}>
            <Play className="h-4 w-4" aria-hidden />
            Resume
          </button>
        ) : null}
        {(isRecording || isPaused || isRequesting) ? (
          <button type="button" className="btn inline-flex items-center gap-2" onClick={onStop}>
            <Square className="h-4 w-4" aria-hidden />
            Stop
          </button>
        ) : null}
      </div>
      {error ? <p className="mt-2 text-xs text-[var(--red)]">{error}</p> : null}
    </div>
  );
}
