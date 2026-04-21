import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Lightbulb, Mic, Globe, Paperclip, Send } from 'lucide-react';

const PLACEHOLDERS = [
  'Why is revenue down?',
  'Compose an email for a follow-up',
  'Create a financial report for June',
  'Schedule an appointment with Alex',
  'Send an invoice',
  'Summarize this article',
];

export type AdvisorComposerApi = {
  send: (text: string) => void;
  attach: () => void;
  setTools: (think: boolean, deepSearch: boolean) => void;
} | null;

type Props = {
  composerApi: AdvisorComposerApi;
};

/**
 * New Advisor composer. Tailwind is limited to `advisor-island.css` (preflight off).
 * Wired to window.bizDashAdvisorGetComposerApi() from legacy dashboard-assistant.
 */
function AIChatInput({ composerApi }: Props) {
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [showPlaceholder, setShowPlaceholder] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const [thinkActive, setThinkActive] = useState(false);
  const [deepSearchActive, setDeepSearchActive] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Cycle placeholder when unfocused & empty
  useEffect(() => {
    if (isActive || inputValue) return;

    const interval = setInterval(() => {
      setShowPlaceholder(false);
      setTimeout(() => {
        setPlaceholderIndex((prev) => (prev + 1) % PLACEHOLDERS.length);
        setShowPlaceholder(true);
      }, 400);
    }, 3000);

    return () => clearInterval(interval);
  }, [isActive, inputValue]);

  useEffect(() => {
    composerApi?.setTools(thinkActive, deepSearchActive);
  }, [thinkActive, deepSearchActive, composerApi]);

  // External prefill (CRM "ask advisor", clear)
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent<{ value?: string; focus?: boolean }>).detail;
      if (d?.value != null) setInputValue(String(d.value));
      if (d?.focus) requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('advisor-composer-prefill', onPrefill);
    return () => window.removeEventListener('advisor-composer-prefill', onPrefill);
  }, []);

  // Click outside: collapse if empty
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        if (!inputValue) setIsActive(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [inputValue]);

  const handleActivate = () => setIsActive(true);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = inputValue.trim();
    if (!t || !composerApi) return;
    composerApi.send(t);
    setInputValue('');
    setIsActive(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (inputValue.trim() && composerApi) {
        composerApi.send(inputValue.trim());
        setInputValue('');
        setIsActive(false);
      }
    }
  };

  const onAttach = () => {
    if (composerApi) composerApi.attach();
  };

  const containerVariants = {
    collapsed: {
      minHeight: 68,
      boxShadow: '0 2px 12px 0 rgba(15, 23, 42, 0.08)',
      transition: { type: 'spring' as const, stiffness: 120, damping: 18 },
    },
    expanded: {
      minHeight: 130,
      boxShadow: '0 10px 36px 0 rgba(15, 23, 42, 0.12)',
      transition: { type: 'spring' as const, stiffness: 120, damping: 18 },
    },
  };

  const letterVariants = {
    initial: {
      opacity: 0,
      filter: 'blur(12px)',
      y: 10,
    },
    animate: {
      opacity: 1,
      filter: 'blur(0px)',
      y: 0,
      transition: {
        opacity: { duration: 0.25 },
        filter: { duration: 0.4 },
        y: { type: 'spring' as const, stiffness: 80, damping: 20 },
      },
    },
    exit: {
      opacity: 0,
      filter: 'blur(12px)',
      y: -10,
      transition: {
        opacity: { duration: 0.2 },
        filter: { duration: 0.3 },
        y: { type: 'spring' as const, stiffness: 80, damping: 20 },
      },
    },
  };

  return (
    <div className="w-full max-w-3xl mx-auto text-[var(--advisor-text)]" data-advisor-composer style={{ minHeight: 72 }}>
      <motion.div
        ref={wrapperRef}
        className="w-full"
        variants={containerVariants}
        animate={isActive || inputValue ? 'expanded' : 'collapsed'}
        initial={false}
        onClick={handleActivate}
        style={{
          overflow: 'hidden',
          borderRadius: 28,
          background: 'var(--advisor-surface)',
          border: '1px solid var(--advisor-border)',
          boxSizing: 'border-box',
          minHeight: 68,
        }}
      >
        <form className="flex flex-col h-full w-full" onSubmit={onSubmit}>
          <div className="flex items-center gap-1 sm:gap-2 p-2 sm:p-3 w-full min-w-0 bg-[var(--advisor-surface)]">
            <button
              className="p-2.5 sm:p-3 rounded-full transition shrink-0 hover:opacity-90"
              style={{ color: 'var(--advisor-muted)' }}
              title="Attach image"
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onAttach();
              }}
            >
              <Paperclip size={20} />
            </button>

            <div className="relative flex-1 min-w-0">
              <input
                ref={inputRef}
                type="text"
                name="advisor-prompt"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onFocus={handleActivate}
                onKeyDown={onKeyDown}
                className="w-full min-w-0 border-0 outline-0 rounded-md py-2 text-sm sm:text-base bg-transparent font-normal"
                style={{ position: 'relative', zIndex: 1, color: 'var(--advisor-text)' }}
                maxLength={2000}
                autoComplete="off"
                aria-label="Message Advisor"
              />
              <div className="absolute left-0 top-0 w-full h-full flex items-center px-2 sm:px-3 py-2 pointer-events-none min-w-0">
                <AnimatePresence mode="wait">
                  {showPlaceholder && !isActive && !inputValue && (
                    <motion.span
                      key={placeholderIndex}
                      className="left-0 top-1/2 -translate-y-1/2 text-[var(--advisor-muted)] select-none min-w-0 w-full"
                      style={{
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        zIndex: 0,
                      }}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                    >
                      {PLACEHOLDERS[placeholderIndex].split('').map((char, i) => (
                        <motion.span
                          // eslint-disable-next-line react/no-array-index-key -- per-letter animation
                          key={i}
                          variants={letterVariants}
                          style={{ display: 'inline-block' }}
                        >
                          {char === ' ' ? '\u00A0' : char}
                        </motion.span>
                      ))}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <button
              className="p-2.5 sm:p-3 rounded-full transition shrink-0"
              style={{ color: 'var(--advisor-muted)' }}
              title="Voice input isn’t available in this browser"
              type="button"
              tabIndex={-1}
            >
              <Mic size={20} />
            </button>
            <button
              className="flex items-center text-white p-2.5 sm:p-3 rounded-full font-medium justify-center shrink-0"
              style={{ background: 'var(--advisor-accent)' }}
              title="Send"
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                if (inputValue.trim() && composerApi) {
                  composerApi.send(inputValue.trim());
                  setInputValue('');
                  setIsActive(false);
                }
              }}
            >
              <Send size={18} />
            </button>
          </div>

          <motion.div
            className="w-full flex justify-start px-3 sm:px-4 items-center text-sm"
            variants={{
              hidden: {
                opacity: 0,
                y: 20,
                pointerEvents: 'none' as const,
                transition: { duration: 0.25 },
              },
              visible: {
                opacity: 1,
                y: 0,
                pointerEvents: 'auto' as const,
                transition: { duration: 0.35, delay: 0.08 },
              },
            }}
            initial="hidden"
            animate={isActive || inputValue ? 'visible' : 'hidden'}
            style={{ marginTop: 2 }}
          >
            <div className="flex gap-2 sm:gap-3 items-center flex-wrap">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setThinkActive((v) => {
                    const n = !v;
                    if (n) setDeepSearchActive(false);
                    return n;
                  });
                }}
                className="flex items-center gap-1 px-3 sm:px-4 py-2 rounded-full font-medium"
                style={
                  thinkActive
                    ? {
                        background: 'var(--advisor-tint)',
                        color: 'var(--advisor-text)',
                        boxShadow: 'inset 0 0 0 1px var(--advisor-tint-border)',
                      }
                    : { background: 'var(--advisor-elevated)', color: 'var(--advisor-muted)' }
                }
                title="Think for longer (maps to tool)"
              >
                <Lightbulb size={18} />
                Think
              </button>

              <motion.button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeepSearchActive((v) => {
                    const n = !v;
                    if (n) setThinkActive(false);
                    return n;
                  });
                }}
                className="flex items-center py-2 rounded-full font-medium whitespace-nowrap min-h-[40px]"
                style={
                  deepSearchActive
                    ? {
                        background: 'var(--advisor-tint)',
                        color: 'var(--advisor-text)',
                        boxShadow: 'inset 0 0 0 1px var(--advisor-tint-border)',
                        padding: '0 0.5rem 0 0.25rem',
                      }
                    : { background: 'var(--advisor-elevated)', color: 'var(--advisor-muted)', padding: '0 0.5rem' }
                }
                initial={false}
                animate={{ width: deepSearchActive ? 128 : 36 }}
                title="Deep research"
              >
                <div className="flex-1 flex justify-center">
                  <Globe size={18} />
                </div>
                <motion.span
                  className="pb-0.5 pl-0.5 text-left"
                  initial={false}
                  animate={{ opacity: deepSearchActive ? 1 : 0, width: deepSearchActive ? 'auto' : 0 }}
                >
                  Deep
                </motion.span>
              </motion.button>
            </div>
          </motion.div>
        </form>
      </motion.div>
    </div>
  );
}

export { AIChatInput };
