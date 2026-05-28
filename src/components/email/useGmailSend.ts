import { useCallback, useRef, useState } from 'react';
import type { SendEmailPayload } from '@/lib/email/types';
import { appendOutbox } from '@/lib/email/outbox';
import { sendViaGmail } from '@/lib/email/gmailSend';
import { htmlToPlain } from './emailUtils';

const UNDO_MS = 10_000;

export function useGmailSend(onSent?: () => void) {
  const [sending, setSending] = useState(false);
  const [undoSeconds, setUndoSeconds] = useState<number | null>(null);
  const pendingRef = useRef<{ payload: SendEmailPayload; meta: { to: string; subject: string; body: string; html: string } } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearUndo = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (intervalRef.current) clearInterval(intervalRef.current);
    timerRef.current = null;
    intervalRef.current = null;
    pendingRef.current = null;
    setUndoSeconds(null);
  }, []);

  const flushSend = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    clearUndo();
    setSending(true);
    const result = await sendViaGmail(pending.payload);
    setSending(false);
    if (!result.ok) {
      throw new Error(result.notConnected ? 'Connect Gmail in Settings → Connections.' : result.detail || 'Send failed');
    }
    const tid = result.threadId;
    const gurl = tid
      ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(tid)}`
      : 'https://mail.google.com/mail/u/0/#sent';
    appendOutbox({
      id: `msg_${Date.now().toString(36)}`,
      to: pending.meta.to,
      subject: pending.meta.subject,
      body: pending.meta.body,
      html_body: pending.meta.html,
      sentAt: new Date().toISOString(),
      threadId: tid,
      gmailUrl: gurl,
      has_attachments: (pending.payload.attachments?.length ?? 0) > 0,
    });
    const bar = document.getElementById('app-invite-flash');
    if (bar) {
      bar.innerHTML = `Message sent. <a href="${gurl}" target="_blank" rel="noopener noreferrer" style="color:inherit;font-weight:600;text-decoration:underline;">Open in Gmail</a>`;
      bar.style.display = 'block';
      window.setTimeout(() => {
        bar.style.display = 'none';
        bar.textContent = '';
      }, 14000);
    }
    onSent?.();
    return { gmailUrl: gurl };
  }, [clearUndo, onSent]);

  const scheduleSend = useCallback(
    (payload: SendEmailPayload, meta: { to: string; subject: string; body: string; html: string }) => {
      clearUndo();
      pendingRef.current = { payload, meta };
      let remaining = UNDO_MS / 1000;
      setUndoSeconds(remaining);
      intervalRef.current = setInterval(() => {
        remaining -= 1;
        setUndoSeconds(remaining > 0 ? remaining : null);
      }, 1000);
      timerRef.current = setTimeout(() => {
        void flushSend();
      }, UNDO_MS);
    },
    [clearUndo, flushSend],
  );

  const cancelUndo = useCallback(() => {
    clearUndo();
  }, [clearUndo]);

  const sendNow = useCallback(
    async (payload: SendEmailPayload, meta: { to: string; subject: string; body: string; html: string }) => {
      clearUndo();
      pendingRef.current = { payload, meta };
      return flushSend();
    },
    [clearUndo, flushSend],
  );

  return {
    sending,
    undoSeconds,
    scheduleSend,
    sendNow,
    cancelUndo,
    flushSend,
  };
}

export function buildSendPayload(
  orgId: string,
  state: {
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    html_body: string;
    attachment_meta: { storage_path: string; filename: string; mime_type: string; content_id?: string }[];
    reply_to_thread_id?: string;
    in_reply_to?: string;
    references?: string;
  },
): SendEmailPayload {
  return {
    organization_id: orgId,
    to: state.to,
    cc: state.cc.length ? state.cc : undefined,
    bcc: state.bcc.length ? state.bcc : undefined,
    subject: state.subject.trim(),
    html_body: state.html_body,
    plain_body: htmlToPlain(state.html_body),
    attachments: state.attachment_meta.map((a) => ({
      storage_path: a.storage_path,
      filename: a.filename,
      mime_type: a.mime_type,
      content_id: a.content_id,
    })),
    thread_id: state.reply_to_thread_id,
    in_reply_to: state.in_reply_to,
    references: state.references,
  };
}
