import type { EmailAttachmentMeta } from '@/lib/email/types';
import { getOrgId, getSupabase } from '@/lib/email/session';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function uploadEmailAttachment(
  file: File,
  draftId: string,
): Promise<EmailAttachmentMeta | null> {
  const supa = getSupabase();
  const orgId = getOrgId();
  if (!supa || !orgId) return null;
  if (file.size > MAX_FILE_BYTES) {
    alert(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB): ${file.name}`);
    return null;
  }

  const { data: userData } = await supa.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) return null;

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const id = `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `${orgId}/${userId}/${draftId}/${id}_${safeName}`;

  const { error } = await supa.storage.from('email-attachments').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) {
    console.error('upload attachment', error);
    return null;
  }

  return {
    id,
    filename: file.name,
    mime_type: file.type || 'application/octet-stream',
    storage_path: path,
    size: file.size,
  };
}

/** Inline image: returns cid for MIME and stores with content_id */
export async function uploadInlineImage(file: File, draftId: string): Promise<{ cid: string; meta: EmailAttachmentMeta } | null> {
  const cid = `img_${Date.now().toString(36)}@bizdash`;
  const meta = await uploadEmailAttachment(file, draftId);
  if (!meta) return null;
  return { cid, meta: { ...meta, content_id: cid } };
}
