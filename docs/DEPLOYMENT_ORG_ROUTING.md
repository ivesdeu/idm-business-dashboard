# Org slug URLs and static hosting

The dashboard expects URLs like `https://your-host/your-org-slug/` so the first path segment resolves to a workspace. Deep links must load `index.html` and let the client read the path.

## Netlify

`npm run build` runs **Vite** ([`vite.config.mjs`](../vite.config.mjs)): transpiles to [`.browserslistrc`](../.browserslistrc) targets, bundles **`@supabase/supabase-js`** and **`chart.js`** at the **exact versions** pinned in [`package.json`](../package.json) (no floating majors), and writes `dist/` (including hashed `/assets/*.js` from [`src/entries/bootstrap.js`](../src/entries/bootstrap.js)). Files under [`public/`](../public/) (for example `_redirects`, `_headers`, `fonts/`) are copied into `dist/`.

`public/_redirects` is copied into the site root. It contains:

```text
/*    /index.html   200
```

Netlify serves real files (e.g. `/assets/...`) when they exist, then falls back to `index.html` for unknown paths. [`netlify.toml`](../netlify.toml) adds long-lived `Cache-Control` for `/fonts/*`; put **more specific redirects or rewrites before** the catch-all `/* → /index.html` if you later add same-origin APIs or Functions so those paths are not swallowed by the SPA rule.

[`public/_headers`](../public/_headers) is copied next to `_redirects` in `dist/` and sets baseline security headers plus **`Content-Security-Policy-Report-Only`** (same policy shape as a future enforcing CSP). Watch the browser console or a report collector for violations, tighten `connect-src` / `script-src` as needed, then duplicate the policy as **`Content-Security-Policy`** when noise is low. Meeting Notes realtime transcription requires `wss://streaming.assemblyai.com` (and `https://streaming.assemblyai.com`) in `connect-src`; `microphone=(self)` in Permissions-Policy for `getUserMedia`. The app relies on **`'unsafe-inline'`** for large inline scripts/styles in `index.html`; removing that requires nonces or extracting bundles.

## Vercel

Add a `vercel.json` rewrite if you deploy there instead of Netlify, for example:

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Refine this if you need to exclude API routes or static assets (often unnecessary when assets live under paths that exist as files).

## Supabase Auth redirect URLs

