// supabase-auth.js
// Supabase auth gate + organization slug routing (path /:slug/…).

(function () {
  'use strict';

  var PENDING_INVITE_KEY = 'bizdash_pending_org_invite';
  var FLASH_INVITE_KEY = 'bizdash_flash_invite_msg';

  // NOTE: anon key is safe to expose in the browser.
  var SUPABASE_URL = 'https://ausivxesedagohjlthiy.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1c2l2eGVzZWRhZ29oamx0aGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTU3MTEsImV4cCI6MjA5MDYzMTcxMX0.H5PRdJVXCq8_9CbB12F6xFzy0ljqz1-aiVZmguErLxk';

  if (!window.supabase) {
    console.error('Supabase JS not loaded. Check CDN <script> tag.');
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
          'The sign-in library did not load. Check your connection, allow cdn.jsdelivr.net, then refresh. Sign-in will not work until this script loads.';
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

  function $(id) {
    return document.getElementById(id);
  }

  /**
   * Ceilings for org / onboarding resolution (not session read — that is driven by INITIAL_SESSION).
   * These are UX timeouts only; the auth session itself has no artificial cap.
   */
  var ORG_RESOLVE_MS = 8000;
  var ONBOARDING_GATE_MS = 5000;

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
    return msg.indexOf('lock was stolen by another request') !== -1 || msg.indexOf('aborterror') !== -1;
  }

  async function retryOnAuthLock(task) {
    var maxAttempts = 3;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await task();
      } catch (err) {
        if (!isLockStolenError(err) || attempt === maxAttempts) throw err;
        // Tiny jitter gives the competing request time to release the lock.
        await sleep(120 * attempt);
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

  function setOrgContext(orgId, slug, role) {
    window.currentOrganizationId = orgId || null;
    window.currentOrganizationSlug = slug || null;
    window.currentOrganizationRole = role || null;
    if (typeof window.refreshSidebarWorkspaceChrome === 'function') {
      window.refreshSidebarWorkspaceChrome();
    }
  }

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
        gateErr('You do not have access to this workspace.');
        clearOrgContext();
        return { ok: false };
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
    try {
      return await withTimeout(
        ensureOrganizationContext(user, authSession),
        ORG_RESOLVE_MS,
        'Loading workspace timed out. Check your connection and try again.'
      );
    } catch (err) {
      // One immediate second chance for lock contention only (no extra wait).
      if (isLockStolenError(err)) {
        return await withTimeout(
          ensureOrganizationContext(user, authSession),
          ORG_RESOLVE_MS,
          'Loading workspace timed out. Check your connection and try again.'
        );
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
        var signed = await supabase.storage.from('brand-assets').createSignedUrl(path, 60 * 30);
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
            accent: '#e8501a',
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
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'flex';
    if (app) app.classList.remove('on');
    updateGateInviteHint();
  }

  window.__dashboardShowLogin = showLogin;

  var authRecoveryMode = false;
  function setAuthRecoveryMode(on) {
    authRecoveryMode = !!on;
    var heading = document.querySelector('#auth-login-shell .pt');
    var subtitle = document.querySelector('#auth-login-shell p');
    var signin = $('gate-signin');
    var signup = $('gate-signup');
    var github = $('gate-github');
    var forgot = $('gate-forgot-password');
    var confirmWrap = $('gate-confirm-wrap');
    var errorBox = $('gate-auth-error');
    if (heading) heading.textContent = authRecoveryMode ? 'Reset password' : 'Sign in';
    if (subtitle) {
      subtitle.textContent = authRecoveryMode
        ? 'Set a new password for your account.'
        : 'Sign in to use the dashboard.';
    }
    if (signin) signin.textContent = authRecoveryMode ? 'Update password' : 'Sign in';
    if (signup) signup.style.display = authRecoveryMode ? 'none' : '';
    if (github) github.style.display = authRecoveryMode ? 'none' : '';
    if (forgot) forgot.style.display = authRecoveryMode ? 'none' : '';
    if (confirmWrap) confirmWrap.style.display = authRecoveryMode ? '' : 'none';
    if (errorBox && authRecoveryMode && !errorBox.textContent) {
      errorBox.textContent = 'Enter and confirm your new password.';
    }
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
      showLoading();
      try {
        setCurrentUser(user);
        var ctx = await resolveOrgContextWithRetry(user, authSession);
        if (!ctx || !ctx.ok) {
          if (isAppVisible()) {
            setCurrentUser(user);
            return;
          }
          setCurrentUser(null);
          showLogin();
          return;
        }
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
  }

  function showApp(user) {
    hideOnboardModal();
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.add('on');
    markStableAppUser(user);

    if (user) {
      var nameEl = document.getElementById('user-name');
      var roleEl = document.getElementById('user-role');
      var avatarEl = document.getElementById('user-avatar');
      var metaU = (user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {}) || {};
      if (nameEl) {
        var dispN = [String(metaU.first_name || '').trim(), String(metaU.last_name || '').trim()].filter(Boolean).join(' ').trim();
        nameEl.textContent = dispN || user.email || 'Signed in';
      }
      if (roleEl) {
        var rr = window.currentOrganizationRole;
        roleEl.textContent = rr ? String(rr).charAt(0).toUpperCase() + String(rr).slice(1) : 'Member';
      }
      if (avatarEl) {
        avatarEl.innerHTML = '';
        var avPath = String(metaU.profile_avatar_path || '').trim();
        if (avPath && supabase) {
          supabase.storage
            .from('brand-assets')
            .createSignedUrl(avPath, 60 * 60 * 24)
            .then(function (res) {
              if (!res.data || !res.data.signedUrl || !avatarEl) return;
              avatarEl.innerHTML = '';
              var im = document.createElement('img');
              im.src = res.data.signedUrl;
              im.alt = '';
              im.width = 28;
              im.height = 28;
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
    }

    drainInviteFlashIntoApp();

    if (window.initDataFromSupabase) {
      window.initDataFromSupabase();
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
        return;
      }
      if (shouldSkipSessionReflow(session)) {
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
      return;
    }

    try {
      if (typeof window.setBizdashScreenshotNoCloud === 'function') {
        window.setBizdashScreenshotNoCloud(false);
      }
    } catch (_) {}

    if (event === 'TOKEN_REFRESHED') {
      setCurrentUser(session.user);
      // Avoid showApp + initData before org resolution finishes (setCurrentUser runs early in runAuthSessionFlow).
      if (hasResolvedWorkspaceContext(session)) {
        showApp(session.user);
      }
      return;
    }

    /* Tab focus: GoTrue may emit SIGNED_IN / INITIAL_SESSION again without a real auth change. */
    if (shouldSkipSessionReflow(session)) {
      setCurrentUser(session.user);
      return;
    }

    await runAuthSessionFlow(session.user, session);
  });

  function wireAuthForm() {
    captureInviteFromUrlToStorage();
    updateGateInviteHint();

    var emailInput = $('gate-email');
    var passwordInput = $('gate-password');
    var confirmWrap = $('gate-confirm-wrap');
    var confirmInput = $('gate-confirm-password');
    var errorBox = $('gate-auth-error');
    var signupMode = false;

    function setError(msg) {
      if (errorBox) errorBox.textContent = msg || '';
    }

    function setSignupMode(on) {
      signupMode = !!on;
      if (confirmWrap) confirmWrap.style.display = signupMode || authRecoveryMode ? '' : 'none';
      if (!signupMode && confirmInput) confirmInput.value = '';
    }

    var btnSignin = $('gate-signin');
    var btnSignup = $('gate-signup');
    var btnGithub = $('gate-github');
    var btnForgot = $('gate-forgot-password');

    if (btnSignin) {
      btnSignin.addEventListener('click', async function () {
        if (!authRecoveryMode) setSignupMode(false);
        var email = emailInput && emailInput.value.trim();
        var password = passwordInput && passwordInput.value;
        setError('');
        if (authRecoveryMode) {
          var confirmPasswordRecovery = confirmInput && confirmInput.value;
          if (!password) {
            setError('New password is required.');
            return;
          }
          if (!confirmPasswordRecovery) {
            setError('Please confirm your new password.');
            return;
          }
          if (password !== confirmPasswordRecovery) {
            setError('Passwords do not match.');
            return;
          }
          try {
            var upd = await supabase.auth.updateUser({ password: password });
            if (upd.error) {
              setError(upd.error.message || 'Could not update password.');
              return;
            }
            setAuthRecoveryMode(false);
            if (confirmInput) confirmInput.value = '';
            if (passwordInput) passwordInput.value = '';
            setError('Password updated. You can sign in with your new password.');
            try {
              await supabase.auth.signOut();
            } catch (_) {}
            showLogin();
          } catch (errRecovery) {
            console.error('password update error', errRecovery);
            setError('Unexpected error updating password.');
          }
          return;
        }
        if (!email || !password) {
          setError('Email and password are required.');
          return;
        }
        try {
          var res = await supabase.auth.signInWithPassword({ email: email, password: password });
          if (res.error) {
            setError(res.error.message || 'Could not sign in.');
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
          setError('Unexpected error signing in.');
        }
      });
    }

    if (btnSignup) {
      btnSignup.addEventListener('click', async function () {
        if (!signupMode) {
          setSignupMode(true);
          setError('Confirm your password to create an account.');
          if (confirmInput) confirmInput.focus();
          return;
        }
        var email = emailInput && emailInput.value.trim();
        var password = passwordInput && passwordInput.value;
        var confirmPassword = confirmInput && confirmInput.value;
        if (!email || !password) {
          setError('Email and password are required.');
          return;
        }
        if (!confirmPassword) {
          setError('Please confirm your password.');
          return;
        }
        if (password !== confirmPassword) {
          setError('Passwords do not match.');
          return;
        }
        setError('');
        try {
          var res = await supabase.auth.signUp({ email: email, password: password });
          if (res.error) {
            setError(res.error.message || 'Could not sign up.');
            return;
          }
          setError('Check your email to confirm your account, then sign in.');
          setSignupMode(false);
        } catch (err) {
          console.error('signUp error', err);
          setError('Unexpected error signing up.');
        }
      });
    }

    if (btnForgot) {
      btnForgot.addEventListener('click', async function () {
        setSignupMode(false);
        var email = emailInput && emailInput.value ? emailInput.value.trim() : '';
        if (!email) {
          setError('Enter your email, then click Forgot password again.');
          return;
        }
        setError('');
        try {
          var redirectTo = window.location.origin + (window.location.pathname || '/');
          var reset = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo });
          if (reset.error) {
            setError(reset.error.message || 'Could not send reset email.');
            return;
          }
          setError('Password reset email sent. Open the link in your email to set a new password.');
        } catch (errForgot) {
          console.error('reset password error', errForgot);
          setError('Unexpected error sending reset email.');
        }
      });
    }

    var btnViewDemo = $('gate-view-demo');
    if (btnViewDemo) {
      btnViewDemo.addEventListener('click', function () {
        showDemoDashboard();
      });
    }

    if (btnGithub) {
      btnGithub.addEventListener('click', async function () {
        try {
          var path = window.location.pathname || '/';
          var search = window.location.search || '';
          var redirectTo = window.location.origin + path + search;
          var res = await supabase.auth.signInWithOAuth({
            provider: 'github',
            options: {
              redirectTo: redirectTo,
            },
          });
          if (res.error) {
            setError(res.error.message || 'GitHub sign-in failed.');
          }
        } catch (err) {
          console.error('GitHub auth error', err);
          setError('Unexpected error starting GitHub sign-in.');
        }
      });
    }

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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      captureInviteFromUrlToStorage();
      updateGateInviteHint();
      wireAuthForm();
    });
  } else {
    captureInviteFromUrlToStorage();
    updateGateInviteHint();
    wireAuthForm();
  }
})();
