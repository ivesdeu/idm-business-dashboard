#!/usr/bin/env bash
# Deploy every Edge Function in this repo to a Supabase project (same list as production).
# Usage:
#   export SUPABASE_PROJECT_REF="your-project-ref"   # subdomain, e.g. ausivxesedagohjlthiy
#   ./scripts/deploy-edge-functions.sh
#
# Requires: supabase CLI logged in (`supabase login`) or SUPABASE_ACCESS_TOKEN set for CI.

set -euo pipefail

REF="${SUPABASE_PROJECT_REF:-}"
if [[ -z "$REF" ]]; then
  echo "error: set SUPABASE_PROJECT_REF to your Supabase project ref (Dashboard → Project Settings → General)." >&2
  exit 1
fi

FUNCS=(
  accept-org-invite
  ai-assistant
  create-stripe-checkout-session
  deepgram-token
  gmail-send
  integration-worker
  oauth-google-callback
  oauth-google-start
  oauth-microsoft-callback
  oauth-microsoft-start
  organization-team
  stripe-connect-disconnect
  stripe-connect-start
  stripe-webhook
)

for name in "${FUNCS[@]}"; do
  echo "=== supabase functions deploy ${name} ==="
  supabase functions deploy "${name}" --project-ref "${REF}"
done

echo "All functions deployed. Run through the post-deploy checklist in docs/OPS_SECRETS_AND_OBSERVABILITY.md."
