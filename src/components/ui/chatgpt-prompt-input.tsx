'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Radix primitives
// ---------------------------------------------------------------------------

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & { showArrow?: boolean }
>(({ className, sideOffset = 4, showArrow = false, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'relative z-50 max-w-[280px] rounded-md bg-popover text-popover-foreground px-1.5 py-1 text-xs',
        'animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        'data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2',
        'data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2',
        'data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    >
      {props.children}
      {showArrow && <TooltipPrimitive.Arrow className="-my-px fill-popover" />}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

const Dialog = DialogPrimitive.Root;
const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 backdrop-blur-sm',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-[90vw] md:max-w-[800px]',
        'translate-x-[-50%] translate-y-[-50%] gap-4 border-none bg-transparent p-0 shadow-none',
        'duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        className,
      )}
      {...props}
    >
      <div className="relative overflow-hidden rounded-2xl border border-[#e5e5e5] bg-white p-1 shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 z-10 rounded-full bg-background/50 p-1 hover:bg-accent transition-all">
          <XIcon className="h-5 w-5 text-muted-foreground hover:text-foreground" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </div>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const PlusIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path d="M12 5V19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 12H19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SendIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path d="M12 5.25L12 18.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M18.75 12L12 5.25L5.25 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const XIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdvisorComposerApi = {
  send: (text: string) => void;
  attach: () => void;
  setTools: (think: boolean, deepSearch: boolean) => void;
} | null;

type Props = {
  composerApi: AdvisorComposerApi;
};

// ---------------------------------------------------------------------------
// PromptBox — attach + message + send (dashboard shell provides navigation).
// ---------------------------------------------------------------------------

export const PromptBox = React.forwardRef<HTMLTextAreaElement, Props>(({ composerApi }, ref) => {
  const internalTextareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [value, setValue] = React.useState('');
  const [imagePreview, setImagePreview] = React.useState<string | null>(null);
  const [isImageDialogOpen, setIsImageDialogOpen] = React.useState(false);

  React.useImperativeHandle(ref, () => internalTextareaRef.current!, []);

  React.useEffect(() => {
    composerApi?.setTools(false, false);
  }, [composerApi]);

  React.useLayoutEffect(() => {
    const textarea = internalTextareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const newHeight = Math.min(textarea.scrollHeight, 200);
      textarea.style.height = `${newHeight}px`;
    }
  }, [value]);

  React.useEffect(() => {
    const onPrefill = (e: Event) => {
      const d = (e as CustomEvent<{ value?: string; focus?: boolean }>).detail;
      if (d?.value != null) setValue(String(d.value));
      if (d?.focus) requestAnimationFrame(() => internalTextareaRef.current?.focus());
    };
    window.addEventListener('advisor-composer-prefill', onPrefill);
    return () => window.removeEventListener('advisor-composer-prefill', onPrefill);
  }, []);

  const submit = () => {
    const t = value.trim();
    if (!t || !composerApi) return;
    composerApi.send(t);
    setValue('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handlePlusClick = () => {
    composerApi?.attach();
    fileInputRef.current?.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
    event.target.value = '';
  };

  const handleRemoveImage = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasValue = value.trim().length > 0 || imagePreview;

  return (
    <div className="advisor-composer-shell flex w-full flex-col items-stretch gap-5 sm:gap-6">
      <h2 className="advisor-composer-greeting text-center text-lg font-semibold tracking-tight text-foreground sm:text-xl">
        What can I do for you?
      </h2>
      <div
        className="flex w-full cursor-text flex-col rounded-xl border border-border bg-background px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-[border-color,box-shadow] focus-within:border-neutral-300/90 focus-within:shadow-[0_2px_12px_rgba(15,23,42,0.08)]"
        data-advisor-composer
      >
      <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="image/*" />

      {imagePreview && (
        <Dialog open={isImageDialogOpen} onOpenChange={setIsImageDialogOpen}>
          <div className="relative mb-2 w-fit">
            <button type="button" className="transition-opacity hover:opacity-95" onClick={() => setIsImageDialogOpen(true)}>
              <img src={imagePreview} alt="Image preview" className="h-12 w-12 rounded-lg border border-border object-cover" />
            </button>
            <button
              onClick={handleRemoveImage}
              className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-md border border-border bg-background text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.08)] transition-colors hover:bg-accent"
              aria-label="Remove image"
              type="button"
            >
              <XIcon className="h-3 w-3" />
            </button>
          </div>
          <DialogContent>
            <img src={imagePreview} alt="Full size preview" className="w-full max-h-[95vh] object-contain rounded-xl" />
          </DialogContent>
        </Dialog>
      )}

      <textarea
        ref={internalTextareaRef}
        name="advisor-prompt"
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask anything…"
        maxLength={2000}
        autoComplete="off"
        aria-label="Ask Advisor"
        className="w-full min-h-[44px] max-h-[200px] resize-none border-0 bg-transparent px-0.5 py-1.5 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus:ring-0"
      />

      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/70 pt-2">
        <p className="hidden text-[11px] text-muted-foreground sm:block">Shift+Enter for new line</p>
        <TooltipProvider delayDuration={100}>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handlePlusClick}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-transparent text-foreground/80 transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                >
                  <PlusIcon className="h-[18px] w-[18px]" />
                  <span className="sr-only">Attach image</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" showArrow>
                <p>Attach image</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  disabled={!hasValue}
                  onClick={submit}
                  className="inline-flex h-8 min-w-[2.25rem] shrink-0 items-center justify-center rounded-md border border-transparent bg-foreground px-2.5 text-xs font-semibold text-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:bg-neutral-200 disabled:text-neutral-400"
                >
                  <SendIcon className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only">Send message</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" showArrow>
                <p>Send</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
      </div>
    </div>
  );
});
PromptBox.displayName = 'PromptBox';
