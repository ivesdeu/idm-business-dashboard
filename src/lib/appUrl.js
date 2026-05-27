/**
 * Canonical app URL helpers for web, PWA, Tauri, and Capacitor shells.
 * Native shells set `window.__BIZDASH_AUTH_SCHEME__` (e.g. "bizdash").
 */

function readEnvAppUrl() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_APP_URL) {
      return String(import.meta.env.VITE_APP_URL).replace(/\/$/, '');
    }
  } catch (_) {}
  return '';
}

export function getNativeAuthScheme() {
  if (typeof window === 'undefined') return null;
  const scheme = window.__BIZDASH_AUTH_SCHEME__;
  return scheme ? String(scheme) : null;
}

export function isNativeShell() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.__BIZDASH_NATIVE__);
}

/** HTTPS (or http://localhost) origin for shareable links and Supabase OAuth redirects. */
export function appWebOrigin() {
  const fromEnv = readEnvAppUrl();
  if (fromEnv) return fromEnv;
  if (typeof window === 'undefined') return '';
  try {
    const origin = window.location.origin || '';
    if (/^https?:/.test(origin)) return origin.replace(/\/$/, '');
  } catch (_) {}
  return '';
}

/** Full URL for a path — deep-link scheme in native shells, web origin otherwise. */
export function appUrl(path = '/') {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const scheme = getNativeAuthScheme();
  if (scheme) return `${scheme}://auth${normalized}`;
  const base = appWebOrigin() || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${String(base).replace(/\/$/, '')}${normalized}`;
}

/** Email confirmation / magic-link redirect target. */
export function authEmailRedirectTo() {
  const web = appWebOrigin();
  if (getNativeAuthScheme() && web) {
    return `${web}/auth/callback`;
  }
  try {
    return (window.location.href || '').split('#')[0];
  } catch (_) {
    return `${web || ''}/`;
  }
}

/** OAuth provider redirect target (must stay on allowlisted https origin). */
export function authOAuthRedirectTo() {
  const web = appWebOrigin();
  if (typeof window === 'undefined') {
    return `${web || ''}/`;
  }
  const path = window.location.pathname || '/';
  const search = window.location.search || '';
  if (web && getNativeAuthScheme()) {
    return `${web}${path}${search}`;
  }
  const origin = window.location.origin || web || '';
  return `${origin}${path}${search}`;
}

export function inviteShareUrl(token) {
  const base = appWebOrigin() || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${String(base).replace(/\/$/, '')}/?invite=${encodeURIComponent(String(token || ''))}`;
}

export function paymentReturnUrl(querySuffix) {
  if (typeof window === 'undefined') {
    return `${appWebOrigin()}/?${querySuffix}`;
  }
  const origin = appWebOrigin() || window.location.origin;
  const path = window.location.pathname || '/';
  return `${origin}${path}?${querySuffix}`;
}

export function exposeAppUrlGlobals() {
  if (typeof window === 'undefined') return;
  window.bizDashAppWebOrigin = appWebOrigin;
  window.bizDashAppUrl = appUrl;
  window.bizDashAuthEmailRedirectTo = authEmailRedirectTo;
  window.bizDashAuthOAuthRedirectTo = authOAuthRedirectTo;
  window.bizDashInviteShareUrl = inviteShareUrl;
}
