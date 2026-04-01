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
  }

  async function bootstrapSession() {
    showLoading();
    try {
      var result = await supabase.auth.getSession();
      var session = result.data.session;
      if (session && session.user) {
        window.currentUser = session.user;
        showApp(session.user);
      } else {
        showLogin();
      }
    } catch (err) {
      console.error('Error checking session', err);
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
          window.currentUser = res.data.user;
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

