'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as PopoverPrimitive from '@radix-ui/react-popover';
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

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = 'center', sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        'z-50 w-64 rounded-xl bg-popover p-2 text-popover-foreground shadow-md outline-none',
        'animate-in data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2',
        'data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

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
      <div className="relative bg-card rounded-[28px] overflow-hidden shadow-2xl p-1">
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

const Settings2Icon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M20 7h-9" />
    <path d="M14 17H5" />
    <circle cx="17" cy="17" r="3" />
    <circle cx="7" cy="7" r="3" />
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

const GlobeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const PencilIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </svg>
);

const LightbulbIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" {...props}>
    <path d="M12 7C9.23858 7 7 9.23858 7 12C7 13.3613 7.54402 14.5955 8.42651 15.4972C8.77025 15.8484 9.05281 16.2663 9.14923 16.7482L9.67833 19.3924C9.86537 20.3272 10.6862 21 11.6395 21H12.3605C13.3138 21 14.1346 20.3272 14.3217 19.3924L14.8508 16.7482C14.9472 16.2663 15.2297 15.8484 15.5735 15.4972C16.456 14.5955 17 13.3613 17 12C17 9.23858 14.7614 7 12 7Z" stroke="currentColor" strokeWidth="2" />
    <path d="M12 4V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M18 6L19 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 12H21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 12H3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 5L6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 17H14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const MicIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
  </svg>
);

// ---------------------------------------------------------------------------
// Tools definition
// ---------------------------------------------------------------------------

const toolsList = [
  { id: 'searchWeb', name: 'Search the web', shortName: 'Search', icon: GlobeIcon },
  { id: 'writeCode', name: 'Write or code', shortName: 'Write', icon: PencilIcon },
  { id: 'thinkLonger', name: 'Think for longer', shortName: 'Think', icon: LightbulbIcon },
];

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
// PromptBox — the main component
// ---------------------------------------------------------------------------

