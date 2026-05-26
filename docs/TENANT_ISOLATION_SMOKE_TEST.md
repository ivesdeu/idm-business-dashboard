# Tenant isolation smoke test

Quick path to verify org-scoped data isolation. For full steps, see **[TENANT_ISOLATION_TEST_RUNBOOK.md](TENANT_ISOLATION_TEST_RUNBOOK.md)**.

## Automated (recommended)

1. **SQL (postgres):** run [`supabase/tests/tenant_isolation_rls_check.sql`](../supabase/tests/tenant_isolation_rls_check.sql) in Supabase SQL Editor.
2. **Dynamic (JWT):** configure `TENANT_TEST_*` in `.env`, then:

```bash
npm run test:tenant-isolation
```

## Manual spot-check

1. Create **User A** and **User B** in two different organizations.
2. As A, insert a `clients` row in OrgA.
3. As B (JWT + anon key), `select` clients where `organization_id = OrgA` → expect **0 rows**.
4. As B, attempt update/delete on A’s client id → expect **failure / 0 rows**.
5. Call `gmail-send` with A’s JWT and B’s `organization_id` → expect **403**.

## Edge API

See [EDGE_FUNCTION_AUTH.md](EDGE_FUNCTION_AUTH.md) for the full function audit table.

## Related

- [TENANT_ISOLATION_TEST_RUNBOOK.md](TENANT_ISOLATION_TEST_RUNBOOK.md)
- [SECURITY_CONSULTANT_SCOPE.md](SECURITY_CONSULTANT_SCOPE.md)
- [RLS_AND_TENANCY.md](RLS_AND_TENANCY.md)
