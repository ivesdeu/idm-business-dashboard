// Rule-based in-dashboard assistant: answers from bundled knowledge + optional live Supabase counts (signed-in user). No LLM API.
// Chat UI is a vanilla port of a ChatGPT-style prompt box (rounded shell, toolbar, tools menu, attach preview).

(function () {
  'use strict';

  var WELCOME =
    'Hi — I’m a built-in helper for this dashboard.\n\n' +
    'I can explain the Supabase schema, where things live in the repo, and how auth/build work. ' +
    'If you’re signed in, ask things like “how many clients do I have?” and I’ll count rows you’re allowed to see.\n\n' +
    'I don’t call an external AI—only this app’s logic and your Supabase session.';

  var TOOL_META = {
    createImage: { short: 'Image' },
    searchWeb: { short: 'Search' },
    writeCode: { short: 'Write' },
    deepResearch: { short: 'Deep Search' },
    thinkLonger: { short: 'Think' },
  };

  function norm(s) {
    return (s || '').toLowerCase().trim();
  }

  function appendBubble(logEl, role, text) {
    var div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'asst');
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function countRows(supabase, userId, table) {
    var res = await supabase.from(table).select('*', { count: 'exact', head: true }).eq('user_id', userId);
    if (res.error) return { ok: false, err: res.error.message };
    return { ok: true, count: typeof res.count === 'number' ? res.count : 0 };
  }

  async function tryLiveCount(q, supabase, user) {
    if (!user || !supabase) return null;
    var ql = norm(q);
    if (!/\b(how many|how\s+much|count|number of|total)\b/.test(ql)) return null;

    var specs = [
      { re: /\bclients?\b/, table: 'clients', label: 'client' },
      { re: /\btransactions?\b/, table: 'transactions', label: 'transaction' },
      { re: /\bprojects?\b/, table: 'projects', label: 'project' },
      { re: /\binvoices?\b/, table: 'invoices', label: 'invoice' },
      { re: /\bcampaigns?\b/, table: 'campaigns', label: 'campaign' },
      { re: /\b(timesheet\s+entries|timesheets?|time\s+entries)\b/, table: 'timesheet_entries', label: 'timesheet entry' },
    ];

    for (var i = 0; i < specs.length; i++) {
      if (specs[i].re.test(ql)) {
        var r = await countRows(supabase, user.id, specs[i].table);
        if (!r.ok) {
          return 'Could not count ' + specs[i].table + ': ' + r.err;
        }
        var noun = r.count === 1 ? specs[i].label : specs[i].label + 's';
        return 'You have ' + r.count + ' ' + noun + ' in Supabase (rows with your user_id).';
      }
    }
    return null;
  }

  function answerStatic(q) {
    var ql = norm(q);

    if (!ql) return null;

    if (/\b(help|what can you|what do you do|capabilities)\b/.test(ql)) {
      return (
        'I can answer:\n' +
        '• Which Supabase tables and columns the dashboard expects\n' +
        '• How RLS scopes data to your account\n' +
        '• Where SQL migrations and Edge Functions live\n' +
        '• How static builds and deploy work\n' +
        '• Live counts (clients, transactions, projects, invoices, campaigns, timesheet rows) when you’re signed in'
      );
    }

    if (/\b(hello|hi\b|hey)\b/.test(ql)) {
      return 'Hello! Ask about Supabase tables, RLS, Stripe fields, or say “how many projects do I have?” if you’re signed in.';
    }

    if (/\b(table|tables|schema|database|supabase)\b/.test(ql)) {
      return (
        'Core tables (see supabase/dashboard_sync.sql and bootstrap_core.sql):\n' +
        '• clients — company/contact, industry, is_retainer, metadata (jsonb)\n' +
        '• transactions — date, category, amount, client_id, project_id, metadata (jsonb)\n' +
        '• projects — client link, status, value, case study fields\n' +
        '• invoices — links to income via income_tx_id; optional stripe_* columns\n' +
        '• campaigns — marketing pipeline\n' +
        '• timesheet_entries — date, account, project, minutes, billable\n' +
        '• app_settings — per-user json (project_statuses, dashboard_settings)'
      );
    }

    if (/\b(rls|row level|security|policy|policies|auth\.uid)\b/.test(ql)) {
      return (
        'Row level security ties rows to auth.uid() = user_id on most tables. ' +
        'clients and transactions also allow legacy rows where user_id IS NULL for select/update in some policies—see dashboard_sync.sql. ' +
        'The browser uses the Supabase anon key plus your JWT after sign-in; only your permitted rows are returned.'
      );
    }

    if (/\b(mrr|retainer|recurring)\b/.test(ql)) {
      return (
        'MRR on the dashboard comes from retainers: clients with is_retainer and related income transactions. ' +
        'The main KPI logic lives in public/assets/financial-core.js; client records are in public.clients.'
      );
    }

    if (/\b(stripe|checkout|payment intent)\b/.test(ql)) {
      return (
        'Invoices can store Stripe metadata: stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id, stripe_status. ' +
        'Edge Functions in supabase/functions/create-stripe-checkout-session and stripe-webhook integrate with Stripe (deploy separately in Supabase).'
      );
    }

    if (/\b(which file|where is|codebase|repository|repo)\b/.test(ql) && /\b(sql|migration|schema)\b/.test(ql)) {
      return 'Schema and RLS are in supabase/dashboard_sync.sql (full sync) and supabase/bootstrap_core.sql (minimal bootstrap).';
    }

    if (/\b(build|dist|netlify|deploy)\b/.test(ql)) {
      return (
        'npm run build runs scripts/build-static.mjs, which copies index.html and public/ into dist/. ' +
        'netlify.toml publishes dist/ and SPA-redirects to index.html. No bundler step for the main dashboard JS.'
      );
    }

    if (/\b(script|javascript|frontend)\b/.test(ql) && /\b(where|which|file)\b/.test(ql)) {
      return (
        'Main UI logic: public/assets/financial-core.js. Auth: public/assets/supabase-auth.js (creates window.supabaseClient). ' +
        'Entry markup: index.html.'
      );
    }

    if (/\b(sign in|signin|login|auth|github)\b/.test(ql)) {
      return (
        'Sign-in is handled in public/assets/supabase-auth.js using @supabase/supabase-js. ' +
        'After session is established, initDataFromSupabase loads your data into the dashboard.'
      );
    }

    if (/\b(performance|projects page)\b/.test(ql)) {
      return 'The Performance nav page drives project lists, statuses, and case-study fields stored on public.projects.';
    }

    if (/\b(insights|retention|churn)\b/.test(ql)) {
      return 'Insights and Retention pages analyze clients and transactions already loaded in the app (income gaps, churn risk, etc.).';
    }

    return null;
  }

  async function replyForQuestion(q, hadImage) {
    var supabase = window.supabaseClient;
    var user = window.currentUser;

    var imageNote = hadImage
      ? 'Images aren’t analyzed in this built-in helper—only text and your Supabase session are used.\n\n'
      : '';

    var live = await tryLiveCount(q, supabase, user);
    if (live) return imageNote + live;

    if (/\b(how many|count|number of)\b/.test(norm(q)) && !user) {
      return imageNote + 'Sign in to count your rows in Supabase. I can still explain tables and schema without a session.';
    }

    var stat = answerStatic(q);
    if (stat) return imageNote + stat;

    return (
      imageNote +
      'I don’t have a scripted answer for that. Try rephrasing, or ask about: Supabase tables, RLS, Stripe invoice fields, ' +
      'build/deploy, MRR/retainers, or “how many [clients|transactions|projects|invoices|campaigns|timesheet entries] do I have?” when signed in.'
    );
  }

  window.wireDashboardAssistant = function () {
    var logEl = document.getElementById('chat-log');
    var ta = document.getElementById('chat-input');
    var sendBtn = document.getElementById('chat-send');
    var starters = document.getElementById('chat-starters');
    var promptBox = document.getElementById('chat-prompt-box');
    var fileInput = document.getElementById('chat-file-input');
    var attachBtn = document.getElementById('chat-attach-btn');
    var previewWrap = document.getElementById('chat-image-preview-wrap');
    var thumbImg = document.getElementById('chat-image-thumb');
    var thumbBtn = document.getElementById('chat-image-thumb-btn');
    var removeImgBtn = document.getElementById('chat-image-remove');
    var toolsTrigger = document.getElementById('chat-tools-trigger');
    var toolsPop = document.getElementById('chat-tools-pop');
    var toolsLabel = document.getElementById('chat-tools-label');
    var activeToolEl = document.getElementById('chat-active-tool');
    var activeToolName = document.getElementById('chat-active-tool-name');
    var activeToolClear = document.getElementById('chat-active-tool-clear');
    var lightbox = document.getElementById('chat-lightbox');
    var lightboxImg = document.getElementById('chat-lightbox-img');
    var lightboxClose = document.getElementById('chat-lightbox-close');
    var micBtn = document.getElementById('chat-mic-btn');

    if (!logEl || !ta || !sendBtn) return;

    var imagePreview = null;
    var selectedTool = null;

    function syncSendDisabled() {
      var has = ta.value.trim().length > 0 || !!imagePreview;
      sendBtn.disabled = !has;
    }

    function autoResizeTa() {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    }

    function setImagePreview(dataUrl) {
      imagePreview = dataUrl || null;
      if (imagePreview) {
        thumbImg.src = imagePreview;
        previewWrap.hidden = false;
      } else {
        thumbImg.removeAttribute('src');
        previewWrap.hidden = true;
        if (fileInput) fileInput.value = '';
      }
      syncSendDisabled();
    }

    function setToolsOpen(open) {
      if (!toolsPop || !toolsTrigger) return;
      toolsPop.hidden = !open;
      toolsTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function setSelectedTool(id) {
      selectedTool = id || null;
      if (!activeToolEl || !activeToolName || !toolsLabel) return;
      if (selectedTool && TOOL_META[selectedTool]) {
        activeToolEl.hidden = false;
        activeToolName.textContent = TOOL_META[selectedTool].short;
        toolsLabel.style.display = 'none';
      } else {
        activeToolEl.hidden = true;
        toolsLabel.style.display = '';
      }
    }

    ta.addEventListener('input', function () {
      syncSendDisabled();
      autoResizeTa();
    });

    if (promptBox) {
      promptBox.addEventListener('click', function (ev) {
        if (ev.target.closest('button') || ev.target.closest('textarea')) return;
        ta.focus();
      });
    }

    if (attachBtn && fileInput) {
      attachBtn.addEventListener('click', function () {
        fileInput.click();
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', function (ev) {
        var file = ev.target.files && ev.target.files[0];
        if (file && file.type.indexOf('image/') === 0) {
          var reader = new FileReader();
          reader.onloadend = function () {
            setImagePreview(reader.result);
          };
          reader.readAsDataURL(file);
        }
        ev.target.value = '';
      });
    }

    if (removeImgBtn) {
      removeImgBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        setImagePreview(null);
      });
    }

    if (thumbBtn && lightbox && lightboxImg) {
      thumbBtn.addEventListener('click', function () {
        if (!imagePreview) return;
        lightboxImg.src = imagePreview;
        lightbox.hidden = false;
      });
    }

    function closeLightbox() {
      if (lightbox) lightbox.hidden = true;
      if (lightboxImg) lightboxImg.removeAttribute('src');
    }

    if (lightbox) {
      lightbox.addEventListener('click', function (ev) {
        if (ev.target === lightbox || ev.target === lightboxImg) closeLightbox();
      });
    }
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);

    if (toolsTrigger && toolsPop) {
      toolsTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        setToolsOpen(toolsPop.hidden);
      });
    }

    if (toolsPop) {
      toolsPop.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var row = ev.target.closest('[data-chat-tool]');
        if (!row) return;
        var id = row.getAttribute('data-chat-tool');
        setSelectedTool(id);
        setToolsOpen(false);
      });
    }

    if (activeToolClear) {
      activeToolClear.addEventListener('click', function () {
        setSelectedTool(null);
      });
    }

    document.addEventListener('click', function () {
      setToolsOpen(false);
    });

    if (micBtn) {
      micBtn.addEventListener('click', function () {
        /* Title explains; no modal */
      });
    }

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        setToolsOpen(false);
        if (lightbox && !lightbox.hidden) closeLightbox();
      }
    });

    var seeded = false;
    function seedWelcome() {
      if (seeded) return;
      seeded = true;
      appendBubble(logEl, 'asst', WELCOME);
    }

    async function handleSend(text) {
      var t = (text || '').trim();
      var hadImage = !!imagePreview;
      if (!t && !hadImage) return;
      seedWelcome();

      var userLine = t || '(Image attached)';
      appendBubble(logEl, 'user', userLine);

      ta.value = '';
      autoResizeTa();
      setImagePreview(null);

      appendBubble(logEl, 'asst', '…');
      var pending = logEl.lastChild;
      var out = await replyForQuestion(t, hadImage);
      pending.textContent = out;
      logEl.scrollTop = logEl.scrollHeight;
      syncSendDisabled();
    }

    sendBtn.addEventListener('click', function () {
      handleSend(ta.value);
    });

    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        if (!sendBtn.disabled) handleSend(ta.value);
      }
    });

    if (starters) {
      starters.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-chat-q]');
        if (!btn) return;
        var q = btn.getAttribute('data-chat-q');
        if (q) {
          ta.value = q;
          autoResizeTa();
          syncSendDisabled();
          handleSend(q);
        }
      });
    }

    if (document.getElementById('page-chat') && document.getElementById('page-chat').classList.contains('on')) {
      seedWelcome();
    }

    syncSendDisabled();
    autoResizeTa();

    window.seedDashboardChatWelcome = seedWelcome;
  };
})();
