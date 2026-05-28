-- Shared invite links per organization.
-- A single rotating token per org that anyone (signed in) can use to join when enabled.
-- Token sits in its own table (not on organizations) so plain org SELECTs don't leak it.

CREATE TABLE IF NOT EXISTS public.organization_shared_invites (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  token text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_shared_invites_token_key
  ON public.organization_shared_invites (token);

ALTER TABLE public.organization_shared_invites ENABLE ROW LEVEL SECURITY;

-- Sensitive: only admins/owners can read the token. Members can't even know it exists.
DROP POLICY IF EXISTS "shared_invites_select_admin" ON public.organization_shared_invites;
CREATE POLICY "shared_invites_select_admin"
  ON public.organization_shared_invites
  FOR SELECT
  TO authenticated
  USING (public.user_can_admin_org(organization_id));

-- All writes happen via the edge function under service_role; no INSERT/UPDATE/DELETE policy for authenticated.

GRANT SELECT ON public.organization_shared_invites TO authenticated;
GRANT ALL ON public.organization_shared_invites TO service_role;

COMMENT ON TABLE public.organization_shared_invites IS
  'Per-organization shared invite link. Token is rotatable; enabled gates acceptance. Reads admin-only.';
