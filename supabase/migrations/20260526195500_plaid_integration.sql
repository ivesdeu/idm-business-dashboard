-- Plaid integration storage (items + accounts) and transaction dedupe.
-- Written to align with existing integration_credentials patterns:
-- - Service-role Edge Functions read/write sensitive tokens
-- - RLS enabled; no client policies on token-bearing tables

CREATE TABLE IF NOT EXISTS public.plaid_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  connected_by_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  plaid_item_id text NOT NULL,
  institution_id text,
  institution_name text,
  -- Encrypted payload (see _shared/tokenCrypto.ts). Never expose to client.
  access_token_encrypted text NOT NULL,
  sync_cursor text,
  last_sync_at timestamptz,
  webhook_status text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plaid_item_id)
);

CREATE INDEX IF NOT EXISTS plaid_items_org_idx ON public.plaid_items (organization_id);
CREATE INDEX IF NOT EXISTS plaid_items_last_sync_idx ON public.plaid_items (last_sync_at);

ALTER TABLE public.plaid_items ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.plaid_items FROM PUBLIC;
GRANT ALL ON public.plaid_items TO service_role;

COMMENT ON TABLE public.plaid_items IS
  'Plaid item credentials (encrypted access token + sync cursor) for workspace transaction sync. Service-role only.';

CREATE TABLE IF NOT EXISTS public.plaid_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES public.plaid_items (id) ON DELETE CASCADE,
  plaid_account_id text NOT NULL,
  name text,
  mask text,
  type text,
  subtype text,
  current_balance numeric,
  available_balance numeric,
  iso_currency_code text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plaid_account_id)
);

CREATE INDEX IF NOT EXISTS plaid_accounts_org_idx ON public.plaid_accounts (organization_id);
CREATE INDEX IF NOT EXISTS plaid_accounts_item_idx ON public.plaid_accounts (item_id);

ALTER TABLE public.plaid_accounts ENABLE ROW LEVEL SECURITY;

-- Allow members to view connected accounts (for badges / display).
DROP POLICY IF EXISTS plaid_accounts_select_org ON public.plaid_accounts;
CREATE POLICY plaid_accounts_select_org ON public.plaid_accounts
  FOR SELECT
  TO authenticated
  USING (public.user_is_org_member (organization_id));

-- Writes happen only via service_role Edge Functions.
REVOKE ALL ON public.plaid_accounts FROM PUBLIC;
GRANT SELECT ON public.plaid_accounts TO authenticated;
GRANT ALL ON public.plaid_accounts TO service_role;

COMMENT ON TABLE public.plaid_accounts IS
  'Accounts within a Plaid item. Readable by org members; written only by service_role.';

-- Dedupe Plaid transactions when syncing into the existing ledger.
-- Matches Stripe pattern of expression unique indexes for idempotent inserts.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_plaid_transaction_id_unique
  ON public.transactions (organization_id, (metadata->>'plaid_transaction_id'))
  WHERE (metadata->>'plaid_transaction_id') IS NOT NULL;

