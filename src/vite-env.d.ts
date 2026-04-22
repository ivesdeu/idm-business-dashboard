/// <reference types="vite/client" />

declare global {
  interface Window {
    /** Supabase browser client from `supabase-auth.js` (used by React auth islands). */
    supabaseClient?: import('@supabase/supabase-js').SupabaseClient;
    /** Password recovery UI flag (see `supabase-auth.js` + `auth-login-gate.tsx`). */
    __bizdashIsAuthRecoveryMode?: () => boolean;
    DEMO_DASHBOARD_USER_ID?: string;
    /** True when “View Demo” session (see financial-core.js). Mock data must gate on this. */
    bizDashIsDemoUser?: () => boolean;
  }
}

export {};
