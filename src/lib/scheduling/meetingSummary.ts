import type { SupabaseClient } from '@supabase/supabase-js';
import type { MeetingActionItem } from '@/components/scheduling/types';

export type AdvisorMeetingSummaryPayload = {
  summary: string;
  action_items: Array<{
    task: string;
    owner: string;
    owner_user_id?: string | null;
    due_date: string | null;
  }>;
  key_decisions: string[];
  topics: string[];
};

function safeJsonParse<T> (raw: string): T | null {
  try {
    return JSON.parse (raw) as T;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOwnerUserId (value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim ();
  return UUID_RE.test (trimmed) ? trimmed : null;
}

export function normalizeActionItems (
  arr: Array<{
    task: string;
    owner: string;
    owner_user_id?: string | null;
    due_date: string | null;
  }>,
): MeetingActionItem[] {
  return (arr || [])
    .map ((item) => ({
      task: String (item.task || '').trim (),
      owner: String (item.owner || '').trim (),
      ownerUserId: parseOwnerUserId (item.owner_user_id),
      dueDate: item.due_date ? String (item.due_date) : null,
      completed: false,
    }))
    .filter ((item) => !!item.task);
}

export function parseMeetingSummaryFromAdvisorPayload (
  payload: unknown,
): AdvisorMeetingSummaryPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as {
    meetingSummary?: unknown;
    draft?: unknown;
    error?: unknown;
    details?: unknown;
  };
  if (body.meetingSummary && typeof body.meetingSummary === 'object') {
    const ms = body.meetingSummary as AdvisorMeetingSummaryPayload;
    if (typeof ms.summary === 'string' && Array.isArray (ms.action_items)) {
      return ms;
    }
  }
  const draft =
    typeof body.draft === 'string'
      ? body.draft.trim ()
      : '';
  if (draft) {
    const direct = safeJsonParse<AdvisorMeetingSummaryPayload> (draft);
    if (direct && typeof direct.summary === 'string' && Array.isArray (direct.action_items)) {
      return direct;
    }
    const firstBrace = draft.indexOf ('{');
    const lastBrace = draft.lastIndexOf ('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const sliced = safeJsonParse<AdvisorMeetingSummaryPayload> (
        draft.slice (firstBrace, lastBrace + 1),
      );
      if (sliced && typeof sliced.summary === 'string' && Array.isArray (sliced.action_items)) {
        return sliced;
      }
    }
  }
  return null;
}

type CallAdvisorOptions = {
  supabase: SupabaseClient;
  organizationId: string;
  title: string;
  attendees: string;
  transcript: string;
  manualNotes: string;
  summaryStyle?: 'auto' | 'bullets' | 'actions' | 'decisions';
};

export async function callAdvisorForMeetingSummary (
  options: CallAdvisorOptions,
): Promise<AdvisorMeetingSummaryPayload> {
  const {
    supabase,
    organizationId,
    title,
    attendees,
    transcript,
    manualNotes,
    summaryStyle = 'auto',
  } = options;
  const sessionRes = await supabase.auth.getSession ();
  const accessToken = sessionRes.data.session?.access_token || '';
  const base = typeof window !== 'undefined'
    ? String (
        (window as unknown as { __bizdashSupabaseUrl?: string }).__bizdashSupabaseUrl || '',
      )
      .trim ()
      .replace (/\/$/, '')
    : '';
  const anon = typeof window !== 'undefined'
    ? String (
        (window as unknown as { __bizdashSupabaseAnonKey?: string }).__bizdashSupabaseAnonKey || '',
      ).trim ()
    : '';
  if (!accessToken || !base || !anon) {
    throw new Error ('Sign in again to summarize this meeting.');
  }

  const styleHint =
    summaryStyle === 'bullets'
      ? 'Format requirement: terse bullet recap, max 8 bullets, no narrative prose.'
      : summaryStyle === 'actions'
        ? 'Format requirement: return only action items in action_items; leave summary, topics, key_decisions empty.'
        : summaryStyle === 'decisions'
          ? 'Format requirement: return only key decisions in key_decisions; leave summary, action_items, topics empty.'
          : '';

  const message =
    (styleHint ? `${styleHint}\n\n` : '') +
    `Meeting: ${title}\n` +
    `Attendees: ${attendees || '(not specified)'}\n` +
    `Transcript:\n${transcript || '(empty)'}\n\n` +
    `Manual notes from user:\n${manualNotes || '(empty)'}`;

  const res = await fetch (`${base}/functions/v1/ai-assistant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: anon,
    },
    body: JSON.stringify ({
      organizationId,
      task: 'meeting_summary',
      message,
    }),
  });
  const payload = await res.json ().catch (() => ({}));
  if (!res.ok) {
    const errMsg =
      typeof (payload as { error?: unknown }).error === 'string'
        ? String ((payload as { error: string }).error)
        : `Summary request failed (${res.status}).`;
    throw new Error (errMsg);
  }

  const parsed = parseMeetingSummaryFromAdvisorPayload (payload);
  if (!parsed) {
    const degraded =
      typeof (payload as { error?: unknown }).error === 'string'
        ? String ((payload as { error: string }).error)
        : '';
    const details =
      typeof (payload as { details?: unknown }).details === 'string'
        ? String ((payload as { details: string }).details)
        : '';
    throw new Error (
      degraded || details
        ? `${degraded}${details ? ` (${details})` : ''}`
        : 'Could not parse meeting summary. Try again or add more transcript text.',
    );
  }
  return parsed;
}
