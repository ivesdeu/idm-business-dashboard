import './supabase-vendor.js';
import '../legacy/workspace-list-templates.js';
import '../legacy/financial-core.js';
import { mountAuthLoginGate } from './auth-login-react-mount.tsx';
import '../legacy/supabase-auth.js';
import '../legacy/dashboard-assistant.js';
import { ensureChart } from './chart-setup.js';
import { registerServiceWorker } from './pwa-register.js';
import { wirePwaInstallUi } from './pwa-install.js';

mountAuthLoginGate();

/*
 * financial-core `init()` can run synchronously while `document.readyState !== 'loading'`
 * (typical for deferred module graphs). That happens before this file's prior imports finish,
 * so `wireDashboardAssistant` did not exist yet and Advisor never wired — React composer never mounted.
 */
if (typeof window.wireDashboardAssistant === 'function') {
  window.wireDashboardAssistant();
}

const CHART_PAGES = new Set([
  'dashboard',
  'performance',
  'retention',
  'insights',
  'marketing',
  'expenses',
  'revenue',
]);

const islandLoaders = {
  scheduling: () => import('./scheduling-react-mount.tsx').then((m) => m.mountSchedulingApp()),
  'meeting-notes': () => import('./meeting-notes-react-mount.tsx').then((m) => m.mountMeetingNotesPage()),
  customers: () => import('./crm-table-react-mount.tsx').then((m) => m.mountCrmCustomersTable()),
  chat: () => import('./advisor-react-mount.tsx').then((m) => m.mountAdvisorReactComposer()),
};

const islandLoaded = new Set();
const islandLoading = {};

function ensureIsland(pageId) {
  const loader = islandLoaders[pageId];
  if (!loader || islandLoaded.has(pageId) || islandLoading[pageId]) return;
  islandLoading[pageId] = loader()
    .then(() => {
      islandLoaded.add(pageId);
    })
    .catch((err) => {
      console.error('[bootstrap] island load failed:', pageId, err);
    })
    .finally(() => {
      delete islandLoading[pageId];
    });
}

function ensureChartForPage(pageId) {
  if (CHART_PAGES.has(pageId)) void ensureChart();
}

function wireNavHook() {
  if (typeof window.nav !== 'function') {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(wireNavHook);
    } else {
      setTimeout(wireNavHook, 0);
    }
    return;
  }
  const originalNav = window.nav;
  window.nav = function (pageId, el) {
    ensureIsland(pageId);
    ensureChartForPage(pageId);
    return originalNav(pageId, el);
  };

  const activePage = document.querySelector('.pg.on');
  const initialPageId = activePage?.id?.replace(/^page-/, '') || 'dashboard';
  ensureIsland(initialPageId);
  ensureChartForPage(initialPageId);
}

if (typeof requestAnimationFrame !== 'undefined') {
  requestAnimationFrame(wireNavHook);
} else {
  setTimeout(wireNavHook, 0);
}

const scheduleIdle =
  typeof window.requestIdleCallback === 'function'
    ? (cb) => window.requestIdleCallback(cb, { timeout: 3000 })
    : (cb) => window.setTimeout(cb, 1500);

scheduleIdle(() => {
  Object.keys(islandLoaders).forEach((pageId) => ensureIsland(pageId));
  void ensureChart();
});

scheduleIdle(() => {
  import('./icon-picker-mount.tsx').then((m) => m.mountIconPicker());
});

/** Advisor React island — mount after legacy `wireDashboardAssistant` defines `bizDashAdvisorGetComposerApi`. */
function mountAdvisorComposerWhenReady() {
  if (typeof window.bizDashAdvisorGetComposerApi !== 'function') {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(mountAdvisorComposerWhenReady);
    } else {
      setTimeout(mountAdvisorComposerWhenReady, 0);
    }
    return;
  }
  ensureIsland('chat');
}

if (typeof requestAnimationFrame !== 'undefined') {
  requestAnimationFrame(mountAdvisorComposerWhenReady);
} else {
  setTimeout(mountAdvisorComposerWhenReady, 0);
}

wirePwaInstallUi();

const scheduleSw =
  typeof window.requestIdleCallback === 'function'
    ? (cb) => window.requestIdleCallback(cb, { timeout: 4000 })
    : (cb) => window.setTimeout(cb, 2000);

scheduleSw(() => {
  void registerServiceWorker();
});
