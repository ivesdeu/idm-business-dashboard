import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ComposePrefill } from '@/lib/email/types';
import { checkGmailConnected } from '@/lib/email/gmailSend';
import { getOrgId, isDemoUser, parseRecipients, recipientsToString } from '@/lib/email/session';
import { RecipientField, RecipientToggleRow } from './RecipientField';
import { EmailRichEditor } from './EmailRichEditor';
import { AttachmentBar } from './AttachmentBar';
import { SignaturePicker } from './SignaturePicker';
import { TemplatePicker, saveCurrentAsTemplate } from './TemplatePicker';
import { useEmailDraft } from './useEmailDraft';
import { buildSendPayload, useGmailSend } from './useGmailSend';
import { uploadEmailAttachment, uploadInlineImage } from './uploadAttachment';
import { htmlToPlain } from './emailUtils';

export type ComposeOpenOptions = ComposePrefill & { draft_id?: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: ComposeOpenOptions | null;
  onSent?: () => void;
};

export function EmailComposeDialog({ open, onOpenChange, prefill, onSent }: Props) {
  const orgId = getOrgId();
  const draftIdFromPrefill = prefill?.draft_id ?? null;
  const { state, updateState, draftRowId, saving, deleteDraft } = useEmailDraft(draftIdFromPrefill, open);
  const { sending, undoSeconds, scheduleSend, cancelUndo, flushSend } = useGmailSend(onSent);

  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [error, setError] = useState('');
  const [gmailOk, setGmailOk] = useState<boolean | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [contactSuggestions, setContactSuggestions] = useState<{ email: string; label: string }[]>([]);

  const composeDraftKey = draftRowId || 'new';

  useEffect(() => {
    if (!open || !orgId) return;
    void checkGmailConnected(orgId).then(setGmailOk);
  }, [open, orgId]);

  useEffect(() => {
    if (!open) return;
    const supa = window.supabaseClient;
    if (!supa || !orgId) return;
    void supa
      .from('clients')
      .select('email, company_name, contact_name')
      .eq('organization_id', orgId)
      .not('email', 'is', null)
      .limit(200)
      .then(({ data }) => {
        const list = (data || [])
          .map((c: { email?: string; company_name?: string; contact_name?: string }) => {
            const email = String(c.email || '').trim();
            if (!email.includes('@')) return null;
            return { email, label: String(c.company_name || c.contact_name || email) };
          })
          .filter(Boolean) as { email: string; label: string }[];
        setContactSuggestions(list);
      });
  }, [open, orgId]);

  useEffect(() => {
    if (!open || !prefill) return;
    const p = prefill;
    updateState({
      to: p.to ? (Array.isArray(p.to) ? p.to : parseRecipients(p.to)) : [],
      cc: p.cc ? (Array.isArray(p.cc) ? p.cc : parseRecipients(p.cc)) : [],
      bcc: p.bcc ? (Array.isArray(p.bcc) ? p.bcc : parseRecipients(p.bcc)) : [],
      subject: p.subject ?? '',
      html_body: p.html_body ?? (p.body ? String(p.body).replace(/\n/g, '<br>') : ''),
      reply_to_thread_id: p.thread_id,
      in_reply_to: p.in_reply_to,
      references: p.references,
    });
    if (p.cc) setShowCc(true);
    if (p.bcc) setShowBcc(true);
    setDirty(false);
  }, [open, prefill, updateState]);

  const markDirty = useCallback(() => setDirty(true), []);

  const handleClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onOpenChange(false);
    setError('');
    setDirty(false);
  }, [dirty, onOpenChange]);

  const appendHtml = useCallback(
    (html: string) => {
      updateState((prev) => ({
        ...prev,
        html_body: prev.html_body ? `${prev.html_body}<br><br>${html}` : html,
      }));
      markDirty();
    },
    [updateState, markDirty],
  );

  const handleAttachments = useCallback(
    async (files: FileList | File[]) => {
      setUploading(true);
      for (const file of Array.from(files)) {
        const meta = await uploadEmailAttachment(file, composeDraftKey);
        if (meta) {
          updateState((prev) => ({
            ...prev,
            attachment_meta: [...prev.attachment_meta, meta],
          }));
          markDirty();
        }
      }
      setUploading(false);
    },
    [composeDraftKey, updateState, markDirty],
  );

  const handleInlineImage = useCallback(
    async (file: File) => {
      const result = await uploadInlineImage(file, composeDraftKey);
      if (!result) return null;
      updateState((prev) => ({
        ...prev,
        attachment_meta: [...prev.attachment_meta, result.meta],
      }));
      markDirty();
      return `cid:${result.cid}`;
    },
    [composeDraftKey, updateState, markDirty],
  );

  const validate = (): string | null => {
    if (!orgId) return 'Open a workspace first.';
    if (isDemoUser()) return 'Demo mode cannot send email.';
    if (!state.to.length) return 'Add at least one recipient in To.';
    if (!state.subject.trim()) return 'Subject is required.';
    if (!state.html_body.trim()) return 'Message is required.';
    if (gmailOk === false) return 'Connect Gmail in Settings → Connections.';
    return null;
  };

  const doSend = async (skipUndo = false) => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    if (!orgId) return;
    setError('');

    const payload = buildSendPayload(orgId, {
      to: state.to,
      cc: state.cc,
      bcc: state.bcc,
      subject: state.subject,
      html_body: state.html_body,
      attachment_meta: state.attachment_meta,
      reply_to_thread_id: state.reply_to_thread_id,
      in_reply_to: state.in_reply_to,
      references: state.references,
    });

    const meta = {
      to: recipientsToString(state.to),
      subject: state.subject,
      body: htmlToPlain(state.html_body),
      html: state.html_body,
    };

    try {
      if (skipUndo) {
        await scheduleSend(payload, meta);
        await flushSend();
      } else {
        scheduleSend(payload, meta);
      }
      await deleteDraft();
      setDirty(false);
      onOpenChange(false);
      const bar = document.getElementById('app-invite-flash');
      if (bar && !skipUndo) {
        bar.textContent = `Sending in 10s… Open Outbox after send.`;
        bar.style.display = 'block';
        window.setTimeout(() => {
          bar.style.display = 'none';
          bar.textContent = '';
        }, 12000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed');
    }
  };

  const subjectId = useMemo(() => 'eml-compose-subject-input', []);

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? onOpenChange(true) : handleClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="eml-dialog-overlay" />
        <Dialog.Content className="eml-dialog-content" aria-describedby={undefined}>
          <Dialog.Title className="eml-dialog-title">Compose email</Dialog.Title>
          <p className="eml-compose-hint">
            Sends from your connected Gmail for this workspace. Connect Google under <strong>Settings → Connections</strong> if you have not yet.
          </p>
          {gmailOk === false && (
            <p className="eml-compose-err" role="alert">
              Gmail is not connected. Open Settings → Connections and connect Google.
            </p>
          )}
          {error && (
            <p className="eml-compose-err" role="alert">
              {error}
            </p>
          )}
          {undoSeconds != null && undoSeconds > 0 && (
            <p className="eml-undo-bar" role="status">
              Sending in {undoSeconds}s…{' '}
              <button type="button" className="eml-link-btn" onClick={cancelUndo}>
                Undo
              </button>
            </p>
          )}
          {saving && <p className="eml-draft-status">Draft saved</p>}

          <TemplatePicker
            onApply={(t) => {
              updateState({ to: t.to, subject: t.subject, html_body: t.html_body });
              markDirty();
            }}
            current={{ to: state.to, subject: state.subject, html_body: state.html_body }}
          />

          <RecipientField
            label="To"
            value={state.to}
            onChange={(to) => {
              updateState({ to });
              markDirty();
            }}
            placeholder="name@example.com"
            suggestions={contactSuggestions}
          />
          <RecipientToggleRow
            showCc={showCc}
            showBcc={showBcc}
            onToggleCc={() => setShowCc(true)}
            onToggleBcc={() => setShowBcc(true)}
          />
          {showCc && (
            <RecipientField
              label="Cc"
              value={state.cc}
              onChange={(cc) => {
                updateState({ cc });
                markDirty();
              }}
              suggestions={contactSuggestions}
            />
          )}
          {showBcc && (
            <RecipientField
              label="Bcc"
              value={state.bcc}
              onChange={(bcc) => {
                updateState({ bcc });
                markDirty();
              }}
              suggestions={contactSuggestions}
            />
          )}

          <div className="eml-field">
            <label className="eml-label" htmlFor={subjectId}>
              Subject
            </label>
            <input
              id={subjectId}
              className="eml-input"
              value={state.subject}
              onChange={(e) => {
                updateState({ subject: e.target.value });
                markDirty();
              }}
              placeholder="Subject"
            />
          </div>

          <SignaturePicker
            onInsert={(html) => {
              appendHtml(html);
            }}
          />

          <div className="eml-field">
            <label className="eml-label">Message</label>
            <EmailRichEditor
              html={state.html_body}
              onChange={(html_body) => {
                updateState({ html_body, plain_body: htmlToPlain(html_body) });
                markDirty();
              }}
              onImageUpload={handleInlineImage}
            />
          </div>

          <AttachmentBar
            attachments={state.attachment_meta}
            onAdd={handleAttachments}
            onRemove={(id) => {
              updateState((prev) => ({
                ...prev,
                attachment_meta: prev.attachment_meta.filter((a) => a.id !== id),
              }));
              markDirty();
            }}
            uploading={uploading}
          />

          <div className="eml-dialog-actions">
            <button type="button" className="eml-btn-secondary" onClick={handleClose}>
              Cancel
            </button>
            <button
              type="button"
              className="eml-btn-secondary"
              onClick={() => void saveCurrentAsTemplate({ to: state.to, subject: state.subject, html_body: state.html_body })}
            >
              Save as template
            </button>
            <button type="button" className="eml-btn-primary" disabled={sending || gmailOk === false} onClick={() => void doSend()}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
