import type { EmailAttachmentMeta } from '@/lib/email/types';

type Props = {
  attachments: EmailAttachmentMeta[];
  onAdd: (files: FileList | File[]) => void;
  onRemove: (id: string) => void;
  uploading?: boolean;
};

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentBar({ attachments, onAdd, onRemove, uploading }: Props) {
  return (
    <div className="eml-attachments">
      <label className="eml-attach-btn">
        <input
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) onAdd(e.target.files);
            e.target.value = '';
          }}
        />
        {uploading ? 'Uploading…' : 'Attach files'}
      </label>
      {attachments.length > 0 && (
        <ul className="eml-attach-list">
          {attachments.map((a) => (
            <li key={a.id} className="eml-attach-item">
              <span className="eml-attach-name" title={a.filename}>
                {a.filename}
              </span>
              <span className="eml-attach-size">{formatSize(a.size)}</span>
              <button type="button" className="eml-chip-x" onClick={() => onRemove(a.id)} aria-label={`Remove ${a.filename}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
