-- Tenant isolation: static RLS / schema audit.
-- Run in Supabase SQL Editor as postgres after all migrations.
-- Does NOT substitute for dynamic JWT tests (see scripts/tenant-isolation-test.mjs).

DO $$
DECLARE
  tbl text;
  missing_rls text[] := '{}';
  missing_policies text[] := '{}';
  missing_notnull text[] := '{}';
  bad_policy_expr text[] := '{}';
  ic_auth_policies int;
  undef_secdef text[] := '{}';
  known_public_secdef text[] := ARRAY[
    'organization_public_by_slug',
    'my_organizations',
    'user_is_org_member',
    'user_can_write_org',
    'user_can_admin_org'
  ];
  org_row_tables text[] := ARRAY[
    'clients', 'transactions', 'projects', 'invoices', 'campaigns',
    'timesheet_entries', 'crm_events', 'weekly_summaries',
    'pipelines', 'pipeline_stages', 'workspace_tasks', 'crm_activities',
    'workflow_rules', 'workflow_runs', 'workflow_outbox',
    'ai_usage_events', 'ai_feedback', 'ai_action_outcomes',
    'meeting_notes'
  ];
  org_row_policy_names text[] := ARRAY['org_row_select', 'org_row_insert', 'org_row_update', 'org_row_delete'];
  workspace_list_policies text[] := ARRAY[
    'workspace_lists_select', 'workspace_lists_insert',
    'workspace_lists_update', 'workspace_lists_delete'
  ];
  r record;
  pol_count int;
  pol_name text;
BEGIN
  -- -------------------------------------------------------------------------
  -- 1. RLS enabled (+ forced where table exists)
  -- -------------------------------------------------------------------------
  FOREACH tbl IN ARRAY org_row_tables || ARRAY['workspace_lists', 'integration_credentials', 'app_settings']
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = tbl
        AND c.relrowsecurity = true
    ) THEN
      missing_rls := array_append(missing_rls, tbl || ' (RLS off)');
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 2. org_row_* policies on standard tenant tables
  -- -------------------------------------------------------------------------
  FOREACH tbl IN ARRAY org_row_tables
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    FOREACH pol_name IN ARRAY org_row_policy_names
    LOOP
      SELECT count(*) INTO pol_count
      FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = tbl AND p.policyname = pol_name;
      IF pol_count < 1 THEN
        missing_policies := array_append(missing_policies, tbl || '.' || pol_name);
      END IF;
    END LOOP;
  END LOOP;

  -- workspace_lists dedicated policies
  IF to_regclass('public.workspace_lists') IS NOT NULL THEN
    FOREACH pol_name IN ARRAY workspace_list_policies
    LOOP
      SELECT count(*) INTO pol_count
      FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = 'workspace_lists' AND p.policyname = pol_name;
      IF pol_count < 1 THEN
        missing_policies := array_append(missing_policies, 'workspace_lists.' || pol_name);
      END IF;
    END LOOP;
  END IF;

  -- -------------------------------------------------------------------------
  -- 3. organization_id NOT NULL on tenant tables (skip if column missing)
  -- -------------------------------------------------------------------------
  FOREACH tbl IN ARRAY org_row_tables || ARRAY['workspace_lists']
  LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      CONTINUE;
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl
        AND column_name = 'organization_id' AND is_nullable = 'YES'
    ) THEN
      missing_notnull := array_append(missing_notnull, tbl);
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 4. org_row policies must use membership helpers, not bare auth.uid()
  -- -------------------------------------------------------------------------
  FOR r IN
    SELECT p.tablename, p.policyname, p.qual, p.with_check
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.policyname LIKE 'org_row_%'
  LOOP
    IF (
      (r.qual IS NOT NULL AND r.qual LIKE '%auth.uid()%' AND r.qual NOT LIKE '%user_is_org_member%' AND r.qual NOT LIKE '%user_can_write_org%')
      OR (r.with_check IS NOT NULL AND r.with_check LIKE '%auth.uid()%' AND r.with_check NOT LIKE '%user_is_org_member%' AND r.with_check NOT LIKE '%user_can_write_org%')
    ) THEN
      bad_policy_expr := array_append(bad_policy_expr, r.tablename || '.' || r.policyname);
    END IF;
  END LOOP;

  -- -------------------------------------------------------------------------
  -- 5. integration_credentials: no authenticated policies
  -- -------------------------------------------------------------------------
  IF to_regclass('public.integration_credentials') IS NOT NULL THEN
    SELECT count(*) INTO ic_auth_policies
    FROM pg_policies p
    WHERE p.schemaname = 'public' AND p.tablename = 'integration_credentials'
      AND 'authenticated' = ANY (p.roles);
    IF ic_auth_policies > 0 THEN
      RAISE EXCEPTION 'tenant_isolation_rls_check: integration_credentials has % authenticated policy(ies); expect 0',
        ic_auth_policies;
    END IF;
  END IF;

  -- -------------------------------------------------------------------------
  -- 6. SECURITY DEFINER functions in public (informational warnings)
  -- -------------------------------------------------------------------------
  FOR r IN
    SELECT p.proname AS fname
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef = true
      AND p.proname <> ALL (known_public_secdef)
  LOOP
    undef_secdef := array_append(undef_secdef, r.fname);
  END LOOP;

  -- -------------------------------------------------------------------------
  -- Fail on hard checks
  -- -------------------------------------------------------------------------
  IF array_length(missing_rls, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_isolation_rls_check: RLS not enabled: %', array_to_string(missing_rls, ', ');
  END IF;

  IF array_length(missing_policies, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_isolation_rls_check: missing policies: %', array_to_string(missing_policies, ', ');
  END IF;

  IF array_length(missing_notnull, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_isolation_rls_check: organization_id nullable on: %', array_to_string(missing_notnull, ', ');
  END IF;

  IF array_length(bad_policy_expr, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'tenant_isolation_rls_check: org_row policies use auth.uid() without org helpers: %',
      array_to_string(bad_policy_expr, ', ');
  END IF;

  RAISE NOTICE 'tenant_isolation_rls_check: PASS — RLS, policies, NOT NULL org_id, integration_credentials lockdown.';

  IF array_length(undef_secdef, 1) IS NOT NULL THEN
    RAISE WARNING 'tenant_isolation_rls_check: review SECURITY DEFINER functions: %',
      array_to_string(undef_secdef, ', ');
  END IF;
END $$;
