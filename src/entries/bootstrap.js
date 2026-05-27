/**
 * Load order: Telemetry → Supabase → app data → auth gate → lazy islands / charts on nav or idle.
 */
import './telemetry-init.js';
import { exposeAppUrlGlobals } from '../lib/appUrl.js';
import { initAuthCallbackRoute } from './auth-callback.js';

const isAuthCallbackRoute =
  typeof window !== 'undefined' &&
  (window.location.pathname === '/auth/callback' ||
    window.location.pathname.startsWith('/auth/callback/'));

exposeAppUrlGlobals();
initAuthCallbackRoute();

if (!isAuthCallbackRoute) {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('auth-callback-route');
    const shell = document.getElementById('auth-callback-shell');
    if (shell) shell.hidden = true;
  }
  await import('./bootstrap-app.js');
}
