import type { RefObject } from 'react';
import { SpeakerWaveIcon, MicrophoneIcon, PlayIcon, Cog6ToothIcon } from '@heroicons/react/24/solid';
import { AudioWaveform } from '@/components/scheduling/AudioWaveform';
import type { TranscriptionStatus } from '@/components/scheduling/types';
import { Button } from '@/components/ui/button';

type InlineRecordingBarProps = {
  status: TranscriptionStatus;
  analyserRef: RefObject<AnalyserNode | null>;
  error: string | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
};

export function InlineRecordingBar ({
  status,
  analyserRef,
  error,
  onPause,
  onResume,
  onStop,
}: InlineRecordingBarProps) {
  const isRecording = status === 'recording';
  const isPaused = status === 'paused';
  const isRequesting = status === 'requesting';
  const waveformActive = isRecording && !isPaused;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--bg3)] px-3 py-1 text-xs font-medium text-[var(--text2)]">
          <SpeakerWaveIcon className="h-3.5 w-3.5 text-[var(--text3)]" aria-hidden />
          Notes
        </span>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-[var(--text)]">
          <MicrophoneIcon className="h-4 w-4 text-[var(--text3)]" aria-hidden />
          Transcript
        </span>

        <AudioWaveform
          analyserRef={analyserRef}
          active={waveformActive}
          className="mx-1 h-8"
        />

        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-8 w-8 shrink-0 rounded-xl border-[var(--border)] text-[var(--text3)] shadow-none"
          aria-label="Meeting transcription settings"
        >
          <Cog6ToothIcon className="h-4 w-4" aria-hidden />
        </Button>

        {isRecording ? (
          <Button
            type="button"
            variant="outline"
            className="h-8 shrink-0 rounded-xl border-[var(--border)] bg-[var(--bg)] px-3 text-sm shadow-none"
            onClick={onPause}
          >
            Pause
          </Button>
        ) : null}
        {isPaused ? (
          <Button
            type="button"
            variant="outline"
            className="h-8 shrink-0 rounded-xl border-[var(--border)] bg-[var(--bg)] px-3 text-sm shadow-none"
            onClick={onResume}
          >
            <PlayIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
            Resume
          </Button>
        ) : null}
        {(isRecording || isPaused || isRequesting) ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 shrink-0 rounded-xl border-0 bg-[#fef2f2] px-3 text-sm font-medium text-[#b42318] shadow-none outline-none ring-0 hover:bg-[#fee2e2] focus:outline-none focus-visible:outline-none focus-visible:ring-0"
            style={{
              WebkitAppearance: 'none',
              appearance: 'none',
              boxShadow: 'none',
              border: 'none',
              outline: 'none',
            }}
            onClick={onStop}
          >
            Stop
          </Button>
        ) : null}
      </div>

      {isRequesting ? (
        <p className="text-xs text-[var(--text3)]">Preparing recorder…</p>
      ) : null}
      {error ? <p className="text-xs text-[var(--red)]">{error}</p> : null}
    </div>
  );
}
