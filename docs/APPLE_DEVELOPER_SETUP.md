# Apple Developer setup (Stage 0)

Manual steps required before signed Mac builds and App Store / TestFlight submission.

## 1. Enroll in Apple Developer Program

1. Go to [developer.apple.com/programs/enroll](https://developer.apple.com/programs/enroll).
2. Enroll as an organization or individual ($99 USD / year).
3. Allow up to 24 hours for approval.

## 2. Developer ID Application certificate (Mac notarization)

1. Open **Keychain Access** → **Certificate Assistant** → **Request a Certificate From a Certificate Authority**.
2. Save the `.certSigningRequest` file.
3. In [Apple Developer → Certificates](https://developer.apple.com/account/resources/certificates/list), create **Developer ID Application**.
4. Download the `.cer` and double-click to install in the **login** keychain.

Important: the `.cer` only works if it was created from a CSR on **this Mac**. If you see the certificate under **Certificates** but not under **My Certificates**, the private key is missing — create a new CSR on this machine, revoke the old cert if needed, and re-download.

Verify a signing identity exists (must show `1 valid identities found` or more):

```bash
security find-identity -v -p codesigning
```

Example output:

```
1) ABCD1234… "Developer ID Application: Your Name (TEAMID)"
   1 valid identities found
```

Build with the **full** identity string (not just `"Developer ID Application"`):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
# or just the team id in parentheses:
# export APPLE_SIGNING_IDENTITY="TEAMID"

npm run build
npm run tauri:build
```

### "The specified item could not be found in the keychain"

This almost always means one of:

1. **Wrong identity name** — `tauri.conf.json` must not use the partial label `Developer ID Application`. Use the full name from `find-identity`, or set `APPLE_SIGNING_IDENTITY` as above.
2. **No private key** — certificate installed without `.p12` / CSR from this Mac. Fix in Keychain Access → **My Certificates**.
3. **Not enrolled yet** — no Developer ID cert at all.

**Local test build without distribution signing** (ad-hoc; not notarized, not for public release):

```bash
npm run tauri:build:adhoc
```

Export `.p12` for CI (optional):

```bash
# Keychain Access → My Certificates → expand cert → export private key as .p12
openssl base64 -in certificate.p12 | pbcopy   # → GitHub secret APPLE_CERTIFICATE
```

## 3. App Store Connect API key (notarization automation)

1. [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. Generate a key with **Developer** role.
3. Download the `.p8` file once (cannot re-download).
4. Store in 1Password / CI secrets:

```bash
export APPLE_API_KEY="path/to/AuthKey_XXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## 4. Supabase Auth redirect URLs

Add to **Supabase Dashboard → Authentication → URL Configuration → Redirect URLs**:

- `https://YOUR_PRODUCTION_DOMAIN/auth/callback`
- `bizdash://auth` (Tauri deep link)
- `http://localhost:5173/auth/callback` (local dev)

Set **Site URL** to `https://YOUR_PRODUCTION_DOMAIN`.

## 5. Netlify environment

In Netlify → Site settings → Environment variables:

```
VITE_APP_URL=https://YOUR_PRODUCTION_DOMAIN
```

Redeploy after changing.
