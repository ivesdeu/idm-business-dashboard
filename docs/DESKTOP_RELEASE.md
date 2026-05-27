# Desktop release (Tauri)

## One-time setup

1. Generate updater signing keys (passwordless for CI):

```bash
CI=true npx tauri signer generate -w src-tauri/bizdash.key -f -p ""
```

2. Commit `src-tauri/bizdash.key.pub` only. Add `src-tauri/bizdash.key` to your secrets store (GitHub Actions: `TAURI_SIGNING_PRIVATE_KEY` as the file contents).

3. Set production URL in Netlify and GitHub:

- `VITE_APP_URL=https://your-domain.com`
- Optional repo variable `vars.VITE_APP_URL` for CI

4. Run config sync locally after changing domain or pubkey:

```bash
npm run sync:tauri-config
```

## Build locally

```bash
security find-identity -v -p codesigning   # must list a Developer ID identity
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"

npm run build
npm run tauri:build
```

Ad-hoc only (no Developer ID cert yet — for smoke-testing the `.app`, not for distribution):

```bash
npm run tauri:build:adhoc
```

Artifacts appear under `src-tauri/target/release/bundle/`.

## Publish update manifest

After each release, upload installers to `/downloads/` on your site and update `public/updates/latest.json` with platform URLs and signatures from the Tauri build output.

The updater endpoint is configured to:

`{VITE_APP_URL}/updates/latest.json`

## Auth callback for native apps

Email and magic links should redirect to:

`https://your-domain.com/auth/callback`

The callback page completes the Supabase session, then hands off to `bizdash://auth#…` when running inside Tauri.
