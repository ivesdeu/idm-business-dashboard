import { useState } from 'react';
import { AudioLines, Settings2, UserPlus, Volume2, Copy } from 'lucide-react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MeetingNotePanel } from '@/components/scheduling/MeetingNotePanel';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

function getSupabase (): SupabaseClient | null {
  if (typeof window === 'undefined') return null;
  const c = (window as unknown as { supabaseClient?: SupabaseClient }).supabaseClient;
  return c ?? null;
}

function getOrgId (): string | null {
  if (typeof window === 'undefined') return null;
  const fn = (window as unknown as { bizDashGetCurrentOrgId?: () => string | null }).bizDashGetCurrentOrgId;
  const id = typeof fn === 'function' ? fn () : null;
  return id && String (id).trim () ? String (id).trim () : null;
}

export function MeetingNotesPage () {
  const [open, setOpen] = useState (false);
  const now = new Date ();
  const headerDate = `@${now.toLocaleDateString (undefined, { weekday: 'long' })} ${now.toLocaleTimeString ([], { hour: 'numeric', minute: '2-digit' })}`;

  return (
    <div className="meeting-notes-root mx-auto w-full max-w-[1040px] px-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight text-[var(--text)]">
        {headerDate}
      </h1>

      <Card className="mt-4 rounded-2xl border-[var(--border)] bg-[var(--bg2)] shadow-none">
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-2">
              <CardTitle className="text-[34px] leading-none text-[var(--text)]">Meeting</CardTitle>
              <span className="text-[34px] font-semibold leading-none tracking-tight text-[var(--text3)]">@Today</span>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-9 w-9 rounded-xl border-[var(--border)] text-[var(--text3)] shadow-none"
                aria-label="Meeting transcription settings"
              >
                <Settings2 className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-9 rounded-xl border-[var(--border)] bg-transparent shadow-none"
                onClick={() => setOpen (true)}
                aria-label="Start transcribing"
              >
                Start transcribing
              </Button>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--bg3)] px-3 py-1 text-xs font-medium text-[var(--text2)]">
              <AudioLines className="h-3.5 w-3.5 text-[var(--text3)]" strokeWidth={1.8} aria-hidden />
              Notes
            </span>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text3)] transition-colors hover:bg-[var(--bg3)] hover:text-[var(--text2)]"
              aria-label="Add attendee"
            >
              <UserPlus className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <CardDescription className="mt-3 text-sm">
            Notion AI will summarize the notes and transcript
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          <div className="rounded-2xl border border-[#cfe0f2] bg-[#edf5ff] px-4 py-3">
            <p className="text-sm font-semibold text-[#2f5f92]">Choose how you notify others</p>
            <p className="mt-1 max-w-[920px] text-sm leading-relaxed text-[#3e6e9f]">
              To let others know you're transcribing, Notion can play an audio message or you can continue to
              get consent yourself. Set your default for all meetings:
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex h-8 items-center justify-center rounded-xl border border-[#8fb9e3] bg-white px-3 text-sm font-medium text-[#2f5f92] transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8fb9e3]"
                style={{
                  background: '#ffffff',
                  backgroundImage: 'none',
                  borderStyle: 'solid',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                  boxShadow: 'none',
                  filter: 'none',
                }}
              >
                Get consent myself
              </button>
              <button
                type="button"
                className="inline-flex h-8 items-center justify-center rounded-xl border border-[#8fb9e3] bg-white px-3 text-sm font-medium text-[#2f5f92] transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8fb9e3]"
                style={{
                  background: '#ffffff',
                  backgroundImage: 'none',
                  borderStyle: 'solid',
                  WebkitAppearance: 'none',
                  appearance: 'none',
                  boxShadow: 'none',
                  filter: 'none',
                }}
              >
                Automatically play audio
              </button>
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex items-center justify-between gap-4 border-t border-[var(--border)] pt-4">
          <div className="flex items-center gap-4 text-sm text-[var(--text3)]">
            <span className="font-medium text-[var(--text2)]">
              Instructions: <span className="ml-1 text-[var(--text)]">Auto</span>
            </span>
            <span className="h-5 w-px bg-[var(--border2)]" aria-hidden />
            <span>By starting, you confirm everyone being transcribed has given consent.</span>
          </div>
          <div className="flex items-center gap-2 text-[var(--text3)]">
            <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-xl border-[var(--border)] shadow-none" aria-label="Play notice">
              <Volume2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="icon" className="h-8 w-8 rounded-xl border-[var(--border)] shadow-none" aria-label="Copy notice">
              <Copy className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </CardFooter>
      </Card>

      <MeetingNotePanel
        open={open}
        organizationId={getOrgId ()}
        supabase={getSupabase ()}
        appointment={null}
        onClose={() => setOpen (false)}
      />
    </div>
  );
}
