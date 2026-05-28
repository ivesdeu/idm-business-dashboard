# Supabase Edge Functions: Gmail & Google Calendar (Google) integration

> **This file is documentation, not SQL.** Do not paste this whole page into the Supabase SQL Editor — lines starting with `#` are Markdown headings and produce `ERROR: 42601: syntax error at or near "#"`. For database setup, run only the **`.sql` files** listed under [Database](#database) (open each file in the repo, copy its contents, run in the SQL editor).

This project stores Google OAuth tokens for **Gmail and Google Calendar** in `public.integration_credentials` (see migration [`20260418001000_integration_credentials.sql`](../supabase/migrations/20260418001000_integration_credentials.sql)). Only Edge Functions using the **service role** key should read or write that table.

> For Plaid (bank transaction sync), see [`docs/PLAID_INTEGRATION.md`](PLAID_INTEGRATION.md).

If you later add Microsoft (Graph, Outlook, etc.), use the `oauth-microsoft-*` functions and Azure redirect URIs documented in git history or re-add a short “Microsoft” section; this doc assumes **Google only**.

## Google Cloud: redirect URI

Register **exact** authorized redirect URIs on your **Web** OAuth 2.0 client (**APIs & services** → **Credentials**):

**Production**

```text
https://<PROJECT_REF>.supabase.co/functions/v1/oauth-google-callback
```

**Local Supabase** (optional; match `[api] port` in `supabase/config.toml`, often `54321`)

```text
http://127.0.0.1:54321/functions/v1/oauth-google-callback
```

If you set **`GOOGLE_REDIRECT_URI`** in Supabase secrets, it must match one of these entries **exactly**.

## Google Cloud: Gmail API, Calendar API, and scopes

1. **APIs & services** → **Library** → enable **Gmail API** and **Google Calendar API** (OpenID `userinfo.email` is standard).
2. **OAuth consent screen**: add the scopes your app requests. Defaults in `oauth-google-start` are:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/calendar.events` (create/update events and send attendee invites via `sendUpdates`)  
   Narrow or widen with secret **`GOOGLE_OAUTH_SCOPES`** (space-separated).  
   **After upgrading from `calendar.readonly`:** existing users must reconnect Google once in **Settings → Connections** so the new scope is granted.

**Advisor schedule-and-invite** uses edge function `google-calendar-events` (insert/patch/delete). The scheduling UI checkbox also calls this function via `src/lib/googleCalendar.ts`.

## Supabase invoke URL pattern

```text
https://<PROJECT_REF>.supabase.co/functions/v1/<function-name>
```

## Secrets (`supabase secrets set`)

**Usually auto-provided on hosted Edge:** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

**Required for Google OAuth (Gmail / Calendar)**

| Secret | Purpose |
|--------|--------|
| `OAUTH_STATE_SECRET` | Signs OAuth `state` on browser redirects (long random string). |
| `GOOGLE_CLIENT_ID` | Web client ID from Google Cloud. |
| `GOOGLE_CLIENT_SECRET` | Web client secret. |
| `APP_SITE_URL` | Dashboard origin (no trailing slash); user is redirected here after connect, e.g. `https://your-app.netlify.app`. |

**Optional**

| Secret | Purpose |
|--------|--------|
| `GOOGLE_OAUTH_SCOPES` | Overrides default Gmail + Calendar scopes (space-separated). |
| `GOOGLE_REDIRECT_URI` | Overrides derived callback URL (must match Google Console). |
| `DASHBOARD_ALLOWED_ORIGINS` | CORS for browser calls to `oauth-google-start` (see `_shared/cors.ts`). |
| `INTEGRATION_TOKEN_ENCRYPTION_KEY` | AES-256-GCM on refresh tokens before DB write (`_shared/tokenCrypto.ts`). |
| `INTEGRATION_WORKER_SECRET` | Protects `integration-worker` (cron / server callers). |

Example:

```bash
supabase secrets set \
  OAUTH_STATE_SECRET="$(openssl rand -base64 32)" \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  APP_SITE_URL="https://your-dashboard.example" \
  INTEGRATION_WORKER_SECRET="$(openssl rand -base64 32)"
```

## Deploy (Google OAuth + Gmail send)

```bash
supabase functions deploy oauth-google-start oauth-google-callback gmail-send integration-worker
```

`supabase/config.toml` sets `verify_jwt = false` on **`oauth-google-callback`** and **`integration-worker`** so the provider and cron do not send a Supabase JWT. **`oauth-google-start`** and **`gmail-send`** use JWT verification (caller must be a signed-in Supabase user).

## Dashboard flow

1. Signed-in client calls **`oauth-google-start`** with `Authorization: Bearer <supabase_access_token>` (POST JSON optional: `organization_id`, `return_path`).
2. Response JSON includes `{ "url": "..." }` — set `window.location` (or open) that URL.
3. Google redirects to **`oauth-google-callback`** with `code` and `state`.
4. Callback stores tokens and redirects to `APP_SITE_URL` + `return_path` (default `/settings/integrations`) with query `oauth=ok` or `oauth=error`.

## Send email (Emails tab)

After Google is connected for the workspace, the dashboard calls **`gmail-send`** with the same `Authorization` + `apikey` headers as other Edge invokes.

POST JSON body (rich composer):

- `organization_id` (UUID, required)
- `to`, `cc`, `bcc` — string arrays (legacy: single string `to` + `body` still works)
- `subject` (required)
- `html_body` and/or `body` / `plain_body`
- `attachments` — `[{ storage_path, filename, mime_type, content_id? }]` (files in private bucket **`email-attachments`**, path `{org_id}/{user_id}/…`)
- `thread_id`, `in_reply_to`, `references` — optional threading headers

The function loads `integration_credentials` with the **service role**, refreshes the Google access token if needed, builds multipart MIME when HTML/CC/BCC/attachments are present, and calls Gmail **`users.messages.send`**. Deploy **`gmail-send`** whenever you change its code.

Apply migration [`20260528130000_email_compose.sql`](../supabase/migrations/20260528130000_email_compose.sql) for `email_signatures`, `email_drafts`, and the **`email-attachments`** storage bucket.

## Cron / schedules

Invoke **`integration-worker`** on a schedule with header `x-integration-worker-secret: <INTEGRATION_WORKER_SECRET>` or `Authorization: Bearer <same>`. See migration [`20260418005000_cron_integration_worker.sql`](../supabase/migrations/20260418005000_cron_integration_worker.sql) for a commented `pg_cron` example.

## Database

Schema changes belong in [`supabase/migrations/`](../supabase/migrations/) and are applied with the Supabase CLI (for example `supabase db push` on a linked project). See [`docs/DEPLOYMENT_ORG_ROUTING.md`](DEPLOYMENT_ORG_ROUTING.md) for the full migration order. For integration credentials specifically, ensure [`20260418001000_integration_credentials.sql`](../supabase/migrations/20260418001000_integration_credentials.sql) has run after core org tables exist.

## Vault (optional)

See migration [`20260418007000_optional_vault_encryption_notes.sql`](../supabase/migrations/20260418007000_optional_vault_encryption_notes.sql) for Vault / pgsodium vs app-level `INTEGRATION_TOKEN_ENCRYPTION_KEY`.
