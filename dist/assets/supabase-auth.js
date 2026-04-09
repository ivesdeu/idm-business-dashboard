// supabase-auth.js
// Minimal Supabase auth gate for the dashboard.

(function () {
  'use strict';

  // NOTE: anon key is safe to expose in the browser.
  var SUPABASE_URL = 'https://ausivxesedagohjlthiy.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1c2l2eGVzZWRhZ29oamx0aGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTU3MTEsImV4cCI6MjA5MDYzMTcxMX0.H5PRdJVXCq8_9CbB12F6xFzy0ljqz1-aiVZmguErLxk';

  if (!window.supabase) {
    console.error('Supabase JS not loaded. Check CDN <script> tag.');
    return;
  }

  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.supabaseClient = supabase;

  // OAuth and token refresh can resolve after the first getSession(); reload data when auth settles.
  supabase.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_OUT') {
      setCurrentUser(null);
      showLogin();
      return;
    }
    if (session && session.user) {
      setCurrentUser(session.user);
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        showApp(session.user);
      }
    }
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
        setCurrentUser(session.user);
        showApp(session.user);
      } else {
        setCurrentUser(null);
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
    var confirmWrap = $('gate-confirm-wrap');
    var confirmInput = $('gate-confirm-password');
    var errorBox = $('gate-auth-error');
    var signupMode = false;

    function setError(msg) {
      if (errorBox) errorBox.textContent = msg || '';
    }

    function setSignupMode(on) {
      signupMode = !!on;
      if (confirmWrap) confirmWrap.style.display = signupMode ? '' : 'none';
      if (!signupMode && confirmInput) confirmInput.value = '';
    }

    var btnSignin = $('gate-signin');
    var btnSignup = $('gate-signup');
    var btnGithub = $('gate-github');

    if (btnSignin) {
      btnSignin.addEventListener('click', async function () {
        setSignupMode(false);
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      wireAuthForm();
      bootstrapSession();
    });
  } else {
    wireAuthForm();
    bootstrapSession();
  }
})();