export const PromptBox = React.forwardRef<HTMLTextAreaElement, Props>(
  ({ composerApi }, ref) => {
    const internalTextareaRef = React.useRef<HTMLTextAreaElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    const [value, setValue] = React.useState('');
    const [imagePreview, setImagePreview] = React.useState<string | null>(null);
    const [selectedTool, setSelectedTool] = React.useState<string | null>(null);
    const [isPopoverOpen, setIsPopoverOpen] = React.useState(false);
    const [isImageDialogOpen, setIsImageDialogOpen] = React.useState(false);

    // Merge external ref with internal
    React.useImperativeHandle(ref, () => internalTextareaRef.current!, []);

    // Auto-resize textarea
    React.useLayoutEffect(() => {
      const textarea = internalTextareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        const newHeight = Math.min(textarea.scrollHeight, 200);
        textarea.style.height = `${newHeight}px`;
      }
    }, [value]);

    // Sync tools selection to composerApi
    React.useEffect(() => {
      const isThink = selectedTool === 'thinkLonger';
      const isDeepSearch = selectedTool === 'deepResearch';
      composerApi?.setTools(isThink, isDeepSearch);
    }, [selectedTool, composerApi]);

    // Listen for prefill events from legacy JS
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
      // Delegate to legacy file input if composerApi.attach exists
      composerApi?.attach();
      // Also trigger internal file input for the image preview dialog
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
    const activeTool = selectedTool ? toolsList.find((t) => t.id === selectedTool) : null;
    const ActiveToolIcon = activeTool?.icon;

    return (
      <div
        className="flex flex-col rounded-[28px] p-2 shadow-[0_4px_28px_rgba(0,0,0,0.07)] transition-colors bg-white border border-[#e8e8e8] cursor-text w-full"
        data-advisor-composer
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
          accept="image/*"
        />

        {/* Image preview */}
        {imagePreview && (
          <Dialog open={isImageDialogOpen} onOpenChange={setIsImageDialogOpen}>
            <div className="relative mb-1 w-fit rounded-[1rem] px-1 pt-1">
              <button
                type="button"
                className="transition-transform"
                onClick={() => setIsImageDialogOpen(true)}
              >
                <img
                  src={imagePreview}
                  alt="Image preview"
                  className="h-14 w-14 rounded-[1rem] object-cover"
                />
              </button>
              <button
                onClick={handleRemoveImage}
                className="absolute right-2 top-2 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-white/70 text-black transition-colors hover:bg-white"
                aria-label="Remove image"
                type="button"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
            <DialogContent>
              <img
                src={imagePreview}
                alt="Full size preview"
                className="w-full max-h-[95vh] object-contain rounded-[24px]"
              />
            </DialogContent>
          </Dialog>
        )}

        {/* Textarea */}
        <textarea
          ref={internalTextareaRef}
          name="advisor-prompt"
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message..."
          maxLength={2000}
          autoComplete="off"
          aria-label="Message Advisor"
          className="w-full resize-none border-0 bg-transparent p-3 text-[15px] leading-relaxed text-[#1a1a1a] outline-none placeholder:text-[#8e8e8e] focus:ring-0 min-h-[48px]"
        />

        {/* Bottom toolbar */}
        <div className="mt-0.5 p-1 pt-0">
          <TooltipProvider delayDuration={100}>
            <div className="flex items-center gap-1.5">
              {/* Attach */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handlePlusClick}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[#3a3a3a] transition-colors hover:bg-neutral-100 focus-visible:outline-none"
                  >
                    <PlusIcon className="h-5 w-5" />
                    <span className="sr-only">Attach image</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" showArrow>
                  <p>Attach image</p>
                </TooltipContent>
              </Tooltip>

              {/* Tools popover */}
              <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-[#3a3a3a] font-medium transition-colors hover:bg-neutral-100 focus-visible:outline-none"
                      >
                        <Settings2Icon className="h-4 w-4" />
                        {!selectedTool && <span>Tools</span>}
                      </button>
                    </PopoverTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow>
                    <p>Explore Tools</p>
                  </TooltipContent>
                </Tooltip>
                <PopoverContent side="top" align="start" className="bg-white border border-[#e8e8e8] shadow-lg">
                  <div className="flex flex-col gap-0.5">
                    {toolsList.map((tool) => (
                      <button
                        key={tool.id}
                        type="button"
                        onClick={() => {
                          setSelectedTool(tool.id);
                          setIsPopoverOpen(false);
                        }}
                        className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-sm text-[#1a1a1a] hover:bg-neutral-100 transition-colors"
                      >
                        <tool.icon className="h-4 w-4 text-[#3a3a3a]" />
                        <span>{tool.name}</span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>

              {/* Active tool chip */}
              {activeTool && (
                <>
                  <div className="h-4 w-px bg-neutral-200" />
                  <button
                    type="button"
                    onClick={() => setSelectedTool(null)}
                    className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-[#2294ff] hover:bg-blue-50 transition-colors"
                  >
                    {ActiveToolIcon && <ActiveToolIcon className="h-4 w-4" />}
                    <span>{activeTool.shortName}</span>
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                </>
              )}

              {/* Right side: mic + send */}
              <div className="ml-auto flex items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-full text-[#3a3a3a] transition-colors hover:bg-neutral-100 focus-visible:outline-none"
                    >
                      <MicIcon className="h-4 w-4" />
                      <span className="sr-only">Record voice</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow>
                    <p>Record voice</p>
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      disabled={!hasValue}
                      onClick={submit}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors focus-visible:outline-none disabled:pointer-events-none bg-[#0a0a0a] text-white hover:bg-[#2d2d33] disabled:bg-neutral-200 disabled:text-neutral-400"
                    >
                      <SendIcon className="h-4 w-4" />
                      <span className="sr-only">Send message</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" showArrow>
                    <p>Send</p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </TooltipProvider>
        </div>
      </div>
    );
  },
);
PromptBox.displayName = 'PromptBox';
