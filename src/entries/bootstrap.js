/**
 * Load order matches the previous index.html script tags:
 * Telemetry → Supabase global → Chart → app data → auth gate → advisor.
 */
import './telemetry-init.js';
import './supabase-vendor.js';
import './chart-setup.js';
import '../legacy/financial-core.js';
import '../legacy/supabase-auth.js';
import '../legacy/dashboard-assistant.js';
import { mountAdvisorReactComposer } from './advisor-react-mount.tsx';
import { mountSchedulingApp } from './scheduling-react-mount.tsx';

/*
 * financial-core `init()` can run synchronously while `document.readyState !== 'loading'`
 * (typical for deferred module graphs). That happens before this file's prior imports finish,
 * so `wireDashboardAssistant` did not exist yet and Advisor never wired — React composer never mounted.
 */
if (typeof window.wireDashboardAssistant === 'function') {
  window.wireDashboardAssistant();
}

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
  mountAdvisorReactComposer();
}
if (typeof requestAnimationFrame !== 'undefined') {
  requestAnimationFrame(mountAdvisorComposerWhenReady);
} else {
  setTimeout(mountAdvisorComposerWhenReady, 0);
}

function mountSchedulingWhenReady() {
  if (!document.getElementById('scheduling-react-root')) {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(mountSchedulingWhenReady);
    } else {
      setTimeout(mountSchedulingWhenReady, 0);
    }
    return;
  }
  mountSchedulingApp();
}
if (typeof requestAnimationFrame !== 'undefined') {
  requestAnimationFrame(mountSchedulingWhenReady);
} else {
  setTimeout(mountSchedulingWhenReady, 0);
}
