import { useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  suggestions?: { email: string; label: string }[];
};

export function RecipientField({ label, value, onChange, placeholder, suggestions = [] }: Props) {
  const [input, setInput] = useState('');

  const addEmail = (raw: string) => {
    const e = raw.trim();
    if (!e || !e.includes('@')) return;
    if (!value.includes(e)) onChange([...value, e]);
    setInput('');
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter' || ev.key === ',') {
      ev.preventDefault();
      addEmail(input);
    }
    if (ev.key === 'Backspace' && !input && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  const filtered =
    input.trim().length > 1
      ? suggestions.filter(
          (s) =>
            s.email.toLowerCase().includes(input.toLowerCase()) ||
            s.label.toLowerCase().includes(input.toLowerCase()),
        ).slice(0, 6)
      : [];

  return (
    <div className="eml-field">
      <label className="eml-label">{label}</label>
      <div className="eml-recipients">
        {value.map((email) => (
          <span key={email} className="eml-chip">
            {email}
            <button type="button" className="eml-chip-x" onClick={() => onChange(value.filter((x) => x !== email))} aria-label={`Remove ${email}`}>
              ×
            </button>
          </span>
        ))}
        <input
          className="eml-recipient-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (input.trim()) addEmail(input);
          }}
          placeholder={value.length ? '' : placeholder}
          autoComplete="off"
        />
      </div>
      {filtered.length > 0 && (
        <ul className="eml-suggestions" role="listbox">
          {filtered.map((s) => (
            <li key={s.email}>
              <button
                type="button"
                className="eml-suggestion-btn"
                onMouseDown={(e) => {
                  e.preventDefault();
                  addEmail(s.email);
                }}
              >
                <span className="eml-suggestion-label">{s.label}</span>
                <span className="eml-suggestion-email">{s.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RecipientToggleRow({
  showCc,
  showBcc,
  onToggleCc,
  onToggleBcc,
}: {
  showCc: boolean;
  showBcc: boolean;
  onToggleCc: () => void;
  onToggleBcc: () => void;
}) {
  return (
    <div className="eml-recipient-toggles">
      {!showCc && (
        <button type="button" className="eml-link-btn" onClick={onToggleCc}>
          Cc
        </button>
      )}
      {!showBcc && (
        <button type="button" className={cn('eml-link-btn', !showCc && 'ml-2')} onClick={onToggleBcc}>
          Bcc
        </button>
      )}
    </div>
  );
}
