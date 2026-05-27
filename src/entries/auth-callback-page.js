import '../auth-callback.css';
import './supabase-vendor.js';
import { appUrl, appWebOrigin, isNativeShell } from '../lib/appUrl.js';

const STATUS_ID = 'auth-callback-status';

function setStatus(message, isError = false) {
  const el = document.getElementById(STATUS_ID);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-error', isError);
}

function mountCallbackShell() {
  document.documentElement.classList.add('auth-callback-route');
  const shell = document.getElementById('auth-callback-shell');
  if (shell) shell.hidden = false;
}

function getSupabaseUrl() {
  if (typeof __BIZDASH_SUPABASE_URL__ !== 'undefined') return __BIZDASH_SUPABASE_URL__;
  return import.meta.env?.VITE_SUPABASE_URL || '';
}

function getSupabaseAnon() {
  if (typeof __BIZDASH_SUPABASE_ANON_KEY__ !== 'undefined') return __BIZDASH_SUPABASE_ANON_KEY__;
  return import.meta.env?.VITE_SUPABASE_ANON_KEY || '';
}

function destinationAfterAuth() {
  const origin = appWebOrigin() || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${String(origin).replace(/\/$/, '')}/`;
}

function nativeHandoffUrl(hash) {
  const target = appUrl('/auth');
  if (!target || /^https?:/i.test(target)) return null;
  return `${target}${hash || ''}`;
}

async function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function completeAuthCallback() {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnon = getSupabaseAnon();
  if (!supabaseUrl || !supabaseAnon) {
    setStatus('Sign-in service is not configured. Contact support.', true);
    return;
  }

  if (!window.supabase?.createClient) {
    setStatus('Sign-in library failed to load. Refresh and try again.', true);
    return;
  }

  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnon, {
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  const params = new URLSearchParams(window.location.search || '');
  const hash = String(window.location.hash || '');
  const code = params.get('code');

  if (code) {
    setStatus('Verifying your sign-in link…');
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      setStatus(error.message || 'Could not complete sign-in.', true);
      return;
    }
  } else if (hash.includes('access_token') || hash.includes('refresh_token')) {
    setStatus('Finishing sign-in…');
    const { error } = await supabase.auth.getSession();
    if (error) {
      setStatus(error.message || 'Could not complete sign-in.', true);
      return;
    }
  } else {
    setStatus('No sign-in token found in this link. Request a new email and try again.', true);
    return;
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) {
    setStatus(sessionError?.message || 'Sign-in did not complete. Try again from the app.', true);
    return;
  }

  window.supabaseClient = supabase;

  if (isNativeShell()) {
    const handoff = nativeHandoffUrl(hash);
    if (handoff) {
      setStatus('Opening the desktop app…');
      window.location.replace(handoff);
      await wait(2500);
      setStatus('If the app did not open, return to Business Dashboard and sign in again.', true);
      return;
    }
  }

  setStatus('Success! Redirecting…');
  const dest = destinationAfterAuth();
  window.location.replace(dest);
}

export async function runAuthCallbackPage() {
  if (typeof window === 'undefined') return;
  const pathname = window.location.pathname || '/';
  if (!pathname.startsWith('/auth/callback')) return;

  mountCallbackShell();
  setStatus('Completing sign-in…');

  try {
    await completeAuthCallback();
  } catch (err) {
    console.error('[auth-callback]', err);
    setStatus(err instanceof Error ? err.message : 'Unexpected error during sign-in.', true);
  }
}
