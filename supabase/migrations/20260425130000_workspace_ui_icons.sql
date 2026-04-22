-- Per-workspace UI icons (sidebar nav, lists, list columns). Colors come from branding — only icon + style stored.
CREATE TABLE IF NOT EXISTS public.workspace_ui_icons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('sidebar_nav', 'list', 'list_column')),
  entity_id text NOT NULL,
  icon text,
  icon_style text NOT NULL DEFAULT 'filled' CHECK (icon_style IN ('filled', 'outlined')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_ui_icons_org_entity_uniq UNIQUE (organization_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS workspace_ui_icons_org_idx ON public.workspace_ui_icons (organization_id);

ALTER TABLE public.workspace_ui_icons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workspace_ui_icons_select" ON public.workspace_ui_icons;
DROP POLICY IF EXISTS "workspace_ui_icons_insert" ON public.workspace_ui_icons;
DROP POLICY IF EXISTS "workspace_ui_icons_update" ON public.workspace_ui_icons;
DROP POLICY IF EXISTS "workspace_ui_icons_delete" ON public.workspace_ui_icons;

CREATE POLICY "workspace_ui_icons_select" ON public.workspace_ui_icons FOR SELECT TO authenticated
  USING (public.user_is_org_member(organization_id));

CREATE POLICY "workspace_ui_icons_insert" ON public.workspace_ui_icons FOR INSERT TO authenticated
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "workspace_ui_icons_update" ON public.workspace_ui_icons FOR UPDATE TO authenticated
  USING (public.user_can_write_org(organization_id))
  WITH CHECK (public.user_can_write_org(organization_id));

CREATE POLICY "workspace_ui_icons_delete" ON public.workspace_ui_icons FOR DELETE TO authenticated
  USING (public.user_can_write_org(organization_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.workspace_ui_icons TO authenticated;
