import type { ComposePrefill } from './types';

/** Build composer prefill for reply / reply-all (Phase 2 — wire from thread UI when inbox sync exists). */
export function buildReplyPrefill(opts: {
  to: string | string[];
  cc?: string[];
  subject: string;
  quotedHtml: string;
  threadId?: string;
  messageId?: string;
  replyAll?: boolean;
}): ComposePrefill {
  const subj = /^re:/i.test(opts.subject.trim()) ? opts.subject.trim() : `Re: ${opts.subject.trim()}`;
  return {
    to: opts.to,
    cc: opts.replyAll ? opts.cc : undefined,
    subject: subj,
    html_body: `<p><br></p><blockquote style="margin:0 0 0 8px;border-left:2px solid #ccc;padding-left:8px">${opts.quotedHtml}</blockquote>`,
    thread_id: opts.threadId,
    in_reply_to: opts.messageId,
    references: opts.messageId,
  };
}
