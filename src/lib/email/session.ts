declare global {
  interface Window {
    supabaseClient?: import('@supabase/supabase-js').SupabaseClient;
    bizDashGetCurrentOrgId?: () => string | null;
    __bizdashSupabaseUrl?: string;
    __bizdashSupabaseAnonKey?: string;
    isDemoDashboardUser?: () => boolean;
  }
}

export function getSupabase() {
  return window.supabaseClient ?? null;
}

export function getOrgId(): string | null {
  if (typeof window.bizDashGetCurrentOrgId === 'function') {
    return window.bizDashGetCurrentOrgId();
  }
  const id = (window as { currentOrganizationId?: string }).currentOrganizationId;
  return id && String(id).trim() ? String(id).trim() : null;
}

export function getEdgeBase(): string {
  const base = window.__bizdashSupabaseUrl;
  return typeof base === 'string' ? base.trim().replace(/\/$/, '') : '';
}

export function getAnonKey(): string {
  const k = window.__bizdashSupabaseAnonKey;
  return typeof k === 'string' ? k.trim() : '';
}

export function isDemoUser(): boolean {
  if (typeof window.isDemoDashboardUser === 'function') {
    return window.isDemoDashboardUser();
  }
  return false;
}

export async function getAccessToken(): Promise<string | null> {
  const supa = getSupabase();
  if (!supa) return null;
  const { data } = await supa.auth.getSession();
  return data.session?.access_token ?? null;
}

export function parseRecipients(input: string): string[] {
  return input
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((e) => e.length > 0 && e.includes('@'));
}

export function recipientsToString(list: string[]): string {
  return list.join(', ');
}
