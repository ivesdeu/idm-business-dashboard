// supabase-auth.js
// Minimal Supabase auth gate for the dashboard.

(function () {
  'use strict';

  // NOTE: anon key is safe to expose in the browser.
  var SUPABASE_URL = 'https://ausivxesedagohjlthiy.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1c2l2eGVzZWRhZ29oamx0aGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTU3MTEsImV4cCI6MjA5MDYzMTcxMX0.H5PRdJVXCq8_9CbB12F6xFzy0ljqz1-aiVZmguErLxk';

  var SESSION_MAX_MS = 8 * 60 * 60 * 1000; // 8 hours from sign-in
  var SESSION_START_KEY = 'bizdash:auth-session-start:v1';

  if (!window.supabase) {
    console.error('Supabase JS not loaded. Check CDN <script> tag.');
    return;
  }

  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.supabaseClient = supabase;

  var sessionCheckTimer = null;

  function loadSessionStart() {
    try {
      var raw = localStorage.getItem(SESSION_START_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o.uid !== 'string' || typeof o.t !== 'number') return null;
      return o;
    } catch (_) {
      return null;
    }
  }

  function markSessionStart(userId) {
    if (!userId) return;
    try {
      localStorage.setItem(SESSION_START_KEY, JSON.stringify({ uid: userId, t: Date.now() }));
    } catch (_) {}
  }

  function clearSessionStart() {
    try {
      localStorage.removeItem(SESSION_START_KEY);
    } catch (_) {}
  }

  function stopSessionMaxAgeTicker() {
    if (sessionCheckTimer) {
      clearInterval(sessionCheckTimer);
      sessionCheckTimer = null;
    }
  }

  function startSessionMaxAgeTicker() {
    stopSessionMaxAgeTicker();
    sessionCheckTimer = setInterval(function () {
      void enforceSessionMaxAgeFromRemote();
    }, 60 * 1000);
  }

  async function enforceSessionMaxAgeFromRemote() {
    try {
      var r = await supabase.auth.getSession();
      var session = r.data.session;
      if (!session || !session.user) return;
      await ensureSessionWithinMaxAge(session);
      var r2 = await supabase.auth.getSession();
      if (!r2.data.session || !r2.data.user) {
        setCurrentUser(null);
        stopSessionMaxAgeTicker();
        showLogin();
      }
    } catch (err) {
      console.error('session max-age check error', err);
    }
  }

  /**
   * If session is older than SESSION_MAX_MS from recorded sign-in, sign out.
   * New sign-in (SIGNED_IN) should call markSessionStart first to reset the clock.
   */
  async function ensureSessionWithinMaxAge(session) {
    if (!session || !session.user) return;
    var uid = session.user.id;
    var rec = loadSessionStart();
    if (!rec || rec.uid !== uid) {
      markSessionStart(uid);
      return;
    }
    if (Date.now() - rec.t >= SESSION_MAX_MS) {
      clearSessionStart();
      await supabase.auth.signOut();
    }
  }

  // OAuth and token refresh can resolve after the first getSession(); reload data when auth settles.
  supabase.auth.onAuthStateChange(function (event, session) {
    void (async function () {
      if (event === 'SIGNED_OUT') {
        clearSessionStart();
        stopSessionMaxAgeTicker();
        setCurrentUser(null);
        showLogin();
        return;
      }
      if (session && session.user) {
        if (event === 'SIGNED_IN') {
          markSessionStart(session.user.id);
        }
        await ensureSessionWithinMaxAge(session);
        var r2 = await supabase.auth.getSession();
        var s2 = r2.data.session;
        if (!s2 || !s2.user) {
          setCurrentUser(null);
          stopSessionMaxAgeTicker();
          showLogin();
          return;
        }
        setCurrentUser(s2.user);
        if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          showApp(s2.user);
        }
      }
    })();
  });

  function setCurrentUser(user) {
    window.currentUser = user || null;
  }

  function $(id) {
    return document.getElementById(id);
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
    stopSessionMaxAgeTicker();
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'flex';
    if (app) app.classList.remove('on');
  }

  function showApp(user) {
    var loading = $('auth-loading');
    var shell = $('auth-login-shell');
    var app = $('app-shell');
    if (loading) loading.style.display = 'none';
    if (shell) shell.style.display = 'none';
    if (app) app.classList.add('on');

    if (user) {
      var nameEl = document.getElementById('user-name');
      var roleEl = document.getElementById('user-role');
      var avatarEl = document.getElementById('user-avatar');
      if (nameEl) nameEl.textContent = user.email || 'Signed in';
      if (roleEl) roleEl.textContent = 'Owner';
      if (avatarEl && user.email) {
        avatarEl.textContent = user.email.charAt(0).toUpperCase();
      }
    }

    startSessionMaxAgeTicker();

    // Once the app shell is visible, let the data layer pull from Supabase.
    if (window.initDataFromSupabase) {
      window.initDataFromSupabase();
    }
  }

  async function bootstrapSession() {
    showLoading();
    try {
      var result = await supabase.auth.getSession();
      var session = result.data.session;
      if (session && session.user) {
        await ensureSessionWithinMaxAge(session);
        result = await supabase.auth.getSession();
        session = result.data.session;
      }
      if (session && session.user) {
        setCurrentUser(session.user);
        showApp(session.user);
      } else {
        setCurrentUser(null);
        clearSessionStart();
        showLogin();
      }
    } catch (err) {
      console.error('Error checking session', err);
      setCurrentUser(null);
      showLogin();
    }
  }

  function wireAuthForm() {
    var emailInput = $('gate-email');
    var passwordInput = $('gate-password');
    var errorBox = $('gate-auth-error');

    function setError(msg) {
      if (errorBox) errorBox.textContent = msg || '';
    }

    var btnSignin = $('gate-signin');
    var btnSignup = $('gate-signup');
    var btnGithub = $('gate-github');

    if (btnSignin) {
      btnSignin.addEventListener('click', async function () {
        var email = emailInput && emailInput.value.trim();
        var password = passwordInput && passwordInput.value;
        if (!email || !password) {
          setError('Email and password are required.');
          return;
        }
        setError('');
        try {
          var res = await supabase.auth.signInWithPassword({ email: email, password: password });
          if (res.error) {
            setError(res.error.message || 'Could not sign in.');
            return;
          }
          if (res.data.user) {
            markSessionStart(res.data.user.id);
          }
          setCurrentUser(res.data.user);
          showApp(res.data.user);
        } catch (err) {
          console.error('signIn error', err);
          setError('Unexpected error signing in.');
        }
      });
    }

    if (btnSignup) {
      btnSignup.addEventListener('click', async function () {
        var email = emailInput && emailInput.value.trim();
        var password = passwordInput && passwordInput.value;
        if (!email || !password) {
          setError('Email and password are required.');
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
        } catch (err) {
          console.error('signUp error', err);
          setError('Unexpected error signing up.');
        }
      });
    }

    if (btnGithub) {
      btnGithub.addEventListener('click', async function () {
        try {
          var redirectTo = window.location.origin + window.location.pathname;
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
  }

  function wireSessionVisibilityCheck() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      void enforceSessionMaxAgeFromRemote();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      wireAuthForm();
      wireSessionVisibilityCheck();
      bootstrapSession();
    });
  } else {
    wireAuthForm();
    wireSessionVisibilityCheck();
    bootstrapSession();
  }
})();
