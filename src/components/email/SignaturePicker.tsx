import { useCallback, useEffect, useState } from 'react';
import type { EmailSignatureRow } from '@/lib/email/types';
import { getOrgId, getSupabase, isDemoUser } from '@/lib/email/session';
import { EmailRichEditor } from './EmailRichEditor';

export function useSignatures() {
  const [signatures, setSignatures] = useState<EmailSignatureRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const supa = getSupabase();
    const orgId = getOrgId();
    if (!supa || !orgId || isDemoUser()) {
      setSignatures([]);
      setLoading(false);
      return;
    }
    const { data } = await supa
      .from('email_signatures')
      .select('*')
      .eq('organization_id', orgId)
      .order('is_default', { ascending: false })
      .order('updated_at', { ascending: false });
    setSignatures((data as EmailSignatureRow[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { signatures, loading, reload };
}

type PickerProps = {
  onInsert: (html: string) => void;
};

export function SignaturePicker({ onInsert }: PickerProps) {
  const { signatures, reload } = useSignatures();
  const [manageOpen, setManageOpen] = useState(false);

  const defaultSig = signatures.find((s) => s.is_default) || signatures[0];

  return (
    <div className="eml-signature-row">
      <select
        className="eml-select"
        defaultValue=""
        onChange={(e) => {
          const id = e.target.value;
          if (!id) return;
          const sig = signatures.find((s) => s.id === id);
          if (sig) onInsert(sig.html_body);
          e.target.value = '';
        }}
      >
        <option value="">Insert signature</option>
        {signatures.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.is_default ? ' (default)' : ''}
          </option>
        ))}
      </select>
      {defaultSig && (
        <button type="button" className="eml-link-btn" onClick={() => onInsert(defaultSig.html_body)}>
          Use default
        </button>
      )}
      <button type="button" className="eml-link-btn" onClick={() => setManageOpen(true)}>
        Manage
      </button>
      {manageOpen && <SignatureManager onClose={() => { setManageOpen(false); void reload(); }} />}
    </div>
  );
}

function SignatureManager({ onClose }: { onClose: () => void }) {
  const { signatures, reload } = useSignatures();
  const [editing, setEditing] = useState<Partial<EmailSignatureRow> | null>(null);
  const [html, setHtml] = useState('');

  const save = async () => {
    const supa = getSupabase();
    const orgId = getOrgId();
    if (!supa || !orgId || !editing?.name?.trim()) return;
    const { data: userData } = await supa.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return;

    if (editing.is_default) {
      await supa
        .from('email_signatures')
        .update({ is_default: false })
        .eq('organization_id', orgId)
        .eq('user_id', userId);
    }

    const payload = {
      organization_id: orgId,
      user_id: userId,
      name: editing.name.trim(),
      html_body: html,
      is_default: Boolean(editing.is_default),
      updated_at: new Date().toISOString(),
    };

    if (editing.id) {
      await supa.from('email_signatures').update(payload).eq('id', editing.id);
    } else {
      await supa.from('email_signatures').insert(payload);
    }
    setEditing(null);
    setHtml('');
    await reload();
  };

  const remove = async (id: string) => {
    const supa = getSupabase();
    if (!supa || !window.confirm('Delete this signature?')) return;
    await supa.from('email_signatures').delete().eq('id', id);
    await reload();
  };

  return (
    <div className="eml-submodal" role="dialog" aria-modal="true">
      <div className="eml-submodal-panel">
        <div className="eml-submodal-head">
          <h3>Signatures</h3>
          <button type="button" className="eml-chip-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {!editing ? (
          <>
            <ul className="eml-sig-list">
              {signatures.map((s) => (
                <li key={s.id}>
                  <span>{s.name}{s.is_default ? ' · default' : ''}</span>
                  <div>
                    <button type="button" className="eml-link-btn" onClick={() => { setEditing(s); setHtml(s.html_body); }}>Edit</button>
                    <button type="button" className="eml-link-btn eml-danger" onClick={() => void remove(s.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" className="eml-btn-secondary" onClick={() => { setEditing({ name: 'New signature', is_default: false }); setHtml(''); }}>
              + New signature
            </button>
          </>
        ) : (
          <div className="eml-sig-edit">
            <input
              className="eml-input"
              value={editing.name || ''}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Signature name"
            />
            <label className="eml-check">
              <input
                type="checkbox"
                checked={Boolean(editing.is_default)}
                onChange={(e) => setEditing({ ...editing, is_default: e.target.checked })}
              />
              Default signature
            </label>
            <EmailRichEditor html={html} onChange={setHtml} placeholder="Signature content…" />
            <div className="eml-submodal-actions">
              <button type="button" className="eml-btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="eml-btn-primary" onClick={() => void save()}>Save</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
