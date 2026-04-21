/// <reference types="vite/client" />

declare global {
  interface Window {
    DEMO_DASHBOARD_USER_ID?: string;
    /** True when “View Demo” session (see financial-core.js). Mock data must gate on this. */
    bizDashIsDemoUser?: () => boolean;
  }
}

export {};