- OAuth uses `redirectTo = origin + pathname + search` so query strings such as `?invite=…` survive the round trip (GitHub and other providers).
- Returning to `https://app.example.com/acme/` (with or without a trailing path) is normal.
- In the Supabase dashboard, add your production and preview **Site URL** and **Redirect URLs** for each origin you use (e.g. `http://localhost:5173`, `https://your-domain.com`). Wildcards for arbitrary slugs are often unnecessary if the callback stays on the same origin; confirm against [Supabase redirect URL docs](https://supabase.com/docs/guides/auth/redirect-urls).
- Keep **Site URL** and allowed redirect entries **boring and exact** (no unnecessary environment-specific variants) so Safari / iOS **ITP** and partitioned storage are less likely to surprise you after refresh or OAuth return.

### Safari, iOS, and in-app browsers (manual smoke)

Run these on **Safari (macOS)**, **iOS Safari**, and at least one **embedded WebView** or in-app browser you care about (e.g. Slack, LinkedIn), using the same origins you configured in Supabase:

1. **Email + password**: sign in, hard refresh, confirm session still works and org slug routes load (`/{slug}/`).
2. **OAuth provider** (if enabled): complete sign-in and return to the dashboard; confirm query strings such as `?invite=…` still apply when relevant.
3. **Password reset**: request a link, open it on the device, set a new password, confirm redirect back to your app origin.
4. **Private / cross-site context**: repeat a minimal sign-in after clearing site data; watch the console for CSP report-only noise from [`public/_headers`](../public/_headers).

If sessions vanish only in WebKit or embedded browsers, review Supabase client **storage** options and third-party cookie behavior before changing redirect URLs ad hoc.

## Database schema (single path)

**Production schema is defined only in** [`supabase/migrations/`](../supabase/migrations/) **as ordered, timestamped SQL.** Apply with the Supabase CLI against a linked project (for example `supabase db push`), or your hosted migration pipeline. Do **not** treat ad-hoc SQL editor runs as the source of truth.

Top-level files under [`supabase/`](../supabase/) named like `organizations_multitenancy.sql` are **stubs** that point at the matching migration file; they exist for discoverability and backward-compatible links.

**Existing databases** that were built by pasting the old loose `.sql` files (or only had a subset of migrations recorded) need a one-time alignment before `db push`: either mark equivalent migrations as already applied (`supabase migration repair`) after verifying the live schema matches, or generate a fresh baseline from the remote (`supabase db pull` / team process). Otherwise new migration files may try to recreate objects that already exist.

### Migration order (lexicographic = apply order)

1. [`20260301100000_bootstrap_core.sql`](../supabase/migrations/20260301100000_bootstrap_core.sql)
2. [`20260301101000_dashboard_sync.sql`](../supabase/migrations/20260301101000_dashboard_sync.sql)
3. [`20260301102000_fix_advisor_missing_tables.sql`](../supabase/migrations/20260301102000_fix_advisor_missing_tables.sql)
4. [`20260301103000_add_timesheet_entries_table.sql`](../supabase/migrations/20260301103000_add_timesheet_entries_table.sql)
5. [`20260301104000_add_clients_metadata.sql`](../supabase/migrations/20260301104000_add_clients_metadata.sql)
6. [`20260301105000_add_clients_industry_column.sql`](../supabase/migrations/20260301105000_add_clients_industry_column.sql)
7. [`20260301106000_add_invoice_stripe_fields.sql`](../supabase/migrations/20260301106000_add_invoice_stripe_fields.sql)
8. [`20260301107000_organizations_multitenancy.sql`](../supabase/migrations/20260301107000_organizations_multitenancy.sql) — core tenancy, RLS helpers, `organization_id` on tenant tables.
9. [`20260301107100_organization_stripe_connect.sql`](../supabase/migrations/20260301107100_organization_stripe_connect.sql) — Stripe Connect table (requires multitenancy helpers).
10. [`20260301108000_personable_crm_enhancements.sql`](../supabase/migrations/20260301108000_personable_crm_enhancements.sql) (optional CRM logos / timeline extras).
11. [`20260301109000_project_case_study.sql`](../supabase/migrations/20260301109000_project_case_study.sql)
12. [`20260301110000_workflow_automation.sql`](../supabase/migrations/20260301110000_workflow_automation.sql) — before cross-org integrity if you use pipelines.
13. [`20260301111000_brand_assets_org_rls.sql`](../supabase/migrations/20260301111000_brand_assets_org_rls.sql) — private `brand-assets` bucket paths, org-scoped storage.
14. [`20260301112000_organization_members_manage.sql`](../supabase/migrations/20260301112000_organization_members_manage.sql) — team invites, member policies.
15. [`20260301113000_workspace_onboarding_and_create.sql`](../supabase/migrations/20260301113000_workspace_onboarding_and_create.sql) — default org on signup, `create_workspace_for_user`, etc.
16. [`20260417120000_onboarding_wizard_and_org_rpcs.sql`](../supabase/migrations/20260417120000_onboarding_wizard_and_org_rpcs.sql) — onboarding JSON + RPC shape.
17. [`20260417140000_fix_new_user_onboarding_flag.sql`](../supabase/migrations/20260417140000_fix_new_user_onboarding_flag.sql) — trigger fix for `onboarding_completed`.
18. [`20260418000000_org_rpcs_onboarding_select.sql`](../supabase/migrations/20260418000000_org_rpcs_onboarding_select.sql) — `my_organizations` / `organization_public_by_slug` shape.
19. [`20260418001000_integration_credentials.sql`](../supabase/migrations/20260418001000_integration_credentials.sql) — integration token table (service role only).
20. [`20260418002000_cross_org_row_integrity.sql`](../supabase/migrations/20260418002000_cross_org_row_integrity.sql) — cross-org reference triggers.
21. [`20260418003000_add_app_settings_dashboard_settings.sql`](../supabase/migrations/20260418003000_add_app_settings_dashboard_settings.sql)
22. [`20260418004000_ai_advisor_telemetry.sql`](../supabase/migrations/20260418004000_ai_advisor_telemetry.sql)
23. [`20260418005000_cron_integration_worker.sql`](../supabase/migrations/20260418005000_cron_integration_worker.sql) — commented `pg_cron` example for `integration-worker`.
24. [`20260418006000_delete_workspace_organization.sql`](../supabase/migrations/20260418006000_delete_workspace_organization.sql)
25. [`20260418007000_optional_vault_encryption_notes.sql`](../supabase/migrations/20260418007000_optional_vault_encryption_notes.sql) — optional Vault / encryption notes (no-op `SELECT 1`).

If a trigger fails on `EXECUTE PROCEDURE`, try `EXECUTE FUNCTION` for your Postgres version.

## Fail-safe / tenancy documentation

- **[`docs/RLS_AND_TENANCY.md`](RLS_AND_TENANCY.md)** — RLS matrix and migration order.  
- **[`docs/EDGE_FUNCTION_AUTH.md`](EDGE_FUNCTION_AUTH.md)** — service-role Edge Function audit.  
- **[`docs/WORKFLOW_EXECUTION_CONTRACT.md`](WORKFLOW_EXECUTION_CONTRACT.md)** — workflows, idempotency, visibility.  
- **[`docs/OPS_SECRETS_AND_OBSERVABILITY.md`](OPS_SECRETS_AND_OBSERVABILITY.md)** — secrets and logging.  
- **[`docs/TENANT_ISOLATION_SMOKE_TEST.md`](TENANT_ISOLATION_SMOKE_TEST.md)** — manual isolation checks.  
- **Tests:** [`supabase/tests/tenant_isolation_rls_check.sql`](../supabase/tests/tenant_isolation_rls_check.sql)

## First-time users and onboarding

1. **Default org**: After the multitenancy and workspace onboarding migrations (see list above), each new `auth.users` row gets an organization via `handle_new_user_org` with `onboarding_completed = false` until the user completes the in-app **Name your workspace** step (company name, URL slug, optional branding).
2. **Existing orgs**: The migration adds `onboarding_completed` with default `true` so current customers are not prompted again.
3. **Invites**: Invite links use `?invite=TOKEN`. The client copies the token to `sessionStorage` if the user is not signed in yet, and GitHub OAuth preserves the query string on return. After sign-in, `accept-org-invite` runs, then the browser is sent to `/{slug}/`.
4. **Multiple workspaces**: Signed-in users can open **Workspaces** in the sidebar, switch orgs, or create another org (RPC `create_workspace_for_user`).

### `APP_BASE_URL`

Used when creating invite links (`organization-team` `invite` action), Stripe Checkout success/cancel URLs (`create-stripe-checkout-session`), and Stripe Connect Account Link return/refresh URLs (`stripe-connect-start`). Should match your deployed site origin (no trailing slash). Defaults to `http://localhost:5173` if unset.

**Compass production:** set Edge secret `APP_BASE_URL` to:

`https://compass-login.ivesdeu.com`

### Team roles (UI vs database)

The UI labels **`member`** as **Employee**. Database roles remain `owner`, `admin`, `member`, `viewer`. Only **Owner** can assign the **Owner** role; **Admins** manage Admin / Employee / Viewer for others.

### Invitations

**Create invite link** stores a row in `organization_invitations` and returns a URL like `{APP_BASE_URL}/?invite=TOKEN`. The invitee should use the **same email** as the invite. If they open the link before signing in, the token is stored in `sessionStorage` and a short hint appears on the login screen; after password or GitHub sign-in, [`src/legacy/supabase-auth.js`](../src/legacy/supabase-auth.js) calls `accept-org-invite`, then redirects to `/{slug}/`. If acceptance fails (wrong email, expired invite), the session stays signed in when possible and a banner message explains the error. There is no separate email provider in-repo; copy the link into your own email or add Resend/etc. later.

## Edge Function secrets

### `DASHBOARD_ALLOWED_ORIGINS`

Browser calls to Edge Functions (`ai-assistant`, `create-stripe-checkout-session`, `organization-team`, `accept-org-invite`, `stripe-connect-start`, `stripe-connect-disconnect`, `gmail-send`, and other CORS-enabled endpoints) use CORS allowlists. Set this secret to a comma-separated list of exact origins, for example:

`https://compass-login.ivesdeu.com`

Add other origins (Netlify previews, staging) separated by commas as needed. Local dev defaults include `http://localhost:5173` and `http://127.0.0.1:5173`. Without a production origin in the list, browsers will block cross-origin requests from your deployed dashboard.

### Workspace integrations (Gmail / Google OAuth)

**Gmail** uses Edge Functions `oauth-google-start` and `oauth-google-callback`, not Supabase Auth’s Google sign-in. Register redirect URI `https://<ref>.supabase.co/functions/v1/oauth-google-callback` in **Google Cloud** (plus local callback URL if you test against `supabase start`). Secrets include `OAUTH_STATE_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `APP_SITE_URL`. Optional: `INTEGRATION_WORKER_SECRET` for scheduled `integration-worker`. Full checklist: [`docs/SUPABASE_EDGE_INTEGRATIONS.md`](SUPABASE_EDGE_INTEGRATIONS.md).

### Stripe webhooks and `organization_id`

The `stripe-webhook` function **requires** `metadata.organization_id` on `checkout.session.completed` and `checkout.session.expired`, and checks that it matches the invoice row. Checkout sessions created by the current `create-stripe-checkout-session` function include this metadata. **Legacy** Checkout sessions that lack `organization_id` will no longer update invoices until customers complete payment using a new session (or you fix metadata in Stripe manually).

## Redeploy Edge Functions

After changing function code or secrets, deploy from the repo root, for example:

`supabase functions deploy ai-assistant create-stripe-checkout-session stripe-webhook stripe-connect-start stripe-connect-disconnect organization-team accept-org-invite oauth-google-start oauth-google-callback integration-worker --project-ref <your-project-ref>`  
(If you use Microsoft integrations, add `oauth-microsoft-start oauth-microsoft-callback`. Add `gmail-send` if you use workspace Gmail send.)
