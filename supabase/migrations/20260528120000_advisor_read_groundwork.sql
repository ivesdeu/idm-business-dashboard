-- Advisor Tier 1 read tools: org roster RPC + appointment client name helper.

CREATE OR REPLACE FUNCTION public.org_members_roster(p_org uuid)
RETURNS TABLE (
  user_id uuid,
  display_name text,
  email text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'org_members_roster: p_org is required';
  END IF;
  IF NOT public.user_is_org_member(p_org) THEN
    RAISE EXCEPTION 'org_members_roster: not a member of this organization';
  END IF;

  RETURN QUERY
  SELECT
    om.user_id,
    COALESCE(
      NULLIF(TRIM(u.raw_user_meta_data->>'full_name'), ''),
      NULLIF(
        TRIM(
          CONCAT(
            COALESCE(u.raw_user_meta_data->>'first_name', ''),
            ' ',
            COALESCE(u.raw_user_meta_data->>'last_name', '')
          )
        ),
        ''
      ),
      NULLIF(SPLIT_PART(u.email, '@', 1), ''),
      'Member'
    )::text AS display_name,
    COALESCE(u.email, '')::text AS email
  FROM public.organization_members om
  JOIN auth.users u ON u.id = om.user_id
  WHERE om.organization_id = p_org;
END;
$$;

COMMENT ON FUNCTION public.org_members_roster(uuid) IS
  'Returns org members with display names for advisor action-item owner resolution.';

GRANT EXECUTE ON FUNCTION public.org_members_roster(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.appointment_with_client_name(p_appointment_id uuid)
RETURNS TABLE (
  appointment_id uuid,
  title text,
  start_time timestamptz,
  end_time timestamptz,
  client_id uuid,
  client_name text,
  notes text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id AS appointment_id,
    a.title,
    a.start_time,
    a.end_time,
    a.client_id,
    COALESCE(NULLIF(TRIM(c.company_name), ''), NULLIF(TRIM(c.contact_name), ''), 'Unknown client') AS client_name,
    a.notes
  FROM public.appointments a
  LEFT JOIN public.clients c ON c.id = a.client_id
  WHERE a.id = p_appointment_id
    AND public.user_is_org_member(a.organization_id);
$$;

COMMENT ON FUNCTION public.appointment_with_client_name(uuid) IS
  'Single appointment row with resolved client display name; gated by org membership.';

GRANT EXECUTE ON FUNCTION public.appointment_with_client_name(uuid) TO authenticated;
