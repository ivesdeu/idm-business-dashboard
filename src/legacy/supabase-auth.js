// supabase-auth.js
// Supabase auth gate + organization slug routing (path /:slug/…).

(function () {
  'use strict';

  var PENDING_INVITE_KEY = 'bizdash_pending_org_invite';
  var FLASH_INVITE_KEY = 'bizdash_flash_invite_msg';

  // Injected at build/dev time by Vite (`vite.config.mjs`); set VITE_SUPABASE_* in `.env` for other projects.
  var SUPABASE_URL = typeof __BIZDASH_SUPABASE_URL__ !== 'undefined' ? __BIZDASH_SUPABASE_URL__ : '';
  var SUPABASE_ANON_KEY = typeof __BIZDASH_SUPABASE_ANON_KEY__ !== 'undefined' ? __BIZDASH_SUPABASE_ANON_KEY__ : '';

  if (!window.supabase) {
    console.error('Supabase JS not loaded. Check that the app bundle built correctly.');
    function recoverNoSupabaseClient() {
      var loading = document.getElementById('auth-loading');
      var shell = document.getElementById('auth-login-shell');
      var app = document.getElementById('app-shell');
      var ge = document.getElementById('gate-auth-error');
      if (loading) loading.style.display = 'none';
      if (shell) shell.style.display = 'flex';
      if (app) app.classList.remove('on');
      if (ge) {
        ge.textContent =
          'The sign-in library did not load. Try a hard refresh or redeploy; sign-in will not work until the app JavaScript loads.';
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', recoverNoSupabaseClient);
    } else {
      recoverNoSupabaseClient();
    }
    return;
  }

  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.supabaseClient = supabase;
  /** Used by team Edge `fetch` (CDN bundles may not expose `supabaseUrl` / `supabaseKey`). */
  window.__bizdashSupabaseUrl = SUPABASE_URL;
  window.__bizdashSupabaseAnonKey = SUPABASE_ANON_KEY;

  if (supabase.functions && typeof supabase.functions.invoke === 'function') {
    var rawInvoke = supabase.functions.invoke.bind(supabase.functions);
    supabase.functions.invoke = function (name, options) {
      return rawInvoke(name, options).then(
        function (res) {
          if (res && res.error) {
            try {
              console.error(
                '[bizdash]',
                JSON.stringify({
                  kind: 'functions.invoke',
                  correlationId: window.__bizdashCorrelationId || '',
                  fnName: name,
                  message: String((res.error && res.error.message) || res.error || ''),
                  status: res.error && (res.error.status || res.error.code),
                }),
              );
            } catch (_) {}
          }
          return res;
        },
        function (err) {
          try {
            console.error(
              '[bizdash]',
              JSON.stringify({
                kind: 'functions.invoke',
                correlationId: window.__bizdashCorrelationId || '',
                fnName: name,
                message: err && err.message ? String(err.message) : String(err),
              }),
            );
          } catch (_) {}
          return Promise.reject(err);
        },
      );
    };
  }

  function $(id) {
    return document.getElementById(id);
  }

  /** Full-screen overlay on #app-shell while initDataFromSupabase hydrates cloud data and branding. */
  function bizDashShowDashboardDataLoading() {
    var el = $('dashboard-data-loading');
    var app = $('app-shell');
    if (el) el.classList.add('on');
    if (app) app.setAttribute('aria-busy', 'true');
  }
  function bizDashHideDashboardDataLoading() {
    var el = $('dashboard-data-loading');
    var app = $('app-shell');
    if (el) el.classList.remove('on');
    if (app) app.removeAttribute('aria-busy');
  }
  window.bizDashShowDashboardDataLoading = bizDashShowDashboardDataLoading;
  window.bizDashHideDashboardDataLoading = bizDashHideDashboardDataLoading;

  /**
   * Ceilings for org / onboarding resolution (not session read — that is driven by INITIAL_SESSION).
   * These are UX timeouts only; the auth session itself has no artificial cap.
   * Keep the workspace gate snappy; brief network issues are retried inside
   * `callResolveSessionWorkspaceWithRetries` / `resolveOrgContextWithRetry` instead of a long outer wait.
   */
  /** UX ceiling for one full workspace resolve (invite + RPC + fallbacks). */
  var ORG_RESOLVE_MS = 6000;
  /** Onboarding prefill (org row + optional storage); keep bounded so login never “hangs”. */
  var ONBOARDING_GATE_MS = 8000;
  /** Avatar signed URL during prefill — do not block first paint on slow storage. */
  var ONBOARD_AVATAR_SIGN_MS = 1200;

  function withTimeout(promise, ms, errMsg) {
    return Promise.race([
      promise,
      new Promise(function (_, rej) {
        setTimeout(function () {
          rej(new Error(errMsg));
        }, ms);
      }),
    ]);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function isLockStolenError(err) {
    var msg = '';
    if (err && err.message) msg = String(err.message);
    if (!msg && err) msg = String(err);
    msg = msg.toLowerCase();
    /* Only Supabase auth lock contention — do not treat generic AbortError / fetch timeouts as "lock". */
    return msg.indexOf('lock was stolen by another request') !== -1;
  }

  /** PostgREST / fetch-style failures worth a short backoff retry (Safari: "Load failed"). */
  function isTransientSupabaseNetworkError(err) {
    if (!err) return false;
    var msg = String(err.message || err.details || err.hint || err || '').toLowerCase();
    if (!msg) return false;
    return (
      msg.indexOf('load failed') !== -1 ||
      msg.indexOf('failed to fetch') !== -1 ||
      msg.indexOf('networkerror') !== -1 ||
      msg.indexOf('network request failed') !== -1 ||
      msg.indexOf('fetch failed') !== -1 ||
      msg.indexOf('connection refused') !== -1 ||
      msg.indexOf('err_connection') !== -1
    );
  }

  function isOrgResolveTimeoutError(err) {
    var msg = err && err.message ? String(err.message) : String(err || '');
    return msg.indexOf('Loading workspace timed out') !== -1;
  }

  async function retryOnAuthLock(task) {
    var maxAttempts = 5;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await task();
      } catch (err) {
        if (!isLockStolenError(err) || attempt === maxAttempts) throw err;
        // Tiny jitter gives the competing request time to release the lock.
        await sleep(140 * attempt);
      }
    }
    return await task();
  }

  async function getSessionNow() {
    return retryOnAuthLock(function () {
      return supabase.auth.getSession();
    });
  }

  function clearOrgContext() {
    window.currentOrganizationId = null;
    window.currentOrganizationSlug = null;
    window.currentOrganizationRole = null;
  }

  function captureInviteFromUrlToStorage() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var tok = (params.get('invite') || '').trim();
      if (tok) sessionStorage.setItem(PENDING_INVITE_KEY, tok);
    } catch (_) {}
  }

  function updateGateInviteHint() {
    var hint = $('gate-invite-hint');
    if (!hint) return;
    try {
      if (sessionStorage.getItem(PENDING_INVITE_KEY)) {
        hint.style.display = 'block';
        hint.textContent =
          'You have a pending team invitation. Sign in with the same email the invitation was sent to, then we will attach you to the workspace.';
      } else {
        hint.style.display = 'none';
        hint.textContent = '';
      }
    } catch (_) {
      hint.style.display = 'none';
    }
  }

  function clearPendingInviteStorage() {
    try {
      sessionStorage.removeItem(PENDING_INVITE_KEY);
    } catch (_) {}
  }

  function stripInviteFromBrowserUrl() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      if (!params.get('invite')) return;
      params.delete('invite');
      var qs = params.toString();
      window.history.replaceState(null, '', (window.location.pathname || '/') + (qs ? '?' + qs : '') + (window.location.hash || ''));
    } catch (_) {}
  }

  function flashInviteMessage(msg) {
    if (!msg) return;
    try {
      sessionStorage.setItem(FLASH_INVITE_KEY, String(msg));
    } catch (_) {}
  }

  function drainInviteFlashIntoApp() {
    var bar = $('app-invite-flash');
    if (!bar) return;
    var msg = '';
    try {
      msg = sessionStorage.getItem(FLASH_INVITE_KEY) || '';
      if (msg) sessionStorage.removeItem(FLASH_INVITE_KEY);
    } catch (_) {}
    if (!msg) {
      bar.style.display = 'none';
      bar.textContent = '';
      return;
    }
    bar.textContent = msg;
    bar.style.display = 'block';
    window.setTimeout(function () {
      bar.style.display = 'none';
      bar.textContent = '';
    }, 12000);
  }

  /** First path segment is workspace slug (e.g. /acme/dashboard → acme). */
  function parseTenantSlug() {
    var raw = (window.location.pathname || '/').replace(/\/+/g, '/');
    if (raw !== '/' && raw.endsWith('/')) raw = raw.slice(0, -1);
    var parts = raw.split('/').filter(Boolean);
    if (!parts.length) return null;
    var seg = parts[0];
    if (seg === 'index.html' || seg === 'dist') return null;
    if (/\.[a-z0-9]{1,8}$/i.test(seg)) return null;
    var head = (seg || '').toLowerCase().split('.')[0];
    var block = { login: 1, assets: 1, api: 1, favicon: 1, health: 1 };
    if (block[head]) return null;
    return String(seg).toLowerCase();
  }

  var LOGIN_SHELL_ACCENT_PROPS = [
    '--coral',
    '--coral2',
    '--coral-bg',
    '--coral-border-soft',
    '--coral-border-mid',
    '--coral-border-strong',
    '--coral-border-focus',
  ];

  function normalizeLoginAccentHex(hex) {
    var s = String(hex || '').trim();
    if (!s) return '';
    if (s[0] !== '#') s = '#' + s;
    var m6 = s.match(/^#([0-9a-fA-F]{6})$/);
    if (m6) return '#' + m6[1].toLowerCase();
    var m3 = s.match(/^#([0-9a-fA-F]{3})$/i);
    if (m3) {
      var h = m3[1];
      return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return '';
  }

  function hexToRgbLoginShell(hex) {
    var n = normalizeLoginAccentHex(hex);
    if (!n || n.length !== 7) return null;
    return {
      r: parseInt(n.slice(1, 3), 16),
      g: parseInt(n.slice(3, 5), 16),
      b: parseInt(n.slice(5, 7), 16),
    };
  }

  function darkenHexLoginShell(hex, factor) {
    var rgb = hexToRgbLoginShell(hex);
    if (!rgb) return hex;
    var f = Math.max(0, Math.min(1, Number(factor) || 0));
    var r = Math.max(0, Math.min(255, Math.round(rgb.r * (1 - f))));
    var g = Math.max(0, Math.min(255, Math.round(rgb.g * (1 - f))));
    var b = Math.max(0, Math.min(255, Math.round(rgb.b * (1 - f))));
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function clearLoginShellAccentOverrides() {
    var shell = $('auth-login-shell');
    if (!shell || !shell.style) return;
    LOGIN_SHELL_ACCENT_PROPS.forEach(function (p) {
      shell.style.removeProperty(p);
    });
  }

  function applyLoginShellAccentFromHex(hex) {
    var shell = $('auth-login-shell');
    if (!shell || !shell.style) return;
    var accent = normalizeLoginAccentHex(hex);
    if (!accent) {
      clearLoginShellAccentOverrides();
      return;
    }
    var rgb = hexToRgbLoginShell(accent);
    if (!rgb) {
      clearLoginShellAccentOverrides();
      return;
    }
    shell.style.setProperty('--coral', accent);
    shell.style.setProperty('--coral2', darkenHexLoginShell(accent, 0.1));
    shell.style.setProperty('--coral-bg', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.08)');
    shell.style.setProperty('--coral-border-soft', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.14)');
    shell.style.setProperty('--coral-border-mid', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.18)');
    shell.style.setProperty('--coral-border-strong', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.2)');
    shell.style.setProperty('--coral-border-focus', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.35)');
  }

  /**
   * Theme the auth gate (#auth-login-shell) from workspace branding when the URL contains /:slug/.
   * Uses organization_public_by_slug.login_accent (SECURITY DEFINER; anon-safe).
   */
  async function refreshLoginShellBrandingFromUrl() {
    if (!supabase) {
      clearLoginShellAccentOverrides();
      return;
    }
    var slug = parseTenantSlug();
    if (!slug) {
      clearLoginShellAccentOverrides();
      return;
    }
    try {
      var pubRes = await retryOnAuthLock(function () {
        return supabase.rpc('organization_public_by_slug', { sl: slug });
      });
      if (pubRes.error || !pubRes.data || !pubRes.data.length) {
        clearLoginShellAccentOverrides();
        return;
      }
      var row = pubRes.data[0];
      var accentRaw = row.login_accent != null ? String(row.login_accent).trim() : '';
      if (!accentRaw) {
        clearLoginShellAccentOverrides();
        return;
      }
      applyLoginShellAccentFromHex(accentRaw);
    } catch (_) {
      clearLoginShellAccentOverrides();
    }
  }

  function setOrgContext(orgId, slug, role) {
    var prevOrg = window.currentOrganizationId;
    var nextOrg = orgId || null;
    if (
      prevOrg &&
      nextOrg &&
      String(prevOrg) !== String(nextOrg) &&
      typeof window.bizDashPersistUserUiPrefsForOrgLeaving === 'function'
    ) {
      window.bizDashPersistUserUiPrefsForOrgLeaving(String(prevOrg));
    }
    window.currentOrganizationId = nextOrg;
    window.currentOrganizationSlug = slug || null;
    window.currentOrganizationRole = role || null;
    if (typeof window.refreshSidebarWorkspaceChrome === 'function') {
      window.refreshSidebarWorkspaceChrome();
    }
    if (typeof window.bizdashUpdateWorkspaceIconAdminUi === 'function') {
      window.bizdashUpdateWorkspaceIconAdminUi();
    }
    // Column prefs (and similar) key localStorage by user+org. Auth flow sets the user before
    // org resolution, so prefs were loaded under :noorg:; reload once the workspace id exists.
    if (orgId && typeof window.bizDashApplyUserUiPrefsForOrg === 'function') {
      window.bizDashApplyUserUiPrefsForOrg(orgId);
    }
    if (orgId && typeof window.bizDashReloadCustomersColumnPrefs === 'function') {
      window.bizDashReloadCustomersColumnPrefs();
    }
  }

  /** Path slug for tenant URLs (`/:slug/…`). Exposed for Advisor org hydration. */
  window.bizDashParseTenantSlug = parseTenantSlug;

  /**
   * Apply a workspace row from `resolve_session_workspace` or `my_organizations` so
   * `window.currentOrganizationId` matches the active URL / membership.
   */
  window.bizDashApplyResolvedWorkspaceRow = function (row) {
    if (!row || row.id == null) return;
    setOrgContext(String(row.id), row.slug != null ? String(row.slug) : null, row.role != null ? String(row.role) : null);
  };

  function escHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugClientValid(sl) {
    return /^[a-z0-9][a-z0-9-]{1,62}$/.test(String(sl || '').trim().toLowerCase());
  }

  /**
   * Slug is taken if any org uses it, except the org given by currentOrgId (same slug = allowed for that org).
   * Uses organization_public_by_slug (SECURITY DEFINER); aligns with DB unique on organizations.slug.
   */
  async function workspaceSlugTakenByAnotherOrg(sl, currentOrgId) {
    var r = await retryOnAuthLock(function () {
      return supabase.rpc('organization_public_by_slug', { sl: sl });
    });
    if (r.error) return { taken: false, rpcError: r.error };
    if (!r.data || !r.data.length) return { taken: false };
    var row = r.data[0];
    if (currentOrgId && String(row.id) === String(currentOrgId)) return { taken: false };
    return { taken: true };
  }

  function replaceBrowserPathForSlug(newSlug) {
    var search = window.location.search || '';
    window.history.replaceState(null, '', '/' + String(newSlug).toLowerCase() + '/' + search);
  }

  /**
   * Consume ?invite= or pending sessionStorage token; on soft failure keep session and continue.
   * @returns {Promise<boolean>} false only when session token missing (should not happen post sign-in)
   */
  async function tryConsumeOrgInvite(user, gateErr, authSession) {
    var params = new URLSearchParams(window.location.search || '');
    var tok = (params.get('invite') || '').trim();
    if (!tok) {
      try {
        tok = (sessionStorage.getItem(PENDING_INVITE_KEY) || '').trim();
      } catch (_) {}
    }
    if (!tok) return true;

    try {
      var sess = authSession && authSession.access_token ? authSession : null;
      if (!sess) {
        var sessRes = await getSessionNow();
        sess = sessRes && sessRes.data ? sessRes.data.session : null;
      }
      if (!sess || !sess.access_token) {
        if (gateErr) gateErr('Sign in to accept this invitation.');
        return false;
      }
      var url = SUPABASE_URL + '/functions/v1/accept-org-invite';
      var res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + sess.access_token,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ token: tok }),
      });
      var j = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j.ok) {
        clearPendingInviteStorage();
        stripInviteFromBrowserUrl();
        flashInviteMessage(j.error ? String(j.error) : 'Could not accept invitation.');
        if (gateErr) gateErr('');
        return true;
      }
      clearPendingInviteStorage();
      params.delete('invite');
      var qs = params.toString();
      var newSearch = qs ? '?' + qs : '';
      var sl = j.slug ? String(j.slug) : '';
      if (sl) {
        window.history.replaceState(null, '', '/' + sl + '/' + newSearch);
      } else {
        window.history.replaceState(null, '', (window.location.pathname || '/') + newSearch);
      }
      return true;
    } catch (err) {
      clearPendingInviteStorage();
      stripInviteFromBrowserUrl();
      flashInviteMessage('Could not accept invitation.');
      if (gateErr) gateErr('');
      return true;
    }
  }

  /** When RPC returns onboarding_completed, avoid a second round-trip. */
  function onboardingModalNeededFromRow(row) {
    if (!row || row.onboarding_completed === undefined || row.onboarding_completed === null) return null;
    var v = row.onboarding_completed;
    if (v === false || v === 'false' || v === 0) return true;
    if (v === true || v === 'true' || v === 1) return false;
    return null;
  }

  /**
   * PostgREST / Postgres when resolve_session_workspace migration has not been applied yet.
   */
  function isResolveSessionWorkspaceUnavailableError(err) {
    if (!err) return false;
    var code = err.code != null ? String(err.code) : '';
    if (code === 'PGRST202' || code === '42883') return true;
    var msg = String(err.message || err.details || err.hint || err || '').toLowerCase();
    var blob = msg;
    try {
      blob = msg + ' ' + String(JSON.stringify(err)).toLowerCase();
    } catch (_) {}
    if (blob.indexOf('resolve_session_workspace') === -1) return false;
    if (blob.indexOf('could not find the function') !== -1) return true;
    if (blob.indexOf('schema cache') !== -1) return true;
    if (blob.indexOf('does not exist') !== -1) return true;
    if (blob.indexOf('unknown function') !== -1) return true;
    return false;
  }

  /**
   * `resolve_session_workspace` can return { error } with "TypeError: Load failed" on flaky networks
   * without throwing — retry a few times before surfacing to the user.
   */
  async function callResolveSessionWorkspaceWithRetries(slug) {
    var delays = [0, 400, 1000];
    var lastRes = null;
    for (var i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await sleep(delays[i]);
      lastRes = await retryOnAuthLock(function () {
        return supabase.rpc('resolve_session_workspace', { p_slug: slug || null });
      });
      if (!lastRes.error) return lastRes;
      if (isResolveSessionWorkspaceUnavailableError(lastRes.error)) return lastRes;
      if (!isTransientSupabaseNetworkError(lastRes.error)) return lastRes;
    }
    return lastRes;
  }

  /**
   * Legacy path (slug RPC + membership + my_organizations) when resolve_session_workspace is missing.
   * Invite flow must already have run in the caller.
   * @param {function(string): void} gateErr
   */
  async function ensureOrganizationContextWithoutResolveRpc(user, authSession, gateErr) {
    var slug = parseTenantSlug();
    if (slug) {
      var pubRes = await retryOnAuthLock(function () {
        return supabase.rpc('organization_public_by_slug', { sl: slug });
      });
      if (pubRes.error) {
        console.error('organization_public_by_slug failed', pubRes.error);
        gateErr('Could not load workspace URL. ' + String(pubRes.error.message || pubRes.error));
        clearOrgContext();
        return { ok: false };
      }
      if (!pubRes.data || !pubRes.data.length) {
        gateErr('Unknown workspace URL.');
        clearOrgContext();
        return { ok: false };
      }
      var org = pubRes.data[0];
      var memRes = await retryOnAuthLock(function () {
        return supabase
          .from('organization_members')
          .select('role')
          .eq('organization_id', org.id)
          .eq('user_id', user.id)
          .maybeSingle();
      });
      if (memRes.error) {
        console.error('organization_members membership check failed', memRes.error);
        gateErr('Could not verify workspace membership. ' + String(memRes.error.message || memRes.error));
        clearOrgContext();
        return { ok: false };
      }
      if (!memRes.data) {
        var fallbackList = await retryOnAuthLock(function () {
          return supabase.rpc('my_organizations');
        });
        if (fallbackList.error || !fallbackList.data || !fallbackList.data.length) {
          gateErr('No workspace found for your account yet. Try again in a moment, or contact support.');
          clearOrgContext();
          return { ok: false };
        }
        var fb = fallbackList.data[0];
        var fbPath = '/' + fb.slug + '/';
        window.history.replaceState(null, '', fbPath + (window.location.search || ''));
        setOrgContext(fb.id, fb.slug, fb.role);
        var fbFlag = onboardingModalNeededFromRow(fb);
        var needsFb = fbFlag !== null ? fbFlag : await fetchOrgNeedsOnboarding(fb.id);
        return { ok: true, needsOnboarding: needsFb };
      }
      setOrgContext(org.id, org.slug || slug, memRes.data.role);
      var slugFlag = onboardingModalNeededFromRow(org);
      var needsOnSlug = slugFlag !== null ? slugFlag : await fetchOrgNeedsOnboarding(org.id);
      return { ok: true, needsOnboarding: needsOnSlug };
    }

    var listRes = await retryOnAuthLock(function () {
      return supabase.rpc('my_organizations');
    });
    if (listRes.error) {
      console.error('my_organizations failed', listRes.error);
      gateErr('Could not load your workspaces. ' + String(listRes.error.message || listRes.error));
      clearOrgContext();
      return { ok: false };
    }
    if (!listRes.data || !listRes.data.length) {
      gateErr('No workspace found for your account. Contact support.');
      clearOrgContext();
      return { ok: false };
    }
    var first = listRes.data[0];
    var targetPath = '/' + first.slug + '/';
    var cur = window.location.pathname || '/';
    if (cur !== targetPath && cur.replace(/\/$/, '') !== '/' + first.slug) {
      window.history.replaceState(null, '', targetPath + (window.location.search || ''));
    }
    setOrgContext(first.id, first.slug, first.role);
    var listFlag = onboardingModalNeededFromRow(first);
    var needsOnList = listFlag !== null ? listFlag : await fetchOrgNeedsOnboarding(first.id);
    return { ok: true, needsOnboarding: needsOnList };
  }

  /**
   * Resolve URL slug to org + membership, or redirect signed-in user to their first org.
   * @returns {Promise<{ ok: boolean, needsOnboarding?: boolean }>}
   */
  async function ensureOrganizationContext(user, authSession) {
    var errEl = $('gate-auth-error');
    function gateErr(msg) {
      if (errEl) errEl.textContent = msg || '';
    }
    gateErr('');
    if (!user || !user.id) {
      clearOrgContext();
      return { ok: false };
    }

    if (!(await tryConsumeOrgInvite(user, gateErr, authSession))) {
      return { ok: false };
    }

    var slug = parseTenantSlug();
    var wsRes = await callResolveSessionWorkspaceWithRetries(slug);
    if (wsRes.error && isResolveSessionWorkspaceUnavailableError(wsRes.error)) {
      console.warn('resolve_session_workspace unavailable; using legacy workspace resolution', wsRes.error);
      return ensureOrganizationContextWithoutResolveRpc(user, authSession, gateErr);
    }
    if (wsRes.error) {
      console.error('resolve_session_workspace failed', wsRes.error);
      gateErr('Could not load your workspace. ' + String(wsRes.error.message || wsRes.error));
      clearOrgContext();
      return { ok: false };
    }
    if (!wsRes.data || !wsRes.data.length) {
      if (slug) {
        gateErr('Unknown workspace URL.');
      } else {
        gateErr('No workspace found for your account. Contact support.');
      }
      clearOrgContext();
      return { ok: false };
    }
    var row = wsRes.data[0];
    var targetPath = '/' + row.slug + '/';
    var cur = window.location.pathname || '/';
    if (cur !== targetPath && cur.replace(/\/$/, '') !== '/' + row.slug) {
      window.history.replaceState(null, '', targetPath + (window.location.search || ''));
    }
    setOrgContext(row.id, row.slug, row.role);
    if (row.needs_onboarding !== undefined && row.needs_onboarding !== null) {
      return { ok: true, needsOnboarding: !!row.needs_onboarding };
    }
    var listFlag = onboardingModalNeededFromRow(row);
    var needsOnList = listFlag !== null ? listFlag : await fetchOrgNeedsOnboarding(row.id);
    return { ok: true, needsOnboarding: needsOnList };
  }

  async function fetchOrgNeedsOnboarding(orgId) {
    if (!orgId) return false;
    try {
      var r = await retryOnAuthLock(function () {
        return supabase.from('organizations').select('onboarding_completed').eq('id', orgId).maybeSingle();
      });
      if (r.error) return false;
      if (!r.data) return false;
      return r.data.onboarding_completed === false;
    } catch (_) {
      return false;
    }
  }

  async function resolveOrgContextWithRetry(user, authSession) {
    var timedOutMsg = 'Loading workspace timed out. Check your connection and try again.';
    try {
      return await withTimeout(ensureOrganizationContext(user, authSession), ORG_RESOLVE_MS, timedOutMsg);
    } catch (err) {
      // One immediate second chance for lock contention only (no extra wait).
      if (isLockStolenError(err)) {
        return await withTimeout(ensureOrganizationContext(user, authSession), ORG_RESOLVE_MS, timedOutMsg);
      }
      // Transient slowness (cold Supabase connection, flaky network, tab backgrounded): one full retry.
      if (isOrgResolveTimeoutError(err)) {
        await sleep(50);
        return await withTimeout(ensureOrganizationContext(user, authSession), ORG_RESOLVE_MS, timedOutMsg);
      }
      /* Thrown network errors from invite flow or rare client throws — one backoff retry. */
      if (isTransientSupabaseNetworkError(err)) {
        await sleep(200);
        return await withTimeout(ensureOrganizationContext(user, authSession), ORG_RESOLVE_MS, timedOutMsg);
      }
      throw err;
    }
  }

  function showOnboardModal() {
    var m = $('onboardModal');
    if (m) m.classList.add('on');
  }

  function hideOnboardModal() {
    var m = $('onboardModal');
    if (m) m.classList.remove('on');
  }

  var onboardSlugManual = false;
  var onboardProfileAvatarObjectUrl = null;
  /** Last server onboarding json (shallow merge target for UI restore). */
  var onboardRemote = null;
  var onboardLastInviteUrl = '';
  var onboardPrimaryUseCase = '';
  var onboardSecondaryUseCase = '';

  var USE_CASE_PRIMARY = [
    { id: 'sales', label: 'Sales' },
    { id: 'customer_success', label: 'Customer success' },
    { id: 'recruiting', label: 'Recruiting' },
    { id: 'fundraising', label: 'Fundraising' },
    { id: 'investing', label: 'Investing' },
    { id: 'other', label: 'Other' },
  ];
  var USE_CASE_SECONDARY = {
    sales: ['Product-led', 'Sales-led', 'Inbound', 'Outbound', 'SMB', 'Mid-market', 'Enterprise'],
    customer_success: ['Low-touch', 'High-touch', 'SMB', 'Mid-market', 'Enterprise'],
    recruiting: ['Agency', 'In-house', 'Executive', 'High volume', 'Technical'],
    fundraising: ['Early-stage', 'Growth-stage', 'Late-stage'],
    investing: ['Early-stage', 'Growth-stage', 'Late-stage'],
    other: [],
  };

  function parseRpcJson(data) {
    var payload = data;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch (_) {
        payload = null;
      }
    }
    return payload && typeof payload === 'object' ? payload : null;
  }

  async function rpcSaveOnboardingProgress(orgId, patch) {
    if (!orgId || !patch || typeof patch !== 'object') return { ok: false, error: 'Bad arguments' };
    var rpcRes = await retryOnAuthLock(function () {
      return supabase.rpc('save_onboarding_progress', { p_org_id: orgId, p_patch: patch });
    });
    var payload = parseRpcJson(rpcRes.data);
    if (rpcRes.error || !payload || !payload.ok) {
      return {
        ok: false,
        error: rpcRes.error ? String(rpcRes.error.message || rpcRes.error) : payload && payload.error ? String(payload.error) : 'Save failed',
      };
    }
    if (payload.onboarding && typeof payload.onboarding === 'object') {
      onboardRemote = payload.onboarding;
    }
    return { ok: true };
  }

  async function rpcCompleteWorkspaceOnboarding(orgId, finalPatch) {
    if (!orgId) return { ok: false, error: 'No workspace' };
    var rpcRes = await retryOnAuthLock(function () {
      return supabase.rpc('complete_workspace_onboarding', {
        p_org_id: orgId,
        p_final: finalPatch && typeof finalPatch === 'object' ? finalPatch : {},
      });
    });
    var payload = parseRpcJson(rpcRes.data);
    if (rpcRes.error || !payload || !payload.ok) {
      return {
        ok: false,
        error: rpcRes.error ? String(rpcRes.error.message || rpcRes.error) : payload && payload.error ? String(payload.error) : 'Complete failed',
      };
    }
    return { ok: true };
  }

  function slugifyCompanyToSlug(name) {
    var s = String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!s.length) s = 'workspace';
    if (!/^[a-z0-9]/.test(s)) s = 'co-' + s;
    if (s.length > 63) s = s.slice(0, 63).replace(/-+$/g, '');
    return s;
  }

  function showOnboardStep(step) {
    var n = Math.max(1, Math.min(6, parseInt(String(step), 10) || 1));
    for (var s = 1; s <= 6; s++) {
      var el = $('onboard-step-' + s);
      if (el) el.classList.toggle('on', s === n);
    }
    for (var e = 1; e <= 6; e++) {
      var errEl = $('onboard-error-' + e);
      if (errEl && e !== 1) errEl.textContent = '';
    }
    var e1 = $('onboard-error');
    if (e1) e1.textContent = '';
    var pref = $('ob-slug-prefix-host');
    if (pref) {
      var o = '';
      try {
        o = window.location.origin || '';
      } catch (_) {}
      pref.textContent = o ? o + '/' : '/';
    }
  }

  /**
   * Must exist before financial-core consumeOAuthReturnFromUrl (DOMContentLoaded can run
   * before runAuthSessionFlow wires the onboarding modal).
   */
  window.bizdashOnboardingOAuthDone = function (ok /*, provider */) {
    var bar = $('app-invite-flash');
    if (bar) {
      bar.textContent = ok
        ? 'Account connected. Continue when you are ready.'
        : 'Connection was not completed. You can try again or skip.';
      bar.style.display = 'block';
      window.setTimeout(function () {
        bar.style.display = 'none';
      }, 10000);
    }
    var oid = window.currentOrganizationId;
    if (oid) {
      void rpcSaveOnboardingProgress(oid, { currentStep: 4, oauthConnected: !!ok });
    }
    try {
      var m = $('onboardModal');
      var shell = $('app-shell');
      if (m && !m.classList.contains('on') && shell && !shell.classList.contains('on')) {
        showOnboardModal();
      }
    } catch (_) {}
    showOnboardStep(4);
  };

  function setOnboardAvatarPreviewLetter(letter) {
    var el = $('ob-avatar-preview');
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(document.createTextNode(letter || '?'));
  }

  function setOnboardAvatarPreviewImage(url) {
    var el = $('ob-avatar-preview');
    if (!el) return;
    el.textContent = '';
    var img = document.createElement('img');
    img.src = url;
    img.alt = '';
    el.appendChild(img);
  }

  function renderPrimaryUseCaseChips() {
    var wrap = $('ob-primary-use-case');
    if (!wrap) return;
    wrap.innerHTML = '';
    USE_CASE_PRIMARY.forEach(function (opt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'onboard-chip';
      b.setAttribute('data-primary-use', opt.id);
      b.textContent = opt.label;
      wrap.appendChild(b);
    });
  }

  function renderSecondaryUseCaseChips(primaryId) {
    var wrap = $('ob-secondary-use-case');
    var outer = $('ob-secondary-wrap');
    var label = $('ob-secondary-label');
    if (!wrap || !outer) return;
    wrap.innerHTML = '';
    var opts = USE_CASE_SECONDARY[primaryId] || [];
    if (!opts.length) {
      outer.style.display = 'none';
      onboardSecondaryUseCase = '';
      return;
    }
    outer.style.display = 'block';
    if (label) label.textContent = 'Please tell us more about your use case.';
    opts.forEach(function (txt) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'onboard-chip';
      b.setAttribute('data-secondary-use', txt);
      b.textContent = txt;
      wrap.appendChild(b);
    });
  }

  function syncPrimaryChipUi() {
    var wrap = $('ob-primary-use-case');
    if (!wrap) return;
    wrap.querySelectorAll('.onboard-chip').forEach(function (b) {
      var id = b.getAttribute('data-primary-use') || '';
      b.classList.toggle('on', id === onboardPrimaryUseCase);
    });
  }

  function syncSecondaryChipUi() {
    var wrap = $('ob-secondary-use-case');
    if (!wrap) return;
    wrap.querySelectorAll('.onboard-chip').forEach(function (b) {
      var t = b.getAttribute('data-secondary-use') || '';
      b.classList.toggle('on', t === onboardSecondaryUseCase);
    });
  }

  function syncReferralChipUi() {
    var ref = onboardRemote && onboardRemote.referral != null ? String(onboardRemote.referral) : '';
    var wrap = $('ob-referral-chips');
    if (!wrap) return;
    wrap.querySelectorAll('.onboard-chip').forEach(function (b) {
      var id = b.getAttribute('data-referral') || '';
      b.classList.toggle('on', ref && id === ref);
    });
  }

  function buildInviteRows() {
    var host = $('ob-invite-rows');
    if (!host) return;
    host.innerHTML = '';
    for (var i = 0; i < 2; i++) {
      var row = document.createElement('div');
      row.className = 'onboard-invite-row';
      row.innerHTML =
        '<input class="fi ob-invite-email" type="email" autocomplete="email" placeholder="name@company.com" />' +
        '<select class="fi ob-invite-role" aria-label="Role">' +
        '<option value="member" selected>Member</option>' +
        '<option value="admin">Admin</option>' +
        '<option value="viewer">Viewer</option>' +
        '</select>';
      host.appendChild(row);
    }
  }

  async function prefillOnboardingWizard(user) {
    onboardSlugManual = false;
    onboardLastInviteUrl = '';
    onboardRemote = null;
    onboardPrimaryUseCase = '';
    onboardSecondaryUseCase = '';
    var meta = (user && user.user_metadata) || {};
    var fnEl = $('ob-first-name');
    var lnEl = $('ob-last-name');
    var emEl = $('ob-email');
    var upEl = $('ob-product-updates');
    var avIn = $('ob-profile-avatar-input');
    var rmBtn = $('ob-profile-avatar-remove');
    if (fnEl) {
      var fn = String(meta.first_name || '').trim();
      var ln = String(meta.last_name || '').trim();
      if (!fn && !ln && meta.full_name) {
        var parts = String(meta.full_name).trim().split(/\s+/);
        fn = parts.shift() || '';
        ln = parts.join(' ') || '';
      }
      fnEl.value = fn;
      lnEl.value = ln;
    }
    if (emEl) emEl.value = (user && user.email) || '';
    if (upEl) upEl.checked = meta.product_updates_opt_in !== false;
    if (avIn) avIn.value = '';
    if (rmBtn) rmBtn.disabled = true;
    if (onboardProfileAvatarObjectUrl) {
      try {
        URL.revokeObjectURL(onboardProfileAvatarObjectUrl);
      } catch (_) {}
      onboardProfileAvatarObjectUrl = null;
    }
    var path = String(meta.profile_avatar_path || '').trim();
    if (path && supabase) {
      try {
        var signed = await withTimeout(
          supabase.storage.from('brand-assets').createSignedUrl(path, 60 * 30),
          ONBOARD_AVATAR_SIGN_MS,
          'avatar_signed_url'
        );
        if (!signed.error && signed.data && signed.data.signedUrl) {
          setOnboardAvatarPreviewImage(signed.data.signedUrl);
          if (rmBtn) rmBtn.disabled = false;
        } else {
          setOnboardAvatarPreviewLetter((user.email || '?').charAt(0).toUpperCase());
        }
      } catch (_) {
        setOnboardAvatarPreviewLetter((user.email || '?').charAt(0).toUpperCase());
      }
    } else {
      setOnboardAvatarPreviewLetter((user && user.email ? user.email.charAt(0) : '?').toUpperCase());
    }

    var cn = $('ob-company-name');
    var sl = $('ob-slug');
    var logoIn = $('ob-company-logo-input');
    var logoWrap = $('ob-company-logo-preview-wrap');
    var logoImg = $('ob-company-logo-preview');
    var bill = $('ob-billing-country');
    if (logoIn) logoIn.value = '';
    if (logoWrap) logoWrap.style.display = 'none';
    if (logoImg) logoImg.removeAttribute('src');
    var orgId = window.currentOrganizationId;
    if (!orgId || !cn || !sl) {
      showOnboardStep(1);
      return;
    }
    var r = await retryOnAuthLock(function () {
      return supabase.from('organizations').select('name,slug,onboarding').eq('id', orgId).maybeSingle();
    });
    if (r.error) {
      var msg = String((r.error && (r.error.message || r.error.details)) || r.error || '');
      if (/onboarding|column|schema cache/i.test(msg)) {
        r = await retryOnAuthLock(function () {
          return supabase.from('organizations').select('name,slug').eq('id', orgId).maybeSingle();
        });
      }
    }
    var ob = {};
    if (r.data && r.data.onboarding != null) {
      if (typeof r.data.onboarding === 'string') {
        try {
          ob = JSON.parse(r.data.onboarding);
        } catch (_) {
          ob = {};
        }
      } else if (typeof r.data.onboarding === 'object') {
        ob = r.data.onboarding;
      }
    }
    onboardRemote = ob && typeof ob === 'object' ? ob : {};
    if (r.data) {
      cn.value = r.data.name || '';
      var suggest = slugifyCompanyToSlug(cn.value);
      sl.value = suggest || String(r.data.slug || '').trim() || '';
    }
    if (bill && onboardRemote.billingCountry) {
      bill.value = String(onboardRemote.billingCountry);
    }
    if (onboardRemote.primaryUseCase) {
      onboardPrimaryUseCase = String(onboardRemote.primaryUseCase);
      renderSecondaryUseCaseChips(onboardPrimaryUseCase);
      syncPrimaryChipUi();
    }
    if (onboardRemote.secondaryUseCase) {
      onboardSecondaryUseCase = String(onboardRemote.secondaryUseCase);
      syncSecondaryChipUi();
    }
    syncReferralChipUi();

    var resumeStep = parseInt(String(onboardRemote.currentStep || ''), 10);
    if (!resumeStep || resumeStep < 1) resumeStep = 1;
    if (resumeStep > 6) resumeStep = 6;
    try {
      if (sessionStorage.getItem('bizdash_post_oauth_onboard_resume') === '1') {
        sessionStorage.removeItem('bizdash_post_oauth_onboard_resume');
        resumeStep = 4;
      }
    } catch (_) {}
    var fnOk = (fnEl && fnEl.value.trim() && lnEl && lnEl.value.trim()) ? true : false;
    if (!fnOk) resumeStep = 1;
    if (resumeStep > 1 && !sl.value.trim()) resumeStep = 1;
    showOnboardStep(resumeStep);
    if (resumeStep === 6) buildInviteRows();
  }

  async function maybeWorkspaceOnboardingThenShowApp(user, needsOnboardingKnown) {
    var needs;
    if (typeof needsOnboardingKnown === 'boolean') {
      needs = needsOnboardingKnown;
    } else {
      needs = await fetchOrgNeedsOnboarding(window.currentOrganizationId);
    }
    if (!needs) {
      showApp(user);
      return;
    }
    var loading = $('auth-loading');
    if (loading) loading.style.display = 'none';
    var shell = $('auth-login-shell');
    if (shell) shell.style.display = 'none';
    await prefillOnboardingWizard(user);
    showOnboardModal();
  }

  function wireOnboardingWizard(user) {
    var modalRoot = $('onboardModal');
    if (!user || !modalRoot || modalRoot.getAttribute('data-wizard-wired') === '1') return;
    modalRoot.setAttribute('data-wizard-wired', '1');

    var avInput = $('ob-profile-avatar-input');
    var avBtn = $('ob-profile-avatar-upload-btn');
    var avRm = $('ob-profile-avatar-remove');
    if (avBtn && avInput) {
      avBtn.addEventListener('click', function () {
        avInput.click();
      });
    }
    if (avInput) {
      avInput.addEventListener('change', function () {
        var f = avInput.files && avInput.files[0];
        var err = $('onboard-error');
        if (err) err.textContent = '';
        if (!f) return;
        if (!/^image\/(png|jpeg|jpg|webp)$/i.test(f.type)) {
          if (err) err.textContent = 'Please choose a PNG, JPEG, or WebP image.';
          avInput.value = '';
          return;
        }
        if (f.size > 10 * 1024 * 1024) {
          if (err) err.textContent = 'Image must be 10MB or smaller.';
          avInput.value = '';
          return;
        }
        if (onboardProfileAvatarObjectUrl) {
          try {
            URL.revokeObjectURL(onboardProfileAvatarObjectUrl);
          } catch (_) {}
        }
        onboardProfileAvatarObjectUrl = URL.createObjectURL(f);
        setOnboardAvatarPreviewImage(onboardProfileAvatarObjectUrl);
        if (avRm) avRm.disabled = false;
      });
    }
    if (avRm && avInput) {
      avRm.addEventListener('click', function () {
        avInput.value = '';
        if (onboardProfileAvatarObjectUrl) {
          try {
            URL.revokeObjectURL(onboardProfileAvatarObjectUrl);
          } catch (_) {}
          onboardProfileAvatarObjectUrl = null;
        }
        setOnboardAvatarPreviewLetter((user.email || '?').charAt(0).toUpperCase());
        avRm.disabled = true;
      });
    }

    var cnEl = $('ob-company-name');
    var slugEl = $('ob-slug');
    if (cnEl && slugEl) {
      cnEl.addEventListener('input', function () {
        if (onboardSlugManual) return;
        slugEl.value = slugifyCompanyToSlug(cnEl.value);
      });
      slugEl.addEventListener('keydown', function () {
        onboardSlugManual = true;
      });
      slugEl.addEventListener('input', function () {
        onboardSlugManual = true;
      });
    }

    var logoIn = $('ob-company-logo-input');
    var logoBtn = $('ob-company-logo-btn');
    var logoWrap = $('ob-company-logo-preview-wrap');
    var logoImg = $('ob-company-logo-preview');
    if (logoBtn && logoIn) {
      logoBtn.addEventListener('click', function () {
        logoIn.click();
      });
    }
    if (logoIn && logoWrap && logoImg) {
      logoIn.addEventListener('change', function () {
        var f = logoIn.files && logoIn.files[0];
        if (!f) return;
        if (!/^image\/(png|jpeg|jpg|webp)$/i.test(f.type)) {
          logoIn.value = '';
          return;
        }
        try {
          logoImg.src = URL.createObjectURL(f);
          logoWrap.style.display = 'flex';
        } catch (_) {}
      });
    }

    var btn1 = $('onboard-step1-continue');
    if (btn1) {
      btn1.addEventListener('click', async function () {
        var err = $('onboard-error');
        if (err) err.textContent = '';
        var fn = ($('ob-first-name') && $('ob-first-name').value.trim()) || '';
        var ln = ($('ob-last-name') && $('ob-last-name').value.trim()) || '';
        if (!fn || !ln) {
          if (err) err.textContent = 'First and last name are required.';
          return;
        }
        try {
          var metaIn = Object.assign({}, (user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {}) || {});
          metaIn.first_name = fn;
          metaIn.last_name = ln;
          metaIn.product_updates_opt_in = !!($('ob-product-updates') && $('ob-product-updates').checked);
          var file = avInput && avInput.files && avInput.files[0];
          if (file && typeof window.bizdashUploadBrandAssetFile === 'function') {
            try {
              var up = await window.bizdashUploadBrandAssetFile(file, user.id, 'profile');
              if (up && up.path) metaIn.profile_avatar_path = up.path;
            } catch (avErr) {
              console.warn('onboard profile avatar upload', avErr);
            }
          }
          var upd = await supabase.auth.updateUser({ data: metaIn });
          if (upd.error) {
            if (err) err.textContent = upd.error.message || 'Could not save your profile.';
            return;
          }
          if (upd.data && upd.data.user) {
            setCurrentUser(upd.data.user);
          }
          var orgIdStep1 = window.currentOrganizationId;
          if (orgIdStep1) {
            var sv1 = await rpcSaveOnboardingProgress(orgIdStep1, { currentStep: 2 });
            if (!sv1.ok) console.warn('save onboarding step', sv1.error);
          }
          showOnboardStep(2);
        } catch (e1) {
          console.error('onboard step1', e1);
          if (err) err.textContent = 'Something went wrong. Try again.';
        }
      });
    }

    renderPrimaryUseCaseChips();

    function goBackToStep(fromStep, toStep) {
      showOnboardStep(toStep);
      var oid = window.currentOrganizationId;
      if (oid) void rpcSaveOnboardingProgress(oid, { currentStep: toStep });
    }

    async function finishOnboardingShowApp(name, ownerFull) {
      if (typeof window.bizdashApplyWorkspaceBrandingFromOnboarding === 'function') {
        try {
          await window.bizdashApplyWorkspaceBrandingFromOnboarding({
            businessName: name || '',
            owner: ownerFull,
            ownerRole: '',
            tagline: '',
            accent:
              typeof window.BIZDASH_DEFAULT_WORKSPACE_ACCENT_HEX === 'string'
                ? window.BIZDASH_DEFAULT_WORKSPACE_ACCENT_HEX
                : '#2563eb',
          });
        } catch (_) {}
      }
      hideOnboardModal();
      showApp(user);
    }

    async function invokeOrganizationTeamInvite(email, role) {
      var orgId = window.currentOrganizationId;
      var base = (typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl : '').replace(/\/$/, '');
      var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey : '';
      var sessRes = await getSessionNow();
      var sess = sessRes && sessRes.data ? sessRes.data.session : null;
      var token = sess && sess.access_token ? sess.access_token : '';
      if (!orgId || !base || !anon || !token) return { ok: false, error: 'Session or workspace missing.' };
      var res = await fetch(base + '/functions/v1/organization-team', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          apikey: anon,
        },
        body: JSON.stringify({
          organizationId: orgId,
          action: 'invite',
          email: String(email || '').trim().toLowerCase(),
          role: role || 'member',
        }),
      });
      var j = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j.ok) {
        return { ok: false, error: j.error ? String(j.error) : 'Invite failed' };
      }
      if (j.inviteUrl) onboardLastInviteUrl = String(j.inviteUrl);
      return { ok: true, inviteUrl: j.inviteUrl ? String(j.inviteUrl) : '' };
    }

    async function startOAuthFromOnboarding(provider) {
      var err = $('onboard-error-4');
      if (err) err.textContent = '';
      var orgId = window.currentOrganizationId;
      var sessRes = await getSessionNow();
      var sess = sessRes && sessRes.data ? sessRes.data.session : null;
      if (!sess || !sess.access_token) {
        if (err) err.textContent = 'Sign in again to connect.';
        return;
      }
      var base = (typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl : '').replace(/\/$/, '');
      var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey : '';
      if (!orgId || !base || !anon) {
        if (err) err.textContent = 'Missing configuration.';
        return;
      }
      var returnPath = window.location.pathname || '/';
      try {
        sessionStorage.setItem('bizdash_oauth_from_onboarding', '1');
      } catch (_) {}
      var fn = provider === 'microsoft' ? 'oauth-microsoft-start' : 'oauth-google-start';
      var res = await fetch(base + '/functions/v1/' + fn, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + sess.access_token,
          apikey: anon,
        },
        body: JSON.stringify({ organization_id: orgId, return_path: returnPath }),
      });
      var j = {};
      try {
        j = await res.json();
      } catch (_) {}
      if (!res.ok || !j.url) {
        try {
          sessionStorage.removeItem('bizdash_oauth_from_onboarding');
        } catch (_) {}
        if (err) err.textContent = j.error ? String(j.error) : 'Could not start sign-in.';
        return;
      }
      window.location.href = String(j.url);
    }

    var back2 = $('onboard-step2-back');
    var back2t = $('onboard-step2-back-top');
    function step2Back() {
      goBackToStep(2, 1);
    }
    if (back2) back2.addEventListener('click', step2Back);
    if (back2t) back2t.addEventListener('click', step2Back);

    var btn2 = $('onboard-step2-continue');
    if (btn2) {
      btn2.addEventListener('click', async function () {
        var err = $('onboard-error-2');
        if (err) err.textContent = '';
        var name = ($('ob-company-name') && $('ob-company-name').value.trim()) || '';
        var slug = ($('ob-slug') && $('ob-slug').value.trim().toLowerCase()) || '';
        var billEl = $('ob-billing-country');
        var billingCountry = billEl && billEl.value ? String(billEl.value) : 'US';
        if (!name) {
          if (err) err.textContent = 'Company name is required.';
          return;
        }
        if (!slugClientValid(slug)) {
          if (err)
            err.textContent =
              'URL slug: 2–63 characters, lowercase letters, numbers, or hyphens; must start with a letter or number.';
          return;
        }
        var orgId = window.currentOrganizationId;
        if (!orgId) {
          if (err) err.textContent = 'No workspace context.';
          return;
        }
        var takenOb = await workspaceSlugTakenByAnotherOrg(slug, orgId);
        if (takenOb.rpcError) {
          if (err) err.textContent = 'Could not verify that URL. Try again.';
          return;
        }
        if (takenOb.taken) {
          if (err) err.textContent = 'That workspace URL is already taken. Choose a different slug.';
          return;
        }
        var prevSlug = window.currentOrganizationSlug;
        try {
          var rpcRes = await supabase.rpc('update_workspace_profile', {
            p_org_id: orgId,
            p_name: name,
            p_slug: slug,
          });
          var payload = parseRpcJson(rpcRes.data);
          if (rpcRes.error || !payload || typeof payload !== 'object') {
            if (err) err.textContent = rpcRes.error ? String(rpcRes.error.message || rpcRes.error) : 'Could not save workspace.';
            return;
          }
          if (!payload.ok) {
            if (err) err.textContent = payload.error ? String(payload.error) : 'Could not save workspace.';
            return;
          }
          var newSlug = payload.slug ? String(payload.slug) : slug;
          setOrgContext(orgId, newSlug, window.currentOrganizationRole);
          if (prevSlug && newSlug && String(prevSlug).toLowerCase() !== String(newSlug).toLowerCase()) {
            replaceBrowserPathForSlug(newSlug);
          }
          var logoFile = logoIn && logoIn.files && logoIn.files[0];
          if (logoFile && typeof window.bizdashUploadBrandAssetFile === 'function' && typeof window.bizdashApplyBrandLogoToShell === 'function') {
            try {
              var upL = await window.bizdashUploadBrandAssetFile(logoFile, orgId, 'light');
              if (upL && upL.signedUrl) {
                window.bizdashApplyBrandLogoToShell(upL.signedUrl, '');
              }
            } catch (logoErr) {
              console.warn('onboard logo upload', logoErr);
            }
          }
          var sv = await rpcSaveOnboardingProgress(orgId, {
            currentStep: 3,
            billingCountry: billingCountry,
          });
          if (!sv.ok && err) err.textContent = sv.error || 'Could not save progress.';
          if (sv.ok) showOnboardStep(3);
        } catch (e2) {
          console.error('onboard step2', e2);
          if (err) err.textContent = 'Could not save workspace. If this persists, confirm the database migration ran.';
        }
      });
    }

    var refWrap = $('ob-referral-chips');
    if (refWrap) {
      refWrap.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute || !t.classList || !t.classList.contains('onboard-chip')) return;
        var id = t.getAttribute('data-referral');
        refWrap.querySelectorAll('.onboard-chip').forEach(function (b) {
          b.classList.remove('on');
        });
        if (id) {
          t.classList.add('on');
          onboardRemote = onboardRemote || {};
          onboardRemote.referral = id;
        }
      });
    }

    var b3 = $('onboard-step3-continue');
    if (b3) {
      b3.addEventListener('click', async function () {
        var err = $('onboard-error-3');
        if (err) err.textContent = '';
        var orgId = window.currentOrganizationId;
        var refSel = refWrap && refWrap.querySelector('.onboard-chip.on');
        var refVal = refSel && refSel.getAttribute('data-referral') ? String(refSel.getAttribute('data-referral')) : null;
        var sv = await rpcSaveOnboardingProgress(orgId, { currentStep: 4, referral: refVal });
        if (!sv.ok) {
          if (err) err.textContent = sv.error || 'Could not save.';
          return;
        }
        showOnboardStep(4);
      });
    }
    var b3s = $('onboard-step3-skip');
    if (b3s) {
      b3s.addEventListener('click', async function () {
        var err = $('onboard-error-3');
        if (err) err.textContent = '';
        var orgId = window.currentOrganizationId;
        var sv = await rpcSaveOnboardingProgress(orgId, { currentStep: 4, referral: null });
        if (!sv.ok) {
          if (err) err.textContent = sv.error || 'Could not save.';
          return;
        }
        if (refWrap) refWrap.querySelectorAll('.onboard-chip').forEach(function (b) { b.classList.remove('on'); });
        showOnboardStep(4);
      });
    }

    var b3back = $('onboard-step3-back-top');
    if (b3back) b3back.addEventListener('click', function () { goBackToStep(3, 2); });

    var og = $('onboard-oauth-google');
    if (og) og.addEventListener('click', function () { startOAuthFromOnboarding('google'); });
    var om = $('onboard-oauth-microsoft');
    if (om) om.addEventListener('click', function () { startOAuthFromOnboarding('microsoft'); });

    function advanceFromStep4() {
      var orgId = window.currentOrganizationId;
      rpcSaveOnboardingProgress(orgId, { currentStep: 5 }).then(function (sv) {
        if (!sv.ok) {
          var err = $('onboard-error-4');
          if (err) err.textContent = sv.error || 'Could not save.';
          return;
        }
        showOnboardStep(5);
      });
    }
    var b4c = $('onboard-step4-continue');
    if (b4c) b4c.addEventListener('click', advanceFromStep4);
    var b4m = $('onboard-step4-manual');
    if (b4m) b4m.addEventListener('click', advanceFromStep4);
    var b4back = $('onboard-step4-back-top');
    if (b4back) b4back.addEventListener('click', function () { goBackToStep(4, 3); });

    var pwrap = $('ob-primary-use-case');
    if (pwrap) {
      pwrap.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute || !t.classList || !t.classList.contains('onboard-chip')) return;
        var id = t.getAttribute('data-primary-use');
        if (!id) return;
        onboardPrimaryUseCase = id;
        onboardSecondaryUseCase = '';
        syncPrimaryChipUi();
        renderSecondaryUseCaseChips(id);
        syncSecondaryChipUi();
      });
    }
    var swrap = $('ob-secondary-use-case');
    if (swrap) {
      swrap.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.getAttribute || !t.classList || !t.classList.contains('onboard-chip')) return;
        var lab = t.getAttribute('data-secondary-use');
        onboardSecondaryUseCase = lab ? String(lab) : '';
        syncSecondaryChipUi();
      });
    }
    var b5 = $('onboard-step5-continue');
    if (b5) {
      b5.addEventListener('click', async function () {
        var err = $('onboard-error-5');
        if (err) err.textContent = '';
        if (!onboardPrimaryUseCase) {
          if (err) err.textContent = 'Choose how you will use this workspace.';
          return;
        }
        var orgId = window.currentOrganizationId;
        var patch = {
          currentStep: 6,
          primaryUseCase: onboardPrimaryUseCase,
          secondaryUseCase: onboardSecondaryUseCase || null,
        };
        var sv = await rpcSaveOnboardingProgress(orgId, patch);
        if (!sv.ok) {
          if (err) err.textContent = sv.error || 'Could not save.';
          return;
        }
        buildInviteRows();
        showOnboardStep(6);
      });
    }
    var b5back = $('onboard-step5-back-top');
    if (b5back) b5back.addEventListener('click', function () { goBackToStep(5, 4); });

    var addInv = $('ob-invite-add-row');
    if (addInv) {
      addInv.addEventListener('click', function () {
        var host = $('ob-invite-rows');
        if (!host) return;
        var row = document.createElement('div');
        row.className = 'onboard-invite-row';
        row.innerHTML =
          '<input class="fi ob-invite-email" type="email" autocomplete="email" placeholder="name@company.com" />' +
          '<select class="fi ob-invite-role" aria-label="Role">' +
          '<option value="member" selected>Member</option>' +
          '<option value="admin">Admin</option>' +
          '<option value="viewer">Viewer</option>' +
          '</select>';
        host.appendChild(row);
      });
    }
    var copyInv = $('ob-invite-copy-link');
    if (copyInv) {
      copyInv.addEventListener('click', async function () {
        var err = $('onboard-error-6');
        if (err) err.textContent = '';
        var emails = [];
        document.querySelectorAll('.ob-invite-email').forEach(function (inp) {
          var v = (inp.value || '').trim().toLowerCase();
          if (v) emails.push(v);
        });
        if (!emails.length) {
          if (err) err.textContent = 'Enter at least one email to generate an invite link.';
          return;
        }
        var r = await invokeOrganizationTeamInvite(emails[0], 'member');
        if (!r.ok) {
          if (err) err.textContent = r.error || 'Could not create link.';
          return;
        }
        var url = r.inviteUrl || onboardLastInviteUrl;
        try {
          await navigator.clipboard.writeText(url);
        } catch (_) {
          if (err) err.textContent = 'Link created but clipboard failed. Copy manually: ' + url;
          return;
        }
        if (err) err.textContent = 'Invite link copied to clipboard.';
      });
    }
    var b6 = $('onboard-step6-send');
    if (b6) {
      b6.addEventListener('click', async function () {
        var err = $('onboard-error-6');
        if (err) err.textContent = '';
        var orgId = window.currentOrganizationId;
        var name = ($('ob-company-name') && $('ob-company-name').value.trim()) || '';
        var fn = ($('ob-first-name') && $('ob-first-name').value.trim()) || '';
        var ln = ($('ob-last-name') && $('ob-last-name').value.trim()) || '';
        var ownerFull = (fn + ' ' + ln).trim();
        var rows = document.querySelectorAll('.onboard-invite-row');
        var anySent = false;
        for (var i = 0; i < rows.length; i++) {
          var em = rows[i].querySelector('.ob-invite-email');
          var ro = rows[i].querySelector('.ob-invite-role');
          var ev = em && em.value ? String(em.value).trim().toLowerCase() : '';
          if (!ev) continue;
          var role = ro && ro.value ? String(ro.value) : 'member';
          var inv = await invokeOrganizationTeamInvite(ev, role);
          if (!inv.ok) {
            if (err) err.textContent = inv.error || 'Invite failed for ' + ev;
            return;
          }
          anySent = true;
        }
        var fin = await rpcCompleteWorkspaceOnboarding(orgId, { teamInvitesSent: anySent });
        if (!fin.ok) {
          if (err) err.textContent = fin.error || 'Could not finish setup.';
          return;
        }
        await finishOnboardingShowApp(name, ownerFull);
      });
    }
    var b6s = $('onboard-step6-skip');
    if (b6s) {
      b6s.addEventListener('click', async function () {
        var err = $('onboard-error-6');
        if (err) err.textContent = '';
        var orgId = window.currentOrganizationId;
        var name = ($('ob-company-name') && $('ob-company-name').value.trim()) || '';
        var fn = ($('ob-first-name') && $('ob-first-name').value.trim()) || '';
        var ln = ($('ob-last-name') && $('ob-last-name').value.trim()) || '';
        var ownerFull = (fn + ' ' + ln).trim();
        var fin = await rpcCompleteWorkspaceOnboarding(orgId, { teamInvitesSent: false });
        if (!fin.ok) {
          if (err) err.textContent = fin.error || 'Could not finish setup.';
          return;
        }
        await finishOnboardingShowApp(name, ownerFull);
      });
    }
    var b6back = $('onboard-step6-back-top');
    if (b6back) b6back.addEventListener('click', function () { goBackToStep(6, 5); });
  }

  function renderWorkspaceList(rows) {
    var list = $('workspace-list');
    if (!list) return;
    if (!rows || !rows.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text2);">No workspaces found.</div>';
      return;
    }
    var cur = (window.currentOrganizationSlug || '').toLowerCase();
    list.innerHTML = rows
      .map(function (r) {
        var sl = String(r.slug || '');
        var nm = String(r.name || sl);
        var ro = String(r.role || 'member');
        var isHere = sl.toLowerCase() === cur;
        return (
          '<div class="workspace-row" data-slug="' +
          escHtml(sl) +
          '" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;cursor:pointer;background:' +
          (isHere ? 'var(--bg3)' : 'var(--bg2)') +
          ';">' +
          '<div><div style="font-weight:600;font-size:14px;">' +
          escHtml(nm) +
          '</div><div style="font-size:12px;color:var(--text3);">/' +
          escHtml(sl) +
          ' · ' +
          escHtml(ro) +
          '</div></div>' +
          (isHere ? '<span style="font-size:12px;color:var(--text3);">Current</span>' : '<span style="font-size:12px;color:var(--coral);">Open</span>') +
          '</div>'
        );
      })
      .join('');
    list.querySelectorAll('.workspace-row').forEach(function (el) {
      el.addEventListener('click', function () {
        var sl = el.getAttribute('data-slug');
        if (!sl) return;
        window.location.assign('/' + sl + '/' + (window.location.search || ''));
      });
    });
  }

  async function refreshWorkspaceModalList() {
    var sessRes;
    try {
      sessRes = await getSessionNow();
    } catch (_) {
      renderWorkspaceList([]);
      return;
    }
    var u = sessRes && sessRes.data && sessRes.data.session && sessRes.data.session.user;
    if (!u) return;
    var listRes = await retryOnAuthLock(function () {
      return supabase.rpc('my_organizations');
    });
    if (listRes.error || !listRes.data) {
      renderWorkspaceList([]);
      return;
    }
    renderWorkspaceList(listRes.data);
  }

  function wireWorkspaceModal() {
    var closeBtn = $('btn-workspace-modal-close');
    if (closeBtn && closeBtn.getAttribute('data-wired') !== '1') {
      closeBtn.setAttribute('data-wired', '1');
      closeBtn.addEventListener('click', function () {
        var m = $('workspaceModal');
        if (m) m.classList.remove('on');
      });
    }
    var addBtn = $('btn-workspace-add-another');
    var panel = $('workspace-add-panel');
    var createBtn = $('btn-workspace-create-submit');
    var cancelBtn = $('btn-workspace-add-cancel');
    if (addBtn && addBtn.getAttribute('data-wired') !== '1') {
      addBtn.setAttribute('data-wired', '1');
      addBtn.addEventListener('click', function () {
        if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
    }
    if (cancelBtn && cancelBtn.getAttribute('data-wired') !== '1') {
      cancelBtn.setAttribute('data-wired', '1');
      cancelBtn.addEventListener('click', function () {
        if (panel) panel.style.display = 'none';
      });
    }
    if (createBtn && createBtn.getAttribute('data-wired') !== '1') {
      createBtn.setAttribute('data-wired', '1');
      createBtn.addEventListener('click', async function () {
        var err = $('workspace-add-error');
        if (err) err.textContent = '';
        var nm = ($('ws-new-name') && $('ws-new-name').value.trim()) || '';
        var sl = ($('ws-new-slug') && $('ws-new-slug').value.trim().toLowerCase()) || '';
        if (!nm) {
          if (err) err.textContent = 'Workspace name is required.';
          return;
        }
        if (!slugClientValid(sl)) {
          if (err)
            err.textContent =
              'URL slug: 2–63 characters, lowercase letters, numbers, or hyphens; must start with a letter or number.';
          return;
        }
        var takenWs = await workspaceSlugTakenByAnotherOrg(sl, null);
        if (takenWs.rpcError) {
          if (err) err.textContent = 'Could not verify that URL. Try again.';
          return;
        }
        if (takenWs.taken) {
          if (err) err.textContent = 'That workspace URL is already taken. Choose a different slug.';
          return;
        }
        var rpcRes = await supabase.rpc('create_workspace_for_user', { p_name: nm, p_slug: sl });
        var payload = rpcRes.data;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch (_) {}
        }
        if (rpcRes.error || !payload || typeof payload !== 'object' || !payload.ok) {
          if (err) err.textContent = payload && payload.error ? String(payload.error) : 'Could not create workspace.';
          return;
        }
        var newSlug = payload.slug ? String(payload.slug) : sl;
        window.location.assign('/' + newSlug + '/' + (window.location.search || ''));
      });
    }
  }

  window.openWorkspaceSwitcherModal = async function () {
    var m = $('workspaceModal');
    var panel = $('workspace-add-panel');
    if (panel) panel.style.display = 'none';
    var err = $('workspace-add-error');
    if (err) err.textContent = '';
    wireWorkspaceModal();
    await refreshWorkspaceModalList();
    if (m) m.classList.add('on');
  };

  function setCurrentUser(user) {
    var prevUser = window.currentUser || null;
    var nextUser = user || null;
    window.currentUser = nextUser;
    var prevId = prevUser && prevUser.id ? prevUser.id : null;
    var nextId = nextUser && nextUser.id ? nextUser.id : null;
    if (prevId !== nextId && typeof window.clearRuntimeDataForAuthChange === 'function') {
      window.clearRuntimeDataForAuthChange(nextUser);
    }
  }

  function showLoading() {
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    bizDashHideDashboardDataLoading();
    if (loading) loading.style.display = 'flex';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.remove('on');
  }

  function showLogin() {
    clearStableAppUserMarker();
    var obM = $('onboardModal');
    if (obM) {
      obM.removeAttribute('data-wizard-wired');
      obM.classList.remove('on');
    }
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    bizDashHideDashboardDataLoading();
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'flex';
    if (app) app.classList.remove('on');
    updateGateInviteHint();
    void refreshLoginShellBrandingFromUrl();
  }

  window.__dashboardShowLogin = showLogin;

  var authRecoveryMode = false;
  window.__bizdashIsAuthRecoveryMode = function () {
    return authRecoveryMode;
  };
  /** Recovery / sign-in labels are owned by React (`auth-login-gate.tsx`); this only syncs the flag. */
  function setAuthRecoveryMode(on) {
    authRecoveryMode = !!on;
    try {
      window.dispatchEvent(new CustomEvent('bizdash-auth-recovery-mode', { detail: { on: authRecoveryMode } }));
    } catch (_) {}
  }

  function notifyAuthGateLoggedOut() {
    try {
      window.dispatchEvent(new CustomEvent('bizdash-auth-logged-out'));
    } catch (_) {}
  }

  /**
   * GoTrue often emits SIGNED_IN again on tab focus (visibility) even when nothing changed.
   * `window.currentUser` can be missing or stale vs `session.user`, so we also remember the
   * last user id we successfully showed in #app-shell and skip the loading gate when it matches.
   */
  var lastStableAppUserId = null;

  function clearStableAppUserMarker() {
    lastStableAppUserId = null;
  }

  function markStableAppUser(user) {
    if (user && user.id != null && String(user.id) !== '') {
      lastStableAppUserId = String(user.id);
    } else {
      lastStableAppUserId = null;
    }
  }

  function isDemoDashboardUserId(userId) {
    var demoId = window.DEMO_DASHBOARD_USER_ID || '00000000-0000-4000-8000-000000000001';
    return userId != null && String(userId) === String(demoId);
  }

  function hasResolvedWorkspaceContext(session) {
    if (!session || !session.user) return false;
    if (isDemoDashboardUserId(session.user.id)) return true;
    var oid = window.currentOrganizationId;
    return !!(oid && String(oid).trim());
  }

  function shouldSkipSessionReflow(session) {
    if (!session || !session.user || session.user.id == null) return false;
    var sid = String(session.user.id);
    var app = $('app-shell');
    if (!app || !app.classList.contains('on')) return false;
    var sameStable = (lastStableAppUserId && lastStableAppUserId === sid) || (function () {
      var cu = window.currentUser && window.currentUser.id != null ? String(window.currentUser.id) : '';
      return !!cu && cu === sid;
    })();
    if (!sameStable) return false;
    // Never treat the shell as "fully resumed" for real accounts without org id — otherwise we skip
    // runAuthSessionFlow and never reattach workspace context or reload cloud data.
    return hasResolvedWorkspaceContext(session);
  }

  function shouldSkipSessionReflowForUser(user) {
    if (!user || user.id == null) return false;
    return shouldSkipSessionReflow({ user: user });
  }

  function isAppVisible() {
    var app = $('app-shell');
    return !!(app && app.classList && app.classList.contains('on'));
  }

  /**
   * True while first-run onboarding is active OR while we are between wireOnboardingWizard and showOnboardModal
   * (prefillOnboardingWizard await). In that window the modal may not have class "on" yet, but we must not re-enter
   * runAuthSessionFlow — duplicate INITIAL_SESSION / USER_UPDATED / SIGNED_IN would call showLoading() and time out.
   * Once #app-shell is on (dashboard), we are never in this phase.
   */
  function isOnboardingOrPrefillPhase() {
    var app = $('app-shell');
    if (app && app.classList && app.classList.contains('on')) return false;
    var ob = $('onboardModal');
    if (!ob) return false;
    if (ob.classList && ob.classList.contains('on')) return true;
    return ob.getAttribute('data-wizard-wired') === '1';
  }

  /** In-flight session resolution so bootstrap + INITIAL_SESSION do not run two flows in parallel. */
  var sessionFlowPromise = null;

  /**
   * Resolve org context, optional onboarding modal, then show the app (or login on failure).
   * Used from bootstrap and from auth events (including INITIAL_SESSION; deduped with bootstrap).
   */
  async function runAuthSessionFlow(user, authSession) {
    if (!user || !user.id) {
      clearOrgContext();
      setCurrentUser(null);
      showLogin();
      notifyAuthGateLoggedOut();
      return;
    }
    if (shouldSkipSessionReflowForUser(user)) {
      setCurrentUser(user);
      return;
    }
    if (sessionFlowPromise) {
      return sessionFlowPromise;
    }
    sessionFlowPromise = (async function () {
      try {
        setCurrentUser(user);
        /*
         * Re-entrant runAuthSessionFlow (duplicate auth events while onboarding) must not call
         * showLoading() + resolveOrgContextWithRetry again — that produced "Loading workspace timed out"
         * and /auth/v1/token noise even when org + URL slug were already correct.
         */
        var pathSlugEarly = parseTenantSlug();
        var curSlugEarly = (window.currentOrganizationSlug || '').toLowerCase();
        var slugMatchesEarly =
          !pathSlugEarly ||
          !curSlugEarly ||
          String(pathSlugEarly).toLowerCase() === curSlugEarly;
        if (
          slugMatchesEarly &&
          hasResolvedWorkspaceContext(authSession) &&
          isOnboardingOrPrefillPhase() &&
          window.currentUser &&
          String(window.currentUser.id) === String(user.id)
        ) {
          var loadFp = $('auth-loading');
          if (loadFp) loadFp.style.display = 'none';
          wireOnboardingWizard(user);
          var needsKnown = await fetchOrgNeedsOnboarding(window.currentOrganizationId);
          await withTimeout(
            maybeWorkspaceOnboardingThenShowApp(user, needsKnown),
            ONBOARDING_GATE_MS,
            'Could not finish workspace setup. Try signing in again.'
          );
          return;
        }
        showLoading();
        var ctx = await resolveOrgContextWithRetry(user, authSession);
        if (!ctx || !ctx.ok) {
          if (isAppVisible()) {
            setCurrentUser(user);
            return;
          }
          setCurrentUser(null);
          showLogin();
          notifyAuthGateLoggedOut();
          return;
        }
        var loadingAfterResolve = $('auth-loading');
        if (loadingAfterResolve) loadingAfterResolve.style.display = 'none';
        wireOnboardingWizard(user);
        await withTimeout(
          maybeWorkspaceOnboardingThenShowApp(user, ctx.needsOnboarding),
          ONBOARDING_GATE_MS,
          'Could not finish workspace setup. Try signing in again.'
        );
      } catch (err) {
        console.error('runAuthSessionFlow', err);
        if (isAppVisible()) {
          setCurrentUser(user);
          return;
        }
        setCurrentUser(null);
        clearOrgContext();
        var ge = $('gate-auth-error');
        if (ge && err && err.message) ge.textContent = String(err.message);
        showLogin();
        notifyAuthGateLoggedOut();
      } finally {
        sessionFlowPromise = null;
      }
    })();
    return sessionFlowPromise;
  }

  function showDemoDashboard() {
    clearOrgContext();
    var demoId = window.DEMO_DASHBOARD_USER_ID || '00000000-0000-4000-8000-000000000001';
    var demoUser = { id: demoId, email: 'demo@preview.local', app_metadata: {}, user_metadata: {} };
    setCurrentUser(demoUser);
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    bizDashHideDashboardDataLoading();
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.add('on');
    markStableAppUser(demoUser);
    var nameEl = $('user-name');
    var roleEl = $('user-role');
    var avatarEl = $('user-avatar');
    if (nameEl) nameEl.textContent = 'Demo';
    if (roleEl) roleEl.textContent = 'Preview';
    if (avatarEl) avatarEl.textContent = 'D';
    if (typeof window.loadScreenshotMockData === 'function') {
      window.loadScreenshotMockData();
    } else {
      console.error('financial-core: loadScreenshotMockData not available (script order?)');
    }
    if (typeof window.nav === 'function') {
      var dashNavDemo = document.querySelector('.ni[data-nav="dashboard"]');
      window.nav('dashboard', dashNavDemo || null);
    }
  }

  /**
   * Sidebar account circle (#user-avatar): cloud path on brand-assets, else email initial.
   * When Settings stores a data URL in localStorage, financial-core's applyWorkspaceChromeProfileAvatar overlays it.
   */
  function bizdashApplyAuthUserAvatarChrome(user) {
    var avatarEl = document.getElementById('user-avatar');
    if (!avatarEl || !user) return;
    avatarEl.innerHTML = '';
    var metaU = (user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {}) || {};
    var avPath = String(metaU.profile_avatar_path || '').trim();
    var client = supabase || window.supabaseClient;
    if (avPath && client) {
      client.storage
        .from('brand-assets')
        .createSignedUrl(avPath, 60 * 60 * 24)
        .then(function (res) {
          if (!res.data || !res.data.signedUrl || !avatarEl) return;
          avatarEl.innerHTML = '';
          var im = document.createElement('img');
          im.src = res.data.signedUrl;
          im.alt = '';
          im.width = 26;
          im.height = 26;
          im.style.borderRadius = '50%';
          im.style.objectFit = 'cover';
          im.style.display = 'block';
          avatarEl.appendChild(im);
        })
        .catch(function () {
          if (avatarEl && user.email) {
            avatarEl.textContent = user.email.charAt(0).toUpperCase();
          }
        });
    } else if (user.email) {
      avatarEl.textContent = user.email.charAt(0).toUpperCase();
    }
  }
  window.bizdashApplyAuthUserAvatarChrome = bizdashApplyAuthUserAvatarChrome;

  function showApp(user) {
    hideOnboardModal();
    var obM = $('onboardModal');
    if (obM) obM.removeAttribute('data-wizard-wired');
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    var uid = user && user.id != null ? String(user.id) : '';
    var dashboardWarmBoot =
      !!(
        app &&
        app.classList.contains('on') &&
        uid &&
        lastStableAppUserId === uid &&
        user &&
        !isDemoDashboardUserId(user.id)
      );
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.add('on');
    markStableAppUser(user);

    if (user && !isDemoDashboardUserId(user.id) && !dashboardWarmBoot) {
      bizDashShowDashboardDataLoading();
    }

    if (user) {
      var nameEl = document.getElementById('user-name');
      var roleEl = document.getElementById('user-role');
      var metaU = (user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {}) || {};
      if (nameEl) {
        var dispN = [String(metaU.first_name || '').trim(), String(metaU.last_name || '').trim()].filter(Boolean).join(' ').trim();
        nameEl.textContent = dispN || user.email || 'Signed in';
      }
      if (roleEl) {
        var rr = window.currentOrganizationRole;
        roleEl.textContent = rr ? String(rr).charAt(0).toUpperCase() + String(rr).slice(1) : 'Member';
      }
    }

    drainInviteFlashIntoApp();

    if (dashboardWarmBoot) {
      if (typeof window.bizdashRefreshSidebarProfileAvatars === 'function') {
        window.bizdashRefreshSidebarProfileAvatars();
      } else if (user) {
        bizdashApplyAuthUserAvatarChrome(user);
      }
      return;
    }

    // showLogin() hides #app-shell but does not reset `.pg.on`; resume on the dashboard after auth/demo entry.
    if (typeof window.nav === 'function') {
      var dashNav = document.querySelector('.ni[data-nav="dashboard"]');
      window.nav('dashboard', dashNav || null);
    }

    requestAnimationFrame(function () {
      var initP = null;
      try {
        if (window.initDataFromSupabase) initP = window.initDataFromSupabase();
      } catch (_) {}
      function hideDashboardBoot() {
        try {
          bizDashHideDashboardDataLoading();
        } catch (_) {}
      }
      if (initP && typeof initP.finally === 'function') {
        initP.finally(hideDashboardBoot);
      } else {
        hideDashboardBoot();
      }
    });
    if (typeof window.bizdashRefreshSidebarProfileAvatars === 'function') {
      window.bizdashRefreshSidebarProfileAvatars();
    } else if (user) {
      bizdashApplyAuthUserAvatarChrome(user);
    }
  }

  /**
   * Supabase v2 fires INITIAL_SESSION on the next tick when a session exists in storage.
   * That is the canonical startup hook — no separate bootstrapSession() needed.
   * We show the loading screen now so there is no flash of the login form.
   */
  showLoading();

  supabase.auth.onAuthStateChange(async function (event, session) {
    if (event === 'SIGNED_OUT') {
      setAuthRecoveryMode(false);
      clearOrgContext();
      setCurrentUser(null);
      showLogin();
      notifyAuthGateLoggedOut();
      return;
    }

    if (event === 'PASSWORD_RECOVERY') {
      showLogin();
      setAuthRecoveryMode(true);
      return;
    }

    if (event === 'INITIAL_SESSION') {
      if (!session || !session.user) {
        setAuthRecoveryMode(false);
        showLogin();
        notifyAuthGateLoggedOut();
        return;
      }
      if (shouldSkipSessionReflow(session)) {
        setCurrentUser(session.user);
        return;
      }
      if (hasResolvedWorkspaceContext(session) && isOnboardingOrPrefillPhase()) {
        setCurrentUser(session.user);
        return;
      }
      try {
        if (typeof window.setBizdashScreenshotNoCloud === 'function') {
          window.setBizdashScreenshotNoCloud(false);
        }
      } catch (_) {}
      await runAuthSessionFlow(session.user, session);
      return;
    }

    if (!session || !session.user) {
      setAuthRecoveryMode(false);
      clearOrgContext();
      setCurrentUser(null);
      showLogin();
      notifyAuthGateLoggedOut();
      return;
    }

    try {
      if (typeof window.setBizdashScreenshotNoCloud === 'function') {
        window.setBizdashScreenshotNoCloud(false);
      }
    } catch (_) {}

    if (event === 'TOKEN_REFRESHED') {
      setCurrentUser(session.user);
      // Session token rotation must not replay the cold-boot path: full-screen loader + initDataFromSupabase
      // blocks the UI and feels like the app "reloaded". When the shell is already up for this user, stop here.
      if (shouldSkipSessionReflow(session)) {
        return;
      }
      // Avoid showApp + initData before org resolution finishes (setCurrentUser runs early in runAuthSessionFlow).
      // While the onboarding wizard is open, app-shell is off — showApp would hide the modal and strand the user.
      if (hasResolvedWorkspaceContext(session) && !isOnboardingOrPrefillPhase()) {
        showApp(session.user);
      }
      return;
    }

    /* Tab focus: GoTrue may emit SIGNED_IN / INITIAL_SESSION again without a real auth change. */
    if (shouldSkipSessionReflow(session)) {
      setCurrentUser(session.user);
      return;
    }

    /*
     * updateUser (onboarding step 1 profile) emits USER_UPDATED / SIGNED_IN without app-shell on yet.
     * Re-running runAuthSessionFlow would showLoading(), tear down UI, and re-hit my_organizations — often slow
     * enough to hit ORG_RESOLVE_MS or confuse token refresh (400 on /token in the network panel).
     * isOnboardingOrPrefillPhase also covers the gap after wireOnboardingWizard before showOnboardModal (prefill await).
     */
    if (hasResolvedWorkspaceContext(session) && isOnboardingOrPrefillPhase()) {
      setCurrentUser(session.user);
      return;
    }

    await runAuthSessionFlow(session.user, session);
  });

  var authGateReactRootWired = false;

  function clearOAuthRelatedGateHints() {
    var hint = $('gate-signup-email-hint');
    var btnR = $('gate-resend-confirm');
    if (hint) hint.style.display = 'none';
    if (btnR) btnR.style.display = 'none';
    var confirmWrap = $('gate-confirm-wrap');
    var confirmInput = $('gate-confirm-password');
    if (confirmWrap && !authRecoveryMode) confirmWrap.style.display = 'none';
    if (confirmInput && !authRecoveryMode) confirmInput.value = '';
  }

  function closestGateEl(target, id) {
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest('#' + id);
  }

  /**
   * OAuth, View demo, and email/password controls are delegated from `#auth-login-react-root` so
   * React can remount provider/email steps without losing listeners (per-button wiring only ran once).
   */
  function wireAuthGateReactRootDelegated() {
    if (authGateReactRootWired) return;
    var root = $('auth-login-react-root');
    if (!root) {
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(wireAuthGateReactRootDelegated);
      } else {
        setTimeout(wireAuthGateReactRootDelegated, 0);
      }
      return;
    }
    authGateReactRootWired = true;

    function authEmailRedirectTo() {
      try {
        return (window.location.href || '').split('#')[0];
      } catch (_) {
        return (window.location.origin || '') + '/';
      }
    }

    function setSignupEmailDeliverabilityHint(visible) {
      var hint = $('gate-signup-email-hint');
      var btnR = $('gate-resend-confirm');
      var dis = visible ? '' : 'none';
      if (hint) hint.style.display = dis;
      if (btnR) btnR.style.display = dis;
    }

    function setGateAuthError(msg) {
      var ge = $('gate-auth-error');
      if (ge) ge.textContent = msg || '';
    }

    /** Inline confirm row is for password recovery only (sign up is the inline React step in `auth-login-gate.tsx`). */
    function setSignupMode(_on) {
      void _on;
      var confirmWrap = $('gate-confirm-wrap');
      var confirmInput = $('gate-confirm-password');
      if (confirmWrap) confirmWrap.style.display = authRecoveryMode ? 'flex' : 'none';
      if (!authRecoveryMode && confirmInput) confirmInput.value = '';
    }

    async function handleOAuthClick(provider, label) {
      clearOAuthRelatedGateHints();
      setGateAuthError('');
      try {
        if (typeof window.setBizdashScreenshotNoCloud === 'function') {
          window.setBizdashScreenshotNoCloud(false);
        }
      } catch (_) {}
      try {
        var path = window.location.pathname || '/';
        var search = window.location.search || '';
        var redirectTo = window.location.origin + path + search;
        var res = await supabase.auth.signInWithOAuth({
          provider: provider,
          options: {
            redirectTo: redirectTo,
          },
        });
        if (res.error) {
          setGateAuthError(res.error.message || label + ' sign-in failed.');
          return;
        }
        var oauthUrl = res.data && res.data.url ? String(res.data.url) : '';
        if (oauthUrl) {
          window.location.href = oauthUrl;
          return;
        }
        setGateAuthError('Could not start ' + label + ' sign-in (missing redirect URL).');
      } catch (err) {
        console.error(provider + ' auth error', err);
        setGateAuthError('Unexpected error starting ' + label + ' sign-in.');
      }
    }

    async function handleGateSigninClick() {
      var emailInput = $('gate-email');
      var passwordInput = $('gate-password');
      var confirmInput = $('gate-confirm-password');
      if (!authRecoveryMode) setSignupMode(false);
      var email = emailInput && emailInput.value.trim();
      var password = passwordInput && passwordInput.value;
      setGateAuthError('');
      setSignupEmailDeliverabilityHint(false);
      if (authRecoveryMode) {
        var confirmPasswordRecovery = confirmInput && confirmInput.value;
        if (!password) {
          setGateAuthError('New password is required.');
          return;
        }
        if (!confirmPasswordRecovery) {
          setGateAuthError('Please confirm your new password.');
          return;
        }
        if (password !== confirmPasswordRecovery) {
          setGateAuthError('Passwords do not match.');
          return;
        }
        try {
          var upd = await supabase.auth.updateUser({ password: password });
          if (upd.error) {
            setGateAuthError(upd.error.message || 'Could not update password.');
            return;
          }
          setAuthRecoveryMode(false);
          if (confirmInput) confirmInput.value = '';
          if (passwordInput) passwordInput.value = '';
          setGateAuthError('Password updated. You can sign in with your new password.');
          try {
            await supabase.auth.signOut();
          } catch (_) {}
          showLogin();
        } catch (errRecovery) {
          console.error('password update error', errRecovery);
          setGateAuthError('Unexpected error updating password.');
        }
        return;
      }
      if (!email || !password) {
        setGateAuthError('Email and password are required.');
        return;
      }
      try {
        var res = await supabase.auth.signInWithPassword({ email: email, password: password });
        if (res.error) {
          setGateAuthError(res.error.message || 'Could not sign in.');
          return;
        }
        var signedUser = res.data && res.data.user;
        if (signedUser && signedUser.email && !signedUser.email_confirmed_at) {
          try {
            await supabase.auth.signOut();
          } catch (_) {}
          setGateAuthError('Confirm your email before signing in. Use the link we sent to your inbox (check spam).');
          return;
        }
        try {
          if (typeof window.setBizdashScreenshotNoCloud === 'function') {
            window.setBizdashScreenshotNoCloud(false);
          }
        } catch (_) {}
        setCurrentUser(res.data.user);
      } catch (err) {
        console.error('signIn error', err);
        setGateAuthError('Unexpected error signing in.');
      }
    }

    async function handleGateResendClick() {
      var emailInput = $('gate-email');
      var email = emailInput && emailInput.value ? emailInput.value.trim() : '';
      if (!email) {
        setGateAuthError('Enter the email you signed up with, then click Resend confirmation email.');
        return;
      }
      setGateAuthError('');
      try {
        var out = await supabase.auth.resend({
          type: 'signup',
          email: email,
          options: { emailRedirectTo: authEmailRedirectTo() },
        });
        if (out.error) {
          setGateAuthError(out.error.message || 'Could not resend confirmation email.');
          return;
        }
        setGateAuthError('If this address can receive mail from your project, another confirmation message was sent. Check spam.');
        setSignupEmailDeliverabilityHint(true);
      } catch (errRes) {
        console.error('resend confirmation', errRes);
        setGateAuthError('Unexpected error resending confirmation email.');
      }
    }

    async function handleGateForgotClick() {
      var emailInput = $('gate-email');
      setSignupMode(false);
      setSignupEmailDeliverabilityHint(false);
      var email = emailInput && emailInput.value ? emailInput.value.trim() : '';
      if (!email) {
        setGateAuthError('Enter your email, then click Forgot password again.');
        return;
      }
      setGateAuthError('');
      setSignupEmailDeliverabilityHint(false);
      try {
        var redirectTo = authEmailRedirectTo();
        var reset = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
        if (reset.error) {
          setGateAuthError(reset.error.message || 'Could not send reset email.');
          return;
        }
        setGateAuthError('Password reset email sent. Open the link in your email to set a new password.');
      } catch (errForgot) {
        console.error('reset password error', errForgot);
        setGateAuthError('Unexpected error sending reset email.');
      }
    }

    root.addEventListener('click', function (ev) {
      var t = ev.target;
      if (closestGateEl(t, 'gate-view-demo')) {
        showDemoDashboard();
        return;
      }
      if (closestGateEl(t, 'gate-google')) {
        void handleOAuthClick('google', 'Google');
        return;
      }
      if (closestGateEl(t, 'gate-github')) {
        void handleOAuthClick('github', 'GitHub');
        return;
      }
      if (closestGateEl(t, 'gate-signin')) {
        void handleGateSigninClick();
        return;
      }
      if (closestGateEl(t, 'gate-resend-confirm')) {
        void handleGateResendClick();
        return;
      }
      if (closestGateEl(t, 'gate-forgot-password')) {
        void handleGateForgotClick();
        return;
      }
    });

    var btnWs = $('btn-open-workspaces');
    if (btnWs) {
      btnWs.addEventListener('click', function () {
        if (typeof window.openWorkspaceSwitcherModal === 'function') {
          window.openWorkspaceSwitcherModal();
        }
      });
    }
    wireWorkspaceModal();
  }

  window.addEventListener('bizdash-auth-email-mounted', function () {
    captureInviteFromUrlToStorage();
    updateGateInviteHint();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      captureInviteFromUrlToStorage();
      updateGateInviteHint();
      wireAuthGateReactRootDelegated();
    });
  } else {
    captureInviteFromUrlToStorage();
    updateGateInviteHint();
    wireAuthGateReactRootDelegated();
  }
})();
