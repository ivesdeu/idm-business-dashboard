/**
 * Mandatory login: main app bundle loads only after Supabase session exists.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

function readConfig() {
  const el = document.getElementById('bizdash-supabase-config');
  if (!el) return { url: '', anonKey: '' };
  try {
    return JSON.parse(el.textContent);
  } catch {
    return { url: '', anonKey: '' };
  }
}

const { url, anonKey } = readConfig();
const loadingEl = document.getElementById('auth-loading');
const gateEl = document.getElementById('auth-login-shell');
const appEl = document.getElementById('app-shell');
const errEl = document.getElementById('gate-auth-error');

function showLoading(on) {
  if (loadingEl) loadingEl.style.display = on ? 'flex' : 'none';
}

function showGate() {
  showLoading(false);
  if (gateEl) gateEl.style.display = 'flex';
  if (appEl) {
    appEl.style.display = 'none';
    appEl.classList.remove('on');
  }
}

async function showApp() {
  showLoading(false);
  if (gateEl) gateEl.style.display = 'none';
  if (appEl) {
    appEl.style.display = 'flex';
    appEl.classList.add('on');
  }
  if (!window.__bizdashMainLoaded) {
    window.__bizdashMainLoaded = true;
    try {
      await import('/assets/index-jSIynU6K.js');
      if (document.readyState !== 'loading') {
        document.dispatchEvent(new Event('DOMContentLoaded'));
      }
    } catch (err) {
      console.error('[bizdash] Failed to load main bundle:', err);
      setError('Could not load the dashboard code. Please refresh; if this keeps happening, contact support.');
      window.__bizdashMainLoaded = false;
    }
  }
}

function setError(msg) {
  if (errEl) errEl.textContent = msg || '';
}

if (!url || !anonKey) {
  showLoading(false);
  if (gateEl) gateEl.style.display = 'flex';
  setError('Missing Supabase URL or anon key. Set them in index.html (bizdash-supabase-config) or restore .env and rebuild.');
} else {
  const client = createClient(url, anonKey);

  client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      window.__bizdashMainLoaded = false;
      showGate();
      window.location.reload();
    }
  });

  document.getElementById('gate-signin')?.addEventListener('click', async () => {
    setError('');
    const email = document.getElementById('gate-email')?.value?.trim();
    const password = document.getElementById('gate-password')?.value || '';
    if (!email || !password) {
      setError('Enter email and password.');
      return;
    }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      return;
    }
    await showApp();
  });

  document.getElementById('gate-github')?.addEventListener('click', async () => {
    setError('');
    const { error } = await client.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) setError(error.message);
  });

  document.getElementById('gate-signup')?.addEventListener('click', async () => {
    setError('');
    const email = document.getElementById('gate-email')?.value?.trim();
    const password = document.getElementById('gate-password')?.value || '';
    if (!email || !password) {
      setError('Enter email and password to sign up.');
      return;
    }
    const { error } = await client.auth.signUp({ email, password });
    if (error) {
      setError(error.message);
      return;
    }
    setError('Check your email to confirm, then sign in.');
  });

  (async function boot() {
    showLoading(true);
    const {
      data: { session },
      error,
    } = await client.auth.getSession();
    if (error) {
      showLoading(false);
      showGate();
      setError(error.message);
      return;
    }
    if (session?.user) {
      await showApp();
    } else {
      showGate();
    }
  })();
}
