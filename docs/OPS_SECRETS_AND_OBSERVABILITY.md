# Operations: secrets and observability (Compass)

## Secret hygiene

| Secret | Surface | Practice |
|--------|---------|----------|
| `SUPABASE_SERVICE_ROLE_KEY` | Edge only | Never expose to the browser; never commit. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Edge only | Rotate if leaked; webhook secret must match Stripe dashboard. |
| `OAUTH_STATE_SECRET`, `GOOGLE_*`, `MICROSOFT_*` | Edge secrets | Rotate periodically; `OAUTH_STATE_SECRET` invalidates in-flight OAuth states. |
| `INTEGRATION_WORKER_SECRET` | Cron / worker callers | Long random value; same header for `integration-worker` only. |
| `INTEGRATION_TOKEN_ENCRYPTION_KEY` | Optional AES for refresh tokens | Back up before rotation; re-encrypt column if you change key (planned migration). |
| Anon key | Client | Public by design; RLS must hold. |
| `ASSEMBLYAI_API_KEY` | Edge (`assemblyai-token`, `deepgram-token` alias) | Meeting Notes streaming; never `VITE_*`. If mis-set as `SSEMBLYAI_API_KEY`, rename or rely on Edge fallback until fixed. |

Use Supabase **Edge Function secrets** UI or `supabase secrets set`; restrict GitHub/repo access to env files.

## Structured logging (Edge)

[`supabase/functions/_shared/edgeLog.ts`](../supabase/functions/_shared/edgeLog.ts) emits **single-line JSON** to function logs:

```json
{"fn":"stripe-webhook","level":"warn","action":"ignore","organizationId":"…","requestId":"…","detail":"org mismatch","ts":"…"}
```

**Do not** log email bodies, tokens, or full Stripe payloads. Prefer ids and short reasons.

Every handler uses [`serveWithEdgeRequestLogging`](../supabase/functions/_shared/withEdgeRequestLogging.ts): one **`info`** line per request (method + path), optional **`edgeLog`** on deny/ignore paths with the same **`requestId`**, and **`x-request-id`** on responses. The browser sets **`window.__bizdashCorrelationId`** independently; to join client and Edge timelines, forward that value in a custom header from the client and log it in Edge (not implemented by default).

## Browser correlation

[`src/entries/telemetry-init.js`](../src/entries/telemetry-init.js) runs first from [`src/entries/bootstrap.js`](../src/entries/bootstrap.js): sets **`window.__bizdashCorrelationId`**, logs **`window.error`** / **`unhandledrejection`** as single-line JSON, and [`src/legacy/supabase-auth.js`](../src/legacy/supabase-auth.js) wraps **`supabase.functions.invoke`** failures the same way. Raw **`fetch`** to Edge (e.g. Stripe checkout in `financial-core.js`) logs **`kind: edge_fetch`** on non-OK or thrown errors.

## Edge Function deploy (script + checklist)

Canonical list (keep in sync with `supabase/functions/*/index.ts`):

[`scripts/deploy-edge-functions.sh`](../scripts/deploy-edge-functions.sh) — `SUPABASE_PROJECT_REF=… ./scripts/deploy-edge-functions.sh` after `supabase login` (or CI with `SUPABASE_ACCESS_TOKEN`).

| After deploy | Verify |
|--------------|--------|
| **Stripe** webhooks | Dashboard → Webhooks endpoint URL = `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`; signing secret matches `STRIPE_WEBHOOK_SECRET`. |
| **Stripe Connect** | `stripe-connect-start` / `stripe-connect-disconnect` URLs unchanged; `STRIPE_SECRET_KEY` / Connect settings still valid. |
| **Google OAuth** | Authorized redirect URI includes `…/functions/v1/oauth-google-callback` (or `GOOGLE_REDIRECT_URI` if you override). |
| **Microsoft OAuth** | Redirect URI includes `…/functions/v1/oauth-microsoft-callback` (or app registration equivalent). |
| **CORS / browser callers** | `DASHBOARD_ALLOWED_ORIGINS` lists every production origin that calls browser-accessible Edge functions (e.g. `ai-assistant`, `assemblyai-token`, `create-stripe-checkout-session`, `stripe-connect-start`, `organization-team`, `accept-org-invite`, `gmail-send`). Compass: include `https://compass-login.ivesdeu.com`. |
| **Meeting Notes** | `ASSEMBLYAI_API_KEY` set; `assemblyai-token` deployed; `meeting_notes` migration applied; Netlify serves a build that calls `assemblyai-token` (not legacy `deepgram-token` only). |
| **integration-worker** | Cron or caller still sends `INTEGRATION_WORKER_SECRET` header. |

## Alerts (recommended)

| Signal | Suggestion |
|--------|------------|
| Stripe webhook 4xx/5xx | Alert on spike; check signature and metadata. |
| `gmail-send` / Gmail API 403, 429 | Alert; user may need reconnect or quota. |
| Workflow runs with `status = error` | Dashboard or SQL query on a schedule. |
| Edge function error rate | Supabase dashboard or log drain. |

## Related

- [EDGE_FUNCTION_AUTH.md](EDGE_FUNCTION_AUTH.md)  
- [DEPLOYMENT_ORG_ROUTING.md](DEPLOYMENT_ORG_ROUTING.md)
