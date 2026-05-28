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
    /** CRM customers React table (see crm-table-react-mount.tsx + financial-core.js). */
    bizDashCrmCustomersTableBuildPayload?: () => Record<string, unknown>;
    bizDashCrmCustomersTableApplyPayload?: (p: Record<string, unknown>) => void;
    bizDashSyncCrmCustomersTable?: () => void;
    bizDashApplyCustomersColumnVisibility?: () => void;
    bizDashCrmCustomersTableFocus?: (o: { rowId: string; colId: string; activate?: boolean }) => void;
    bizDashCrmTablePatchField?: (
      clientId: string,
      fieldKey: string,
      value: string,
      colId: string,
    ) => Promise<boolean>;
    bizDashCrmTableRevertField?: (clientId: string, fieldKey: string, previous: string) => void;
    bizDashCrmTableOnLeaveRow?: (rowId: string) => void;
    /** Set pill color for a CRM select option (persists `crmOptionColors`). */
    bizDashCrmSetOptionColor?: (
      selectKey: string,
      label: string,
      color: import('./lib/crm-customers-schema').CrmPillColorKey,
    ) => Promise<boolean>;
    /** Rename a Status option (migrates clients, projects, colors, and custom status list). */
    bizDashCrmRenameSelectOption?: (
      selectKey: string,
      oldLabel: string,
      newLabel: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    /** Remove a custom Status from workspace (migrates clients/projects to Lead). */
    bizDashCrmDeleteSelectOption?: (
      selectKey: string,
      label: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    /** Navigate to Advisor with optional composer prefill (see financial-core.js). */
    bizDashGoToAdvisor?: (opts?: { prefill?: string; newThread?: boolean }) => void;
    /** Gmail compose React island (email-compose-react-mount.tsx). */
    __emailCompose?: import('./components/email/EmailComposeApp').EmailComposeApi;
    bizDashOpenEmailComposer?: (prefill?: import('./lib/email/types').ComposePrefill) => void;
    bizDashOpenEmailReply?: (opts: Parameters<import('./lib/email/reply').buildReplyPrefill>[0]) => void;
    bizDashMountEmailCompose?: () => void;
    bizDashMountVoiceAgent?: () => void;
    bizDashAdvisorAsk?: (text: string, opts?: { voice?: boolean }) => void;
    bizDashAdvisorSpeak?: (text: string) => void;
    bizDashReloadUserUiPreferences?: () => Promise<void>;
    __bizdashCloseEmlComposeModal?: () => void;
    bizDashGetCurrentOrgId?: () => string | null;
    isDemoDashboardUser?: () => boolean;
    __bizdashSupabaseUrl?: string;
    __bizdashSupabaseAnonKey?: string;
    currentOrganizationId?: string;
  }
}

export {};
