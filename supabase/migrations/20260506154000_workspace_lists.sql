-- Workspace lists persisted per organization.
CREATE TABLE IF NOT EXISTS public.workspace_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  list_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  data_type text,
  layout text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_lists_org_list_uniq UNIQUE (organization_id, list_id)
);

CREATE INDEX IF NOT EXISTS workspace_lists_org_idx ON public.workspace_lists (organization_id);
CREATE INDEX IF NOT EXISTS workspace_lists_org_updated_idx ON public.workspace_lists (organization_id, updated_at DESC);

ALTER TABLE public.workspace_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_lists_select" ON public.workspace_lists;
DROP POLICY IF EXISTS "workspace_lists_insert" ON public.workspace_lists;
DROP POLICY IF EXISTS "workspace_lists_update" ON public.workspace_lists;
DROP POLICY IF EXISTS "workspace_lists_delete" ON public.workspace_lists;

CREATE POLICY "workspace_lists_select" ON public.workspace_lists FOR SELECT TO authenticated
  USING (public.user_is_org_member(organization_id));

CREATE POLICY "workspace_lists_insert" ON public.workspace_lists FOR INSERT TO authenticated
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "workspace_lists_update" ON public.workspace_lists FOR UPDATE TO authenticated
  USING (public.user_can_write_org(organization_id))
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "workspace_lists_delete" ON public.workspace_lists FOR DELETE TO authenticated
  USING (public.user_can_write_org(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_lists TO authenticated;
