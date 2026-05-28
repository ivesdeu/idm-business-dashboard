export type EmailAttachmentMeta = {
  id: string;
  filename: string;
  mime_type: string;
  storage_path: string;
  size: number;
  content_id?: string;
};

export type EmailDraftRow = {
  id: string;
  organization_id: string;
  user_id: string;
  to_addrs: string[];
  cc_addrs: string[];
  bcc_addrs: string[];
  subject: string;
  html_body: string;
  plain_body: string;
  attachment_meta: EmailAttachmentMeta[];
  reply_to_message_id: string | null;
  reply_to_thread_id: string | null;
  updated_at: string;
};

export type EmailSignatureRow = {
  id: string;
  organization_id: string;
  user_id: string;
  name: string;
  html_body: string;
  is_default: boolean;
  updated_at: string;
};

export type EmailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  to?: string;
  updated_at?: string;
};

export type ComposePrefill = {
  to?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject?: string;
  body?: string;
  html_body?: string;
  draft_id?: string;
  thread_id?: string;
  in_reply_to?: string;
  references?: string;
};

export type OutboxEntry = {
  id: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html_body?: string;
  sentAt: string;
  threadId?: string;
  gmailUrl?: string;
  has_attachments?: boolean;
};

export type SendEmailPayload = {
  organization_id: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html_body: string;
  plain_body?: string;
  attachments?: { storage_path: string; filename: string; mime_type: string; content_id?: string }[];
  thread_id?: string;
  in_reply_to?: string;
  references?: string;
};
