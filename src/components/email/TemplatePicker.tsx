import { useEffect, useState } from 'react';
import type { EmailTemplate } from '@/lib/email/types';
import { fetchEmailTemplates, saveEmailTemplate } from '@/lib/email/templates';
import { parseRecipients, recipientsToString } from '@/lib/email/session';

type Props = {
  onApply: (t: { to: string[]; subject: string; html_body: string }) => void;
  current: { to: string[]; subject: string; html_body: string };
};

export function TemplatePicker({ onApply, current }: Props) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);

  useEffect(() => {
    void fetchEmailTemplates().then(setTemplates);
  }, []);

  return (
    <div className="eml-field">
      <label className="eml-label" htmlFor="eml-template-select">
        Template
      </label>
      <select
        id="eml-template-select"
        className="eml-select"
        defaultValue=""
        onChange={(e) => {
          const t = templates.find((x) => x.id === e.target.value);
          if (!t) return;
          onApply({
            to: t.to ? parseRecipients(t.to) : [],
            subject: t.subject || '',
            html_body: t.body ? t.body.replace(/\n/g, '<br>') : '',
          });
          e.target.value = '';
        }}
      >
        <option value="">— Load template —</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name || t.subject || 'Template'}
          </option>
        ))}
      </select>
    </div>
  );
}

export async function saveCurrentAsTemplate(current: {
  to: string[];
  subject: string;
  html_body: string;
}): Promise<boolean> {
  const subject = current.subject.trim();
  const body = current.html_body.trim();
  if (!subject && !body) {
    alert('Add a subject or message before saving as a template.');
    return false;
  }
  const name = window.prompt('Template name', subject.slice(0, 80) || 'Template');
  if (name == null || !name.trim()) return false;
  const entry = await saveEmailTemplate({
    name: name.trim(),
    subject,
    body,
    to: recipientsToString(current.to),
  });
  return Boolean(entry);
}
