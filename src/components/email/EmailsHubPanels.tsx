import { useCallback, useEffect, useState } from 'react';
import type { EmailDraftRow, EmailTemplate } from '@/lib/email/types';
import { deleteEmailDraftById, listEmailDrafts } from './useEmailDraft';
import { deleteEmailTemplate, fetchEmailTemplates, saveEmailTemplate } from '@/lib/email/templates';
import { loadOutbox } from '@/lib/email/outbox';
import { formatDraftWhen, htmlToPlain } from './emailUtils';

type Props = {
  activeTab: 'drafts' | 'outbox' | 'templates';
  onCompose: (opts?: { draft_id?: string; to?: string; subject?: string; html_body?: string }) => void;
  refreshToken?: number;
};

export function EmailsHubPanels({ activeTab, onCompose, refreshToken = 0 }: Props) {
  const [drafts, setDrafts] = useState<EmailDraftRow[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [outbox, setOutbox] = useState(loadOutbox());

  const reload = useCallback(async () => {
    setDrafts(await listEmailDrafts());
    setTemplates(await fetchEmailTemplates());
    setOutbox(loadOutbox());
    const root = document.getElementById('page-emails');
    if (root) {
      const dc = root.querySelector('[data-eml-count="drafts"]');
      const tc = root.querySelector('[data-eml-count="templates"]');
      const oc = root.querySelector('[data-eml-count="outbox"]');
      if (dc) dc.textContent = String((await listEmailDrafts()).length);
      if (tc) tc.textContent = String((await fetchEmailTemplates()).length);
      if (oc) oc.textContent = String(loadOutbox().length);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  if (activeTab === 'drafts') {
    /* Empty state is rendered by static HTML in index.html so the React component
       does not duplicate it when the panel has no drafts. */
    if (!drafts.length) return null;
    return (
      <div className="eml-list">
        {drafts.map((d) => (
          <article key={d.id} className="eml-list-card">
            <div className="eml-list-card-head">
              <div>
                <div className="eml-list-card-title">{d.subject.trim() || '(No subject)'}</div>
                <div className="eml-list-card-meta">To: {(d.to_addrs || []).join(', ') || '—'}</div>
              </div>
              <div className="eml-list-card-when">{formatDraftWhen(d.updated_at)}</div>
            </div>
            {d.html_body && (
              <p className="eml-list-card-preview">{htmlToPlain(d.html_body).slice(0, 160)}</p>
            )}
            <div className="eml-list-card-actions">
              <button type="button" className="eml-link-btn" onClick={() => onCompose({ draft_id: d.id })}>
                Edit
              </button>
              <button
                type="button"
                className="eml-link-btn eml-danger"
                onClick={() => void deleteEmailDraftById(d.id).then(reload)}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
    );
  }

  if (activeTab === 'templates') {
    if (!templates.length) return null;
    return (
      <div className="eml-list">
        {templates.map((t) => (
          <article key={t.id} className="eml-list-card">
            <div className="eml-list-card-head">
              <div>
                <div className="eml-list-card-title">{t.name}</div>
                <div className="eml-list-card-meta">{t.subject || '(No subject)'}</div>
              </div>
            </div>
            <div className="eml-list-card-actions">
              <button
                type="button"
                className="eml-link-btn"
                onClick={() =>
                  onCompose({
                    to: t.to,
                    subject: t.subject,
                    html_body: t.body ? t.body.replace(/\n/g, '<br>') : '',
                  })
                }
              >
                Use
              </button>
              <button
                type="button"
                className="eml-link-btn"
                onClick={() => {
                  const name = window.prompt('Template name', t.name);
                  if (name == null) return;
                  void saveEmailTemplate({ ...t, name: name.trim() || t.name }).then(reload);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                className="eml-link-btn eml-danger"
                onClick={() => void deleteEmailTemplate(t.id).then(reload)}
              >
                Delete
              </button>
            </div>
          </article>
        ))}
      </div>
    );
  }

  if (activeTab === 'outbox') {
    if (!outbox.length) return null;
    return (
      <div className="eml-list">
        {outbox.map((m) => (
          <article key={m.id} className="eml-list-card">
            <div className="eml-list-card-head">
              <div>
                <div className="eml-list-card-title">{m.subject}</div>
                <div className="eml-list-card-meta">To: {m.to}</div>
              </div>
              <div className="eml-list-card-when">{formatDraftWhen(m.sentAt)}</div>
            </div>
            <p className="eml-list-card-preview">{m.body.slice(0, 200)}</p>
            {m.gmailUrl && (
              <a href={m.gmailUrl} target="_blank" rel="noopener noreferrer" className="eml-link-btn">
                Open in Gmail
              </a>
            )}
          </article>
        ))}
      </div>
    );
  }

  return null;
}
