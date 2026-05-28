import { useCallback, useEffect, useRef, useState } from 'react';
import type { EmailAttachmentMeta, EmailDraftRow } from '@/lib/email/types';
import { getOrgId, getSupabase, isDemoUser } from '@/lib/email/session';

export type DraftFormState = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html_body: string;
  plain_body: string;
  attachment_meta: EmailAttachmentMeta[];
  reply_to_message_id?: string;
  reply_to_thread_id?: string;
  in_reply_to?: string;
  references?: string;
};

const emptyDraft = (): DraftFormState => ({
  to: [],
  cc: [],
  bcc: [],
  subject: '',
  html_body: '',
  plain_body: '',
  attachment_meta: [],
});

export function useEmailDraft(draftId: string | null, enabled: boolean) {
  const [draftRowId, setDraftRowId] = useState<string | null>(draftId);
  const [state, setState] = useState<DraftFormState>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadDraft = useCallback(async (id: string) => {
    const supa = getSupabase();
    const orgId = getOrgId();
    if (!supa || !orgId) return;
    const { data, error } = await supa
      .from('email_drafts')
      .select('*')
      .eq('id', id)
      .eq('organization_id', orgId)
      .maybeSingle();
    if (error || !data) return;
    const row = data as EmailDraftRow;
    setState({
      to: row.to_addrs || [],
      cc: row.cc_addrs || [],
      bcc: row.bcc_addrs || [],
      subject: row.subject || '',
      html_body: row.html_body || '',
      plain_body: row.plain_body || '',
      attachment_meta: Array.isArray(row.attachment_meta) ? row.attachment_meta : [],
      reply_to_message_id: row.reply_to_message_id || undefined,
      reply_to_thread_id: row.reply_to_thread_id || undefined,
      in_reply_to: row.reply_to_message_id || undefined,
    });
    setDraftRowId(row.id);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (draftId) void loadDraft(draftId);
    else {
      setState(emptyDraft());
      setDraftRowId(null);
      setLoaded(true);
    }
  }, [draftId, loadDraft]);

  const persist = useCallback(
    async (next: DraftFormState) => {
      if (!enabled || isDemoUser()) return;
      const supa = getSupabase();
      const orgId = getOrgId();
      if (!supa || !orgId) return;

      const hasContent =
        next.subject.trim() ||
        next.html_body.trim() ||
        next.to.length ||
        next.cc.length ||
        next.bcc.length;
      if (!hasContent) return;

      setSaving(true);
      const { data: userData } = await supa.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) {
        setSaving(false);
        return;
      }

      const payload = {
        organization_id: orgId,
        user_id: userId,
        to_addrs: next.to,
        cc_addrs: next.cc,
        bcc_addrs: next.bcc,
        subject: next.subject,
        html_body: next.html_body,
        plain_body: next.plain_body,
        attachment_meta: next.attachment_meta,
        reply_to_message_id: next.reply_to_message_id || null,
        reply_to_thread_id: next.reply_to_thread_id || null,
        updated_at: new Date().toISOString(),
      };

      if (draftRowId) {
        await supa.from('email_drafts').update(payload).eq('id', draftRowId);
      } else {
        const { data } = await supa.from('email_drafts').insert(payload).select('id').single();
        if (data?.id) setDraftRowId(String(data.id));
      }
      setSaving(false);
    },
    [draftRowId, enabled],
  );

  const updateState = useCallback(
    (patch: Partial<DraftFormState> | ((prev: DraftFormState) => DraftFormState)) => {
      setState((prev) => {
        const next = typeof patch === 'function' ? patch(prev) : { ...prev, ...patch };
        if (enabled && loaded) {
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => void persist(next), 1200);
        }
        return next;
      });
    },
    [enabled, loaded, persist],
  );

  const deleteDraft = useCallback(async () => {
    if (!draftRowId) return;
    const supa = getSupabase();
    if (!supa) return;
    await supa.from('email_drafts').delete().eq('id', draftRowId);
    setDraftRowId(null);
  }, [draftRowId]);

  return { state, updateState, draftRowId, saving, loaded, deleteDraft, setState };
}

export async function listEmailDrafts(): Promise<EmailDraftRow[]> {
  const supa = getSupabase();
  const orgId = getOrgId();
  if (!supa || !orgId || isDemoUser()) return [];
  const { data, error } = await supa
    .from('email_drafts')
    .select('*')
    .eq('organization_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error || !data) return [];
  return data as EmailDraftRow[];
}

export async function deleteEmailDraftById(id: string): Promise<void> {
  const supa = getSupabase();
  if (!supa) return;
  await supa.from('email_drafts').delete().eq('id', id);
}
