/**
 * Load order matches the previous index.html script tags:
 * Telemetry → Supabase global → Chart → app data → auth gate → advisor.
 */
import { mountIconPicker } from './icon-picker-mount.tsx';

mountIconPicker();

import './telemetry-init.js';
import './supabase-vendor.js';
import './chart-setup.js';
import '../legacy/workspace-list-templates.js';
import '../legacy/financial-core.js';
import { mountAuthLoginGate } from './auth-login-react-mount.tsx';
import '../legacy/supabase-auth.js';
import '../legacy/dashboard-assistant.js';
import { mountAdvisorReactComposer } from './advisor-react-mount.tsx';
import { mountSchedulingApp } from './scheduling-react-mount.tsx';
import { mountMeetingNotesPage } from './meeting-notes-react-mount.tsx';
import { mountCrmCustomersTable } from './crm-table-react-mount.tsx';

mountAuthLoginGate();

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

function mountMeetingNotesWhenReady() {
  if (!document.getElementById('meeting-notes-react-root')) {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(mountMeetingNotesWhenReady);
    } else {
      setTimeout(mountMeetingNotesWhenReady, 0);
    }
    return;
  }
  mountMeetingNotesPage();
}
if (typeof requestAnimationFrame !== 'undefined') {
  requestAnimationFrame(mountMeetingNotesWhenReady);
} else {
  setTimeout(mountMeetingNotesWhenReady, 0);
}

function mountCrmTableWhenReady() {
  if (!document.getElementById('customers-tbody')) {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(mountCrmTableWhenReady);
    } else {
      setTimeout(mountCrmTableWhenReady, 0);
    }
    return;
  }
  mountCrmCustomersTable();
}
if (typeof requestAnimationFrame !== 'undefined') {
  requestAnimationFrame(mountCrmTableWhenReady);
} else {
  setTimeout(mountCrmTableWhenReady, 0);
}
