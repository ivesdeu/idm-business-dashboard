# Plaid integration (Bank transactions)

This project integrates Plaid to import **income and expense transactions** into the existing ledger table `public.transactions`.

The dashboard UI for Plaid lives under **Settings → Connections → Plaid**.

## What gets created

- **Edge Functions** (Supabase):
  - `plaid-link-token` — creates a Plaid Link token (owner/admin only).
  - `plaid-exchange` — exchanges `public_token` for `access_token`, stores the Plaid item (encrypted), fetches accounts, and does an initial transaction backfill.
  - `plaid-sync` — incremental transaction sync using `/transactions/sync` cursor.
  - `plaid-webhook` — Plaid webhook receiver (signature-verified) that dispatches `plaid-sync`.
  - `plaid-disconnect` — removes all Plaid items for an org (owner/admin only).

- **Database tables**:
  - `public.plaid_items` — encrypted access tokens + sync cursor (service-role only).
  - `public.plaid_accounts` — account display metadata (org members can read).

See migration: [`20260526195500_plaid_integration.sql`](../supabase/migrations/20260526195500_plaid_integration.sql).

## Ledger behavior (hybrid review)

New Plaid imports are inserted into `public.transactions` with:

- `source = 'Plaid'`
- `metadata.review_status = 'unreviewed'`
- `metadata.plaid_transaction_id` for dedupe

The Revenue and Expenses pages include an **Unreviewed** toggle, and each Unreviewed row includes **Approve** / **Hide** actions (updates `metadata.review_status`).

## Required secrets (Supabase Edge secrets)

Set these in **Supabase Dashboard → Edge Functions → Secrets** (or `supabase secrets set`):

- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV` — `sandbox` (recommended for v1)
- `PLAID_WEBHOOK_URL` — `https://<PROJECT_REF>.supabase.co/functions/v1/plaid-webhook`
- `INTEGRATION_WORKER_SECRET` — used to authorize webhook → sync dispatch and cron safety net
- Optional: `INTEGRATION_TOKEN_ENCRYPTION_KEY` — encrypts Plaid access tokens at rest (AES-GCM)

## Plaid Console setup

1. Create a Plaid app and enable the **Transactions** product.
2. Configure the webhook URL:

```text
https://<PROJECT_REF>.supabase.co/functions/v1/plaid-webhook
```

3. Use **Sandbox** for development.

## Sandbox login credentials

In Plaid Link sandbox, you can use the standard Plaid fixtures, for example:

```text
username: user_good
password: pass_good
```

## Deploy

```bash
supabase functions deploy \
  plaid-link-token plaid-exchange plaid-sync plaid-webhook plaid-disconnect \
  integration-connection-status integration-worker
```

The repo’s deploy helper also includes these: [`scripts/deploy-edge-functions.sh`](../scripts/deploy-edge-functions.sh).

## Webhook verification

`plaid-webhook` verifies the `Plaid-Verification` JWT signature by fetching the verification key by `kid` from Plaid.

If webhook verification fails, check:

- `PLAID_CLIENT_ID` / `PLAID_SECRET` are correct for the environment
- `PLAID_ENV` matches the app environment (sandbox/dev/prod)
- Plaid is sending `Plaid-Verification` header

