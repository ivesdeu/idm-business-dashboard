'use client';

import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Mic, Plus, SlidersHorizontal } from 'lucide-react';

export type AdvisorComposerApi = {
  send: (text: string) => void;
  attach: () => void;
  setTools: (think: boolean, deepSearch: boolean) => void;
} | null;

type Props = {
  composerApi: AdvisorComposerApi;
};

/**
 * Advisor composer — minimal chat-style input (centered heading + rounded shell).
 * Tailwind via `advisor-island.css` (preflight off). Wired from `dashboard-assistant.js`.
 */
function AIChatInput({ composerApi }: Props) {
  const [toolsActive, setToolsActive] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    composerApi?.setTools(toolsActive, false);
  }, [toolsActive, composerApi]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 26), 180)}px`;
  }, [inputValue]);

  useEffect(() => {
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent<{ value?: string; focus?: boolean }>).detail;
      if (d?.value != null) setInputValue(String(d.value));
      if (d?.focus) requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener('advisor-composer-prefill', onPrefill);
    return () => window.removeEventListener('advisor-composer-prefill', onPrefill);
  }, []);

  const submit = () => {
    const t = inputValue.trim();
    if (!t || !composerApi) return;
    composerApi.send(t);
    setInputValue('');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onAttach = () => {
    composerApi?.attach();
  };

  const iconCircle =
    'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[color:var(--text2)] transition-colors hover:bg-[color:var(--bg3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--coral-border-focus)]';
  const toolsBtnBase =
    'inline-flex h-10 shrink-0 items-center justify-center rounded-full text-[color:var(--text2)] gap-2 px-3.5 font-medium text-[14px] transition-colors hover:bg-[color:var(--bg3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--coral-border-focus)]';

  return (
    <div className="w-full max-w-2xl mx-auto px-2 sm:px-3" data-advisor-composer ref={wrapperRef}>
      <h2 className="text-center text-[color:var(--text)] text-xl sm:text-[1.65rem] font-semibold tracking-tight mb-5 sm:mb-7">
        How Can I Help You
      </h2>

      <div className="rounded-[28px] bg-[color:var(--bg2)] border border-[color:var(--border)] shadow-[0_2px_20px_rgba(0,0,0,0.06)] px-4 sm:px-5 pt-3.5 pb-3 flex flex-col min-h-[128px]">
        <form className="flex flex-col flex-1 gap-3 min-h-0" onSubmit={onSubmit}>
          <textarea
            ref={taRef}
            name="advisor-prompt"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            className="w-full min-h-[26px] max-h-[180px] resize-none border-0 bg-transparent text-[15px] leading-[1.5] text-[color:var(--text)] outline-none placeholder:text-[color:var(--text3)] py-1"
            placeholder="Message..."
            maxLength={2000}
            autoComplete="off"
            aria-label="Message Advisor"
          />

          <div className="flex items-center justify-between gap-3 pt-2 mt-auto border-t border-[color:var(--border)]">
            <div className="flex items-center gap-0.5 min-w-0">
              <button
                type="button"
                className={iconCircle}
                title="Attach image"
                aria-label="Attach image"
                onClick={onAttach}
              >
                <Plus size={20} strokeWidth={1.75} />
              </button>
              <button
                type="button"
                className={
                  toolsBtnBase +
                  (toolsActive
                    ? ' bg-[color:var(--bg3)] text-[color:var(--text)] ring-1 ring-[color:var(--border2)]'
                    : '')
                }
                title="Tools"
                aria-pressed={toolsActive}
                onClick={() => setToolsActive((v) => !v)}
              >
                <SlidersHorizontal size={18} strokeWidth={1.75} aria-hidden />
                <span className="pr-0.5">Tools</span>
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                className={iconCircle}
                title="Voice input"
                aria-label="Voice input (not available yet)"
              >
                <Mic size={20} strokeWidth={1.75} />
              </button>
              <button
                type="submit"
                disabled={!inputValue.trim()}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--coral)] text-white shadow-sm transition-opacity hover:bg-[color:var(--coral2)] disabled:opacity-35 disabled:cursor-not-allowed disabled:hover:bg-[color:var(--coral)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--coral-border-focus)]"
                title="Send"
                aria-label="Send message"
              >
                <ArrowUp size={18} strokeWidth={2.25} />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export { AIChatInput };
