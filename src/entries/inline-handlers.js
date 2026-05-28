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

  /** Toggle/remove the mobile sidebar by id. */
  function wireMobileNav () {
    var menuBtn = document.getElementById('btn-mobile-menu');
    if (menuBtn && menuBtn.getAttribute('data-wired-mobile-menu') !== '1') {
      menuBtn.setAttribute('data-wired-mobile-menu', '1');
      menuBtn.addEventListener('click', function () {
        document.body.classList.toggle('mobile-nav-open');
      });
    }
    var overlay = document.getElementById('mobile-nav-overlay');
    if (overlay && overlay.getAttribute('data-wired-mobile-overlay') !== '1') {
      overlay.setAttribute('data-wired-mobile-overlay', '1');
      overlay.addEventListener('click', function () {
        document.body.classList.remove('mobile-nav-open');
      });
    }
  }

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
    });
  }

  function wireAll () {
    wireMobileNav();
    wireInputModalButtons();
    wireDelegatedClicks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireAll, { once: true });
  } else {
    wireAll();
  }
})();
