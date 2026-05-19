# RLS and tenancy matrix (Compass)

**Source of truth for production:** after you apply the multitenancy migration [`20260301107000_organizations_multitenancy.sql`](../supabase/migrations/20260301107000_organizations_multitenancy.sql) (via [`supabase/migrations/`](../supabase/migrations/) and `supabase db push`), tenant data uses **organization-scoped** policies, not legacy `auth.uid() = user_id` alone.

## Policy primitives

| Helper | Meaning |
|--------|---------|
| `user_is_org_member(organization_id)` | User is in `organization_members` for that org (any role). Used for **SELECT**. |
| `user_can_write_org(organization_id)` | User has role **owner**, **admin**, or **member** (not **viewer**). Used for **INSERT/UPDATE/DELETE**. |

## Tenant tables (`org_row_*` policies)

These tables require **`organization_id NOT NULL`** and use the same four policies named `org_row_select`, `org_row_insert`, `org_row_update`, `org_row_delete`:

| Table | SELECT | Write |
|-------|--------|-------|
| `clients` | member | writer |
| `transactions` | member | writer |
| `projects` | member | writer |
| `invoices` | member | writer |
| `campaigns` | member | writer |
| `timesheet_entries` | member | writer |
| `app_settings` | member | writer (PK is `organization_id`) |
| `crm_events` | member | writer |
| `weekly_summaries` | member | writer |
| `pipelines` | member | writer |
| `pipeline_stages` | member | writer |
| `workspace_tasks` | member | writer |
| `crm_activities` | member | writer |
| `workflow_rules` | member | writer |
| `workflow_runs` | member | writer |
| `workflow_outbox` | member | writer |
| `ai_usage_events` | member | writer |
| `ai_feedback` | member | writer |
| `ai_action_outcomes` | member | writer |

**Workspace lists** use dedicated policies on `workspace_lists` (see migration [`20260506154000_workspace_lists.sql`](../supabase/migrations/20260506154000_workspace_lists.sql)): `workspace_lists_select` (member), insert/update/delete (writer). Payload is stored in `payload` jsonb; `list_id` is the client-generated list uuid.

**Viewer behavior:** viewers pass `user_is_org_member` but **fail** `user_can_write_org`, so they can read org data but not mutate it.

## Organization directory

| Table | Policies |
|-------|----------|
| `organizations` | `organizations_select_member`, `organizations_update_admin` (admin/owner update) |
| `organization_members` | `organization_members_select`, `organization_members_insert_admin` |

See [`20260301112000_organization_members_manage.sql`](../supabase/migrations/20260301112000_organization_members_manage.sql) for additional invite/member policies.

## Special cases (no org_row pattern)

| Surface | Notes |
|---------|--------|
| `integration_credentials` | **RLS enabled, no policies** for `authenticated` — only **service_role** (Edge Functions) can read/write. Clients never query this table directly. |
| `storage.objects` (`brand-assets`) | Org-scoped paths per [`20260301111000_brand_assets_org_rls.sql`](../supabase/migrations/20260301111000_brand_assets_org_rls.sql). |
| Legacy SQL files (`dashboard_sync`, `workflow_automation`, etc.) | Define older `*_own` policies; **multitenancy migration section 10 drops those** and recreates `org_row_*`. Deploy order matters (see [`docs/DEPLOYMENT_ORG_ROUTING.md`](DEPLOYMENT_ORG_ROUTING.md)). |

## Migration order (reminder)

Use the full ordered list in [`docs/DEPLOYMENT_ORG_ROUTING.md`](DEPLOYMENT_ORG_ROUTING.md). In short:

1. Core bootstrap / `dashboard_sync` style migrations
2. [`20260301107000_organizations_multitenancy.sql`](../supabase/migrations/20260301107000_organizations_multitenancy.sql)
3. [`20260301112000_organization_members_manage.sql`](../supabase/migrations/20260301112000_organization_members_manage.sql) (invites)
4. [`20260301110000_workflow_automation.sql`](../supabase/migrations/20260301110000_workflow_automation.sql) if using pipelines (needed before `cross_org_row_integrity` for `clients.pipeline_id`)
5. [`20260418001000_integration_credentials.sql`](../supabase/migrations/20260418001000_integration_credentials.sql)
6. [`20260418002000_cross_org_row_integrity.sql`](../supabase/migrations/20260418002000_cross_org_row_integrity.sql) (cross-org reference triggers)

## Row-level integrity (FK + org)

Foreign keys tie child rows to `clients` / `campaigns` / `projects` by **id** only. [`20260418002000_cross_org_row_integrity.sql`](../supabase/migrations/20260418002000_cross_org_row_integrity.sql) adds **triggers** so `client_id` / `campaign_id` / `project_id` cannot reference rows belonging to another organization.

## When adding a new table

1. Add `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`.  
2. `ENABLE ROW LEVEL SECURITY`.  
3. Create `org_row_*` policies using `user_is_org_member` / `user_can_write_org`.  
4. Grant `SELECT/INSERT/UPDATE/DELETE` to `authenticated` as needed.  
5. Update this document.
