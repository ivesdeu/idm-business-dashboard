import type { SendEmailPayload } from './types';
import { getAccessToken, getAnonKey, getEdgeBase } from './session';

export type SendResult =
  | { ok: true; id: string; threadId: string }
  | { ok: false; error: string; detail?: string; notConnected?: boolean };

export async function sendViaGmail(payload: SendEmailPayload): Promise<SendResult> {
  const token = await getAccessToken();
  const base = getEdgeBase();
  const anon = getAnonKey();
  if (!token || !base || !anon) {
    return { ok: false, error: 'session', detail: 'Sign in first.' };
  }

  const res = await fetch(`${base}/functions/v1/gmail-send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon,
    },
    body: JSON.stringify(payload),
  });

  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty */
  }

  if (!res.ok || j.error) {
    const err = j.error != null ? String(j.error) : 'send_failed';
    const det = j.detail != null ? String(j.detail) : '';
    if (err === 'not_connected') {
      return { ok: false, error: err, detail: det, notConnected: true };
    }
    return { ok: false, error: err, detail: det || 'Could not send email.' };
  }

  return {
    ok: true,
    id: j.id != null ? String(j.id) : '',
    threadId: j.threadId != null ? String(j.threadId) : '',
  };
}

export async function checkGmailConnected(orgId: string): Promise<boolean> {
  const token = await getAccessToken();
  const base = getEdgeBase();
  const anon = getAnonKey();
  if (!token || !base || !anon) return false;

  const res = await fetch(`${base}/functions/v1/integration-connection-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: anon,
    },
    body: JSON.stringify({ organizationId: orgId }),
  });
  if (!res.ok) return false;
  const j = (await res.json()) as { gmail?: boolean };
  return Boolean(j.gmail);
}
