import { useEffect, useRef, useState, type RefObject } from 'react';

const BAR_COUNT = 56;
const MIN_BAR_PX = 3;
const MAX_BAR_PX = 26;

type AudioWaveformProps = {
  analyserRef: RefObject<AnalyserNode | null>;
  active: boolean;
  className?: string;
};

function sampleLevel (analyser: AnalyserNode, data: Uint8Array): number {
  analyser.getByteFrequencyData (data);
  let sum = 0;
  const len = Math.min (data.length, 64);
  for (let i = 0; i < len; i += 1) {
    sum += data[i];
  }
  const avg = len > 0 ? sum / len / 255 : 0;
  return Math.min (1, Math.pow (avg, 0.85) * 1.35);
}

export function AudioWaveform ({ analyserRef, active, className = '' }: AudioWaveformProps) {
  const [bars, setBars] = useState<number[]> (() => Array (BAR_COUNT).fill (0.08));
  const bufferRef = useRef<number[]> (Array (BAR_COUNT).fill (0.08));
  const dataRef = useRef<Uint8Array | null> (null);
  const rafRef = useRef<number | null> (null);

  useEffect (() => {
    if (!active) {
      if (rafRef.current != null) {
        cancelAnimationFrame (rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const tick = () => {
      const analyser = analyserRef.current;
      if (!analyser) {
        rafRef.current = requestAnimationFrame (tick);
        return;
      }
      if (!dataRef.current || dataRef.current.length !== analyser.frequencyBinCount) {
        dataRef.current = new Uint8Array (analyser.frequencyBinCount);
      }
      const data = dataRef.current;
      const level = sampleLevel (analyser, data);
      const buf = bufferRef.current;
      buf.shift ();
      buf.push (level);
      setBars ([...buf]);
      rafRef.current = requestAnimationFrame (tick);
    };

    rafRef.current = requestAnimationFrame (tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame (rafRef.current);
        rafRef.current = null;
      }
    };
  }, [active, analyserRef]);

  return (
    <div
      className={`flex min-w-0 flex-1 items-center justify-center gap-[3px] overflow-hidden px-2 ${className}`}
      aria-hidden
    >
      {bars.map ((level, idx) => {
        const h = MIN_BAR_PX + level * (MAX_BAR_PX - MIN_BAR_PX);
        return (
          <span
            key={idx}
            className="w-[3px] shrink-0 rounded-full bg-[#9ca3af]"
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}
