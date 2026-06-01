/**
 * Replaces inline `onclick="..."` attributes and inline `<script>` blocks in
 * `index.html` so the page can ship under a strict `script-src 'self'` CSP
 * (no `'unsafe-inline'`, no per-script hashes).
 *
 * Strategy: a single delegated document-level click listener handles every
 * `data-*` attribute we use as a behavior hook, plus a few one-shot listeners
 * for elements that previously had inline handlers.
 */
(function wireInlineReplacementHandlers () {
  if (typeof document === 'undefined') return;

  /**
   * Toggle/remove the mobile sidebar.
   *
   * We attach BOTH a direct listener (when the element is found) AND a
   * delegated document-level listener as a failsafe. The delegated handler
   * means the hamburger works even if:
   *   - the button is briefly out of the DOM during React mounts,
   *   - this module ran before #btn-mobile-menu was parsed,
   *   - a stale cached bundle never finished initializing.
   */
  function toggleMobileNav () {
    document.body.classList.toggle('mobile-nav-open');
  }
  function closeMobileNav () {
    document.body.classList.remove('mobile-nav-open');
  }
  function wireMobileNav () {
    var menuBtn = document.getElementById('btn-mobile-menu');
    if (menuBtn && menuBtn.getAttribute('data-wired-mobile-menu') !== '1') {
      menuBtn.setAttribute('data-wired-mobile-menu', '1');
      menuBtn.addEventListener('click', toggleMobileNav);
    }
    var overlay = document.getElementById('mobile-nav-overlay');
    if (overlay && overlay.getAttribute('data-wired-mobile-overlay') !== '1') {
      overlay.setAttribute('data-wired-mobile-overlay', '1');
      overlay.addEventListener('click', closeMobileNav);
    }
  }

  /**
   * Delegated failsafe — guarantees the hamburger responds to taps even when
   * the direct listeners never attached. Only fires if the direct listener
   * isn't wired (otherwise both would fire on the same event and toggle twice,
   * netting zero). Runs on bubble phase so the direct listener gets first crack.
   */
  function wireDelegatedMobileNav () {
    if (window.__bizdashMobileNavDelegated) return;
    window.__bizdashMobileNavDelegated = true;
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || typeof t.closest !== 'function') return;
      var btn = t.closest('#btn-mobile-menu');
      if (btn) {
        // Try wiring direct now; if it was already wired, the direct listener
        // already toggled — return so we don't double-toggle.
        var wasWired = btn.getAttribute('data-wired-mobile-menu') === '1';
        if (wasWired) return;
        wireMobileNav();
        toggleMobileNav();
        return;
      }
      var ov = t.closest('#mobile-nav-overlay');
      if (ov) {
        var ovWired = ov.getAttribute('data-wired-mobile-overlay') === '1';
        if (ovWired) return;
        wireMobileNav();
        closeMobileNav();
      }
    });
  }

  // Expose so other code (e.g. financial-core.js) can re-run wiring after
  // DOM rewrites without re-implementing the logic.
  window.bizDashWireMobileNav = wireMobileNav;

  /** Wire `inputModal` close + apply buttons that used to live in an inline script. */
  function wireInputModalButtons () {
    var closeBtn = document.getElementById('btn-close-input');
    if (closeBtn && closeBtn.getAttribute('data-wired-input-close') !== '1') {
      closeBtn.setAttribute('data-wired-input-close', '1');
      closeBtn.addEventListener('click', function () {
        var modal = document.getElementById('inputModal');
        if (modal) modal.classList.remove('on');
      });
    }
    var applyBtn = document.getElementById('btn-apply-input');
    if (applyBtn && applyBtn.getAttribute('data-wired-input-apply') !== '1') {
      applyBtn.setAttribute('data-wired-input-apply', '1');
      applyBtn.addEventListener('click', function () {
        if (typeof window.updateData === 'function') window.updateData();
      });
    }
  }

  /**
   * Delegated click handler.
   *
   *   [data-nav]                  → window.nav(value, element)
   *   [data-nav-prevent-default]  → calls preventDefault() before nav()
   *   [data-proxy-click="id"]     → forwards click to the element with that id
   *   [data-modal-backdrop-dismiss="id"]  → removes `.on` from modal when the
   *                                          backdrop itself was the target
   */
  function wireDelegatedClicks () {
    if (window.__bizdashInlineDelegatedWired) return;
    window.__bizdashInlineDelegatedWired = true;

    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || typeof t.closest !== 'function') return;

      var backdrop = t.closest('[data-modal-backdrop-dismiss]');
      if (backdrop && ev.target === backdrop) {
        backdrop.classList.remove('on');
        return;
      }

      var navEl = t.closest('[data-nav]');
      if (navEl) {
        var page = navEl.getAttribute('data-nav');
        if (page) {
          if (navEl.hasAttribute('data-nav-prevent-default')) ev.preventDefault();
          if (typeof window.nav === 'function') window.nav(page, navEl);
        }
        return;
      }

      var proxyEl = t.closest('[data-proxy-click]');
      if (proxyEl) {
        var targetId = proxyEl.getAttribute('data-proxy-click');
        if (targetId) {
          var target = document.getElementById(targetId);
          if (target) target.click();
        }
        return;
      }

      // Dashboard / modal controls — delegated so they work even when
      // financial-core init() aborts before direct listeners attach.
      if (t.closest('#btn-open-transaction, #btn-open-transaction-2')) {
        if (typeof window.bizDashOpenTransactionModal === 'function') {
          window.bizDashOpenTransactionModal();
        } else {
          var txMo = document.getElementById('transactionModal');
          if (txMo) txMo.classList.add('on');
        }
        return;
      }
      if (t.closest('#btn-open-input')) {
        if (typeof window.bizDashOpenInputModal === 'function') {
          window.bizDashOpenInputModal();
        } else {
          var inMo = document.getElementById('inputModal');
          if (inMo) inMo.classList.add('on');
        }
        return;
      }
      if (t.closest('#btn-close-input, #btn-tx-cancel')) {
        if (t.closest('#btn-close-input') && typeof window.bizDashCloseInputModal === 'function') {
          window.bizDashCloseInputModal();
        } else if (typeof window.bizDashCloseTransactionModal === 'function') {
          window.bizDashCloseTransactionModal();
        }
        return;
      }
      if (t.closest('#btn-apply-input')) {
        if (typeof window.updateData === 'function') window.updateData();
        return;
      }
    });
  }

  function wireAll () {
    wireMobileNav();
    wireDelegatedMobileNav();
    wireInputModalButtons();
    wireDelegatedClicks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAll, { once: true });
  } else {
    wireAll();
  }
})();
