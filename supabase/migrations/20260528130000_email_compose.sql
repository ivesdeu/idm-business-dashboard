-- Email compose: signatures, drafts, attachment storage bucket

-- -----------------------------------------------------------------------------
-- email_signatures
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Default',
  html_body text NOT NULL DEFAULT '',
  is_default boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_signatures_org_user_idx
  ON public.email_signatures (organization_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS email_signatures_one_default_per_user_org
  ON public.email_signatures (organization_id, user_id)
  WHERE is_default = true;

ALTER TABLE public.email_signatures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_signatures_select_own"
  ON public.email_signatures FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.user_is_org_member(organization_id));

CREATE POLICY "email_signatures_insert_own"
  ON public.email_signatures FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.user_can_write_org(organization_id));

CREATE POLICY "email_signatures_update_own"
  ON public.email_signatures FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.user_can_write_org(organization_id))
  WITH CHECK (user_id = auth.uid() AND public.user_can_write_org(organization_id));

CREATE POLICY "email_signatures_delete_own"
  ON public.email_signatures FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.user_can_write_org(organization_id));

-- -----------------------------------------------------------------------------
-- email_drafts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.email_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_addrs text[] NOT NULL DEFAULT '{}',
  cc_addrs text[] NOT NULL DEFAULT '{}',
  bcc_addrs text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL DEFAULT '',
  html_body text NOT NULL DEFAULT '',
  plain_body text NOT NULL DEFAULT '',
  attachment_meta jsonb NOT NULL DEFAULT '[]'::jsonb,
  reply_to_message_id text,
  reply_to_thread_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_drafts_org_user_updated_idx
  ON public.email_drafts (organization_id, user_id, updated_at DESC);

ALTER TABLE public.email_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_drafts_select_own"
  ON public.email_drafts FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.user_is_org_member(organization_id));

CREATE POLICY "email_drafts_insert_own"
  ON public.email_drafts FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.user_can_write_org(organization_id));

CREATE POLICY "email_drafts_update_own"
  ON public.email_drafts FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.user_can_write_org(organization_id))
  WITH CHECK (user_id = auth.uid() AND public.user_can_write_org(organization_id));

CREATE POLICY "email_drafts_delete_own"
  ON public.email_drafts FOR DELETE TO authenticated
  USING (user_id = auth.uid() AND public.user_can_write_org(organization_id));

-- -----------------------------------------------------------------------------
-- Storage bucket: email-attachments (private)
-- Path: {org_id}/{user_id}/{draft_or_send_id}/{filename}
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'email-attachments',
  'email-attachments',
  false,
  10485760,
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- org_id / user_id as first two path segments
CREATE POLICY "email_attachments_select_own"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND public.user_is_org_member(((storage.foldername(name))[1])::uuid)
    AND (storage.foldername(name))[2] = (auth.uid())::text
  );

CREATE POLICY "email_attachments_insert_own"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
    AND (storage.foldername(name))[2] = (auth.uid())::text
  );

CREATE POLICY "email_attachments_update_own"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
    AND (storage.foldername(name))[2] = (auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
    AND (storage.foldername(name))[2] = (auth.uid())::text
  );

CREATE POLICY "email_attachments_delete_own"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'email-attachments'
    AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND public.user_can_write_org(((storage.foldername(name))[1])::uuid)
    AND (storage.foldername(name))[2] = (auth.uid())::text
  );
