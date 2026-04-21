import { X } from 'lucide-react';

type Props = {
  open: boolean;
  onClose: () => void;
};

export function GoogleCalendarModal ({ open, onClose }: Props) {
  if (!open) return null;

  function stubAuthorize () {
    console.log('[Scheduling] Authorize with Google — stub OAuth flow');
    onClose ();
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/35 p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose ();
      }}
    >
      <div
        className="relative w-full max-w-md border border-[var(--sched-border,#e2e8f0)] bg-[var(--sched-surface,#fff)] p-6"
        role="dialog"
        aria-labelledby="gcal-modal-title"
        onMouseDown={(e) => e.stopPropagation ()}
      >
        <button
          type="button"
          className="absolute right-3 top-3 rounded-md p-1 text-[var(--sched-muted,#64748b)] hover:bg-black/5"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="h-5 w-5" strokeWidth={2} />
        </button>
        <h2 id="gcal-modal-title" className="pr-8 text-lg font-semibold text-[var(--sched-text,#0f172a)]">
          Connect Google Calendar
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--sched-muted,#64748b)]">
          Compass can sync appointments with Google Calendar once you authorize this workspace. Full OAuth and API access
          will ship in a later release — this dialog is here for demos.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-lg bg-[var(--sched-accent,#0a0a0a)] px-4 py-2 text-sm font-semibold text-white hover:opacity-95"
            onClick={stubAuthorize}
          >
            Authorize with Google
          </button>
          <button type="button" className="rounded-lg border border-[var(--sched-border)] px-4 py-2 text-sm font-medium" onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
