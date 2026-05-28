import { useCallback } from 'react';
import { useVoiceSession } from './useVoiceSession';

export function VoiceAgentLauncher() {
  const onFinal = useCallback((text: string) => {
    if (typeof window.bizDashAdvisorAsk === 'function') {
      window.bizDashAdvisorAsk(text, { voice: true });
    }
  }, []);

  const { status, interim, error, toggle } = useVoiceSession({ onFinalTranscript: onFinal });

  const label =
    status === 'listening'
      ? 'Listening…'
      : status === 'processing'
        ? 'Thinking…'
        : 'Talk to Advisor';

  return (
    <div className="voice-agent-launcher" style={{ marginTop: 8 }}>
      <button
        type="button"
        className="btn"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          fontSize: 11,
          fontWeight: 600,
          padding: '8px 10px',
          borderColor: status === 'listening' ? 'var(--coral)' : undefined,
        }}
        aria-pressed={status === 'listening'}
        aria-label={label}
        title={error || label}
        onClick={() => toggle()}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
        {label}
      </button>
      {interim ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            color: 'var(--text3)',
            lineHeight: 1.4,
            maxHeight: 48,
            overflow: 'hidden',
          }}
        >
          {interim}
        </div>
      ) : null}
      {error ? (
        <div style={{ marginTop: 4, fontSize: 10, color: '#b91c1c' }} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
