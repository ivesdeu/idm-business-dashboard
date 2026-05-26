# Tenant isolation test runbook

Repeatable checks that workspace data stays scoped to the correct organization. Use before a security review and after RLS or Edge Function auth changes.

## Prerequisites

1. **Migrations applied** on the target project (staging recommended), especially:
   - [`20260301107000_organizations_multitenancy.sql`](../supabase/migrations/20260301107000_organizations_multitenancy.sql)
   - [`20260418002000_cross_org_row_integrity.sql`](../supabase/migrations/20260418002000_cross_org_row_integrity.sql)
   - [`20260506154000_workspace_lists.sql`](../supabase/migrations/20260506154000_workspace_lists.sql)
   - [`20260507120000_create_meeting_notes.sql`](../supabase/migrations/20260507120000_create_meeting_notes.sql)

2. **Two test users** in Supabase Auth:
   - User A — owner of Organization A (sign up through the app or Auth dashboard).
   - User B — owner of Organization B (must be a **different** org).

3. **`.env`** at repo root (copy from [`.env.example`](../.env.example)):

```env
VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key

TENANT_TEST_USER_A_EMAIL=alice@your-test-domain.com
TENANT_TEST_USER_A_PASSWORD=...
TENANT_TEST_USER_B_EMAIL=bob@your-test-domain.com
TENANT_TEST_USER_B_PASSWORD=...
```

Optional: `TENANT_TEST_ORG_A_ID` / `TENANT_TEST_ORG_B_ID` if users belong to multiple orgs.

**Never** put `SUPABASE_SERVICE_ROLE_KEY` in `.env` for these tests.

## Step 1 — Static SQL audit

In Supabase **SQL Editor** (role: `postgres`), run the full file:

[`supabase/tests/tenant_isolation_rls_check.sql`](../supabase/tests/tenant_isolation_rls_check.sql)

**Pass:** `NOTICE: tenant_isolation_rls_check: PASS …`  
**Fail:** `EXCEPTION` with a list of missing RLS, policies, or nullable `organization_id`.

This does not use JWTs; it only verifies schema and policy presence.

## Step 2 — Dynamic JWT probes

From the repo root:

```bash
npm run test:tenant-isolation
```

The script uses **anon key + each user's JWT** (same as a browser attacker). It:

| Probe | Expected |
|-------|----------|
| Sign in A and B | PASS |
| A seeds rows in OrgA (`clients`, `transactions`, `workspace_lists`, `meeting_notes`) | PASS |
| B SELECT/INSERT/UPDATE/DELETE against OrgA rows | blocked (0 rows or error) |
| B inserts `meeting_notes` with OrgB + OrgA `contact_id` | trigger/RLS error |
| B SELECT `integration_credentials` | empty |
| A JWT + OrgB id → `POST …/gmail-send` | HTTP 403 |
| `dist/` bundle grep for `service_role` | no hits (SKIP if no build) |

**Exit code 0** = all non-skipped probes passed. **Exit code 1** = at least one FAIL.

### Optional manual check (viewer role)

Invite User B into OrgA with role **viewer**. As B, confirm SELECT works and UPDATE on a client fails. The script marks this as SKIP by default.

## Step 3 — Give a consultant

Share:

- This runbook
- [`SECURITY_CONSULTANT_SCOPE.md`](SECURITY_CONSULTANT_SCOPE.md)
- [`RLS_AND_TENANCY.md`](RLS_AND_TENANCY.md)
- [`EDGE_FUNCTION_AUTH.md`](EDGE_FUNCTION_AUTH.md)
- Read-only repo access + a **staging** Supabase project (not production)
- Output of Step 1 and Step 2 from staging

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| `auth.signIn` fails | Wrong email/password or user not confirmed |
| `auth.distinctOrgs` fails | Both users share one org — create a second workspace for B |
| `*.seed` fails | Missing table/migration or RLS blocks writer insert |
| `edge.gmailSendOrgSpoof` SKIP | `gmail-send` not deployed or network blocked |
| `bundle.noServiceRole` SKIP | Run `npm run build` first |

## Related

- [TENANT_ISOLATION_SMOKE_TEST.md](TENANT_ISOLATION_SMOKE_TEST.md) — short checklist
- [RLS_AND_TENANCY.md](RLS_AND_TENANCY.md) — policy matrix
