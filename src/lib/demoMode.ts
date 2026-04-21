/**
 * Demo (“View Demo”) detection. Mock CRM data must NEVER be shown or written for real sessions.
 *
 * Canonical check is `window.bizDashIsDemoUser()` from financial-core.js (same ID as DEMO_DASHBOARD_USER_ID).
 */
export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & {
    bizDashIsDemoUser?: () => boolean;
    DEMO_DASHBOARD_USER_ID?: string;
    currentUser?: { id?: string } | null;
  };
  if (typeof w.bizDashIsDemoUser === 'function') {
    return w.bizDashIsDemoUser();
  }
  const demoId = w.DEMO_DASHBOARD_USER_ID ?? '00000000-0000-4000-8000-000000000001';
  const uid = w.currentUser?.id;
  return uid != null && String(uid) === String(demoId);
}
