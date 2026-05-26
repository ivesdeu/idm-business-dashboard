# Security consultant scope (IDM Business Dashboard)

Use this when hiring a reviewer for **app + data security** on our Supabase-backed B2B dashboard (CRM, financials, meeting transcripts, Gmail/Calendar OAuth, Stripe Connect).

## What we already provide in-repo

| Artifact | Purpose |
|----------|---------|
| [`supabase/tests/tenant_isolation_rls_check.sql`](../supabase/tests/tenant_isolation_rls_check.sql) | Static RLS / schema audit (SQL Editor) |
| [`scripts/tenant-isolation-test.mjs`](../scripts/tenant-isolation-test.mjs) | Dynamic cross-org probes (`npm run test:tenant-isolation`) |
| [`docs/TENANT_ISOLATION_TEST_RUNBOOK.md`](TENANT_ISOLATION_TEST_RUNBOOK.md) | How to run the above |
| [`docs/RLS_AND_TENANCY.md`](RLS_AND_TENANCY.md) | Tenant table + policy matrix |
| [`docs/EDGE_FUNCTION_AUTH.md`](EDGE_FUNCTION_AUTH.md) | Edge Function auth contract |

**Ask the consultant to run our tests on staging first**, then go deeper (manual pentest, dependency audit, Supabase dashboard settings).

## In scope

1. **Multi-tenant isolation** — User in Org B must not read/write Org A data via PostgREST, Storage, or Edge Functions claiming another `organization_id`.
2. **RLS vs JWT** — Policies must use `user_is_org_member` / `user_can_write_org`, not legacy `auth.uid() = user_id` alone.
3. **Edge Functions using service role** — Every function must authenticate JWT (or signed webhook/state), re-check org membership, and scope all writes.
4. **OAuth token storage** — `integration_credentials`: encryption at rest (`INTEGRATION_TOKEN_ENCRYPTION_KEY`), no client access, rotation/revocation path.
5. **Stripe webhooks** — Signature verification; `organization_id` on metadata must match invoice row before update.
6. **Browser exposure** — CSP / security headers; CORS allow-list; no service role in frontend bundle; XSS surface in legacy `innerHTML` usage.
7. **Abuse controls** — Rate limits on token-minting endpoints (`assemblyai-token`, `ai-assistant`, etc.).
8. **Data lifecycle** — Backups, deletion path, what third parties receive (AssemblyAI, Google, Stripe, Anthropic).

## Out of scope (unless agreed)

- Full SOC 2 / HIPAA certification
- Infrastructure pentest of Supabase/Google/Stripe platforms themselves
- Social engineering / physical security

## Environment

- **Staging** Supabase project with test data only
- Two Auth users in two orgs (credentials via secure channel, not in repo)
- Read-only Git access
- Do **not** run destructive tests against production

## Required deliverable format

1. **Executive summary** (1 page) — severity counts and top fixes
2. **Methodology** — what was tested, tools, dates, scope limits
3. **Findings** — each with:
   - Severity (Critical / High / Medium / Low)
   - Affected file or component
   - Reproduction steps (curl or SQL)
   - Impact
   - Remediation (specific)
   - Effort estimate
4. **Positive findings** — what is already correct (so we do not regress)
5. **Appendix** — raw output optional

Red flags in a sample report: no repro steps, only scanner dumps, generic advice without file references.

## Interview rubric (grading answers)

### “How would you test multi-tenant isolation in Supabase?”

Good answer includes:

- Static: RLS enabled, four policies per table, `organization_id NOT NULL`, no `authenticated` policies on `integration_credentials`
- Dynamic: two users, two orgs, anon key + JWT, cross-org SELECT/INSERT/UPDATE/DELETE, FK cross-org triggers, Edge Function with spoofed `organization_id` → 403
- Storage path checks for org-prefixed buckets
- Results matrix (table × action × pass/fail)

Bad: “run a vulnerability scanner” or only “check policies exist in SQL” without JWT tests.

### “RLS vs JWT verification?”

Good answer:

- **JWT** = authentication (who is this user?)
- **RLS** = authorization (which rows can they touch?)
- Both required; JWT alone does not filter rows; RLS alone does not prove identity on Edge Functions that use service role

### “OAuth refresh-token storage reviews?”

Good answer covers: storage location, encryption mandatory in prod, key rotation, scope minimization, revocation, no tokens in logs/URLs, service_role-only table access.

### “Code review or break in?”

Want **both**: code review for systematic issues + dynamic testing on staging informed by code findings.

## Suggested engagement size

- Solo consultant: ~1–2 weeks, focused on items 1–6 above
- Re-test pass after fixes: half day

## Contact / handoff checklist

- [ ] Staging URL and anon key (not service role)
- [ ] Test user credentials (A and B)
- [ ] Confirmation migrations match `supabase/migrations/`
- [ ] Output of `tenant_isolation_rls_check.sql` (PASS notice)
- [ ] Output of `npm run test:tenant-isolation` (exit 0 or list of FAILs)
