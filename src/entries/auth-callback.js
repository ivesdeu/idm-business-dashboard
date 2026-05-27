import { runAuthCallbackPage } from './auth-callback-page.js';

export function initAuthCallbackRoute() {
  if (typeof window === 'undefined') return;
  const pathname = window.location.pathname || '/';
  if (!pathname.startsWith('/auth/callback')) return;
  void runAuthCallbackPage();
}
