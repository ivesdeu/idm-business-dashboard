/**
 * date-filter.js
 * Centralized date-range logic layer for the dashboard.
 *
 * Strategy: works as a post-processor on top of the minified main bundle.
 * - Reads workspace data from localStorage directly (no coupling to minified symbols).
 * - Uses Chart.js 4's Chart.getChart(canvas) API to update chart instances.
 * - Installs a MutationObserver on #kpi-rev to catch ge() refreshes and
 *   immediately re-applies the active filter so values stay consistent.
 */
(function () {
  'use strict';

  var STORAGE_PREFIX = 'bizdash:v1:';

  // ── Data access ───────────────────────────────────────────────────────

  function getWorkspaceList() {
    try { return JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'index') || '[]'); }
    catch (_) { return []; }
  }

  function getCurrentWorkspaceId() {
    var urlId = new URLSearchParams(location.search).get('w');
    if (urlId) return urlId;
    return localStorage.getItem(STORAGE_PREFIX + 'current') || null;
  }

  function getWorkspace() {
    var id = getCurrentWorkspaceId();
    if (!id) {
      var list = getWorkspaceList();
      if (list.length) id = list[0].id;
    }
    if (!id) return null;
    try {
      return JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'ws:' + id) || 'null');
    } catch (_) { return null; }
  }

  // ── Date helpers ──────────────────────────────────────────────────────

  /** Convert a date string to a 'YYYY-MM' key, or null if invalid. */
  function toMonthKey(dateStr) {
    if (!dateStr) return null;
    var d = new Date(dateStr + 'T12:00:00');
    if (isNaN(d.getTime())) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /** 'YYYY-MM' → 'March 2026' */
  function monthKeyToLabel(key) {
    var parts = key.split('-');
    return new Date(+parts[0], +parts[1] - 1, 1)
      .toLocaleString('en-US', { month: 'long', year: 'numeric' });
  }

  /** Build a sorted array of the last N month keys ending at `anchorKey` (inclusive). */
  function buildMonthRange(anchorKey, count) {
    var parts = anchorKey.split('-').map(Number);
    var result = [];
    for (var i = count - 1; i >= 0; i--) {
      var d = new Date(parts[0], parts[1] - 1 - i, 1);
      result.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    return result;
  }

  // ── Period select ─────────────────────────────────────────────────────

  function getSelect() { return document.getElementById('dash-period-select'); }

  function getActivePeriod() {
    var sel = getSelect();
    return sel ? sel.value : 'all';
  }

  /** Populate the select with All-Time + dynamic months from data + last 12 months. */
  function populateSelect(ws) {
    var sel = getSelect();
    if (!sel) return;

    var keys = new Set();

    // Always include last 12 months so select is never empty
    var now = new Date();
    for (var i = 0; i < 12; i++) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.add(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }

    // Add months from actual data
    var all = [].concat(ws && ws.incomes || [], ws && ws.expenses || []);
    all.forEach(function (item) {
      var k = toMonthKey(item.date);
      if (k) keys.add(k);
    });

    var sorted = Array.from(keys).sort(function (a, b) { return b.localeCompare(a); }); // newest first

    var prev = sel.value;

    sel.innerHTML = '<option value="all">All-Time</option>' +
      sorted.map(function (k) {
        return '<option value="' + k + '">' + monthKeyToLabel(k) + '</option>';
      }).join('');

    // Restore previous selection if valid, otherwise default to most recent month
    if (prev === 'all' || sorted.indexOf(prev) !== -1) {
      sel.value = prev;
    } else {
      sel.value = sorted[0] || 'all';
    }
  }

  // ── Filtering helpers ─────────────────────────────────────────────────

  function filterByPeriod(items, period) {
    if (!items || !Array.isArray(items)) return [];
    if (period === 'all') return items;
    return items.filter(function (item) { return toMonthKey(item.date) === period; });
  }

  function sumAmounts(items) {
    return (items || []).reduce(function (s, i) { return s + Math.max(0, +i.amount || 0); }, 0);
  }

  /** Returns [[category, total], ...] sorted desc. */
  function categoryTotals(items, getCat) {
    var map = new Map();
    (items || []).forEach(function (item) {
      var cat = (getCat(item) || 'Other').trim() || 'Other';
      map.set(cat, (map.get(cat) || 0) + Math.max(0, +item.amount || 0));
    });
    return Array.from(map.entries())
      .filter(function (e) { return e[1] > 0; })
      .sort(function (a, b) { return b[1] - a[1]; });
  }

  /**
   * Build monthly revenue/expense buckets.
   * - period='all'  → every month with data, sorted oldest→newest
   * - period='YYYY-MM' → last 6 months ending at period (zero-padded)
   */
  function monthlyBuckets(incomes, expenses, period) {
    var map = new Map();
    function add(key, rev, exp) {
      if (!key) return;
      if (!map.has(key)) map.set(key, { rev: 0, exp: 0 });
      var b = map.get(key);
      b.rev += rev;
      b.exp += exp;
    }
    (incomes || []).forEach(function (i) { add(toMonthKey(i.date), Math.max(0, +i.amount || 0), 0); });
    (expenses || []).forEach(function (e) { add(toMonthKey(e.date), 0, Math.max(0, +e.amount || 0)); });

    var sorted = Array.from(map.entries()).sort(function (a, b) { return a[0].localeCompare(b[0]); });

    if (period === 'all' || !period) return sorted;

    // Last 6 months ending at period
    var COUNT = 6;
    var months = buildMonthRange(period, COUNT);
    return months.map(function (k) {
      var found = map.get(k);
      return [k, found || { rev: 0, exp: 0 }];
    });
  }

  // ── Display helpers ───────────────────────────────────────────────────

  function currSym() {
    var ws = getWorkspace();
    return (ws && ws.profile && ws.profile.currencySymbol) || '$';
  }

  function fmt(n) { return currSym() + Math.round(n).toLocaleString(); }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ── Widget updaters ───────────────────────────────────────────────────

  function updateKPIs(rev, exp, net) {
    setText('kpi-rev', fmt(rev));
    setText('kpi-pft', fmt(net));
    setText('kpi-exp', fmt(exp));

    var pftEl = document.getElementById('kpi-pft');
    if (pftEl) pftEl.style.color = net < 0 ? 'var(--red)' : '';

    // AR card: clearly label as current (not period-filtered)
    setText('kpi-ar-badge', 'Current AR — not period-specific');
  }

  function updateRevExpChart(ws, period) {
    var canvas = document.getElementById('cRevExp');
    if (!canvas || !window.Chart) return;
    var chart = window.Chart.getChart(canvas);
    if (!chart) return;

    var buckets = monthlyBuckets(ws.incomes, ws.expenses, period);

    chart.data.labels = buckets.map(function (b) {
      var parts = b[0].split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, 1).toLocaleString('en-US', { month: 'short' });
    });
    chart.data.datasets[0].data = buckets.map(function (b) { return b[1].rev; });
    chart.data.datasets[1].data = buckets.map(function (b) { return b[1].exp; });
    chart.update('none'); // 'none' = skip animation for instant feel

    // Update chart subtitle label
    var ss = document.querySelector('#page-dashboard .gm .card:first-child .ss');
    if (ss) {
      ss.textContent = period === 'all'
        ? 'All-time monthly trend'
        : 'Last 6 months ending ' + monthKeyToLabel(period);
    }
  }

  function updateExpenseBreakdown(expenses, totalExp, accent) {
    var colors = [accent || '#e8501a', '#3366aa', '#a86e28', '#c8c7c2', '#6b6b63', '#9a9a8f', '#4a4a44'];
    var cats = categoryTotals(expenses, function (e) { return e.category; });

    // Update donut chart
    var canvas = document.getElementById('cExp');
    if (canvas && window.Chart) {
      var chart = window.Chart.getChart(canvas);
      if (chart) {
        if (cats.length === 0) {
          chart.data.labels = ['No expense data'];
          chart.data.datasets[0].data = [1];
          chart.data.datasets[0].backgroundColor = ['#e8e6e1'];
        } else {
          chart.data.labels = cats.map(function (c) { return c[0]; });
          chart.data.datasets[0].data = cats.map(function (c) { return c[1]; });
          chart.data.datasets[0].backgroundColor = cats.map(function (_, i) { return colors[i % colors.length]; });
        }
        chart.update('none');
      }
    }

    // Update legend
    var leg = document.getElementById('exp-leg');
    if (!leg) return;
    if (cats.length === 0 || totalExp < 0.01) {
      leg.innerHTML = '<div style="font-size:12px;color:var(--text3);">No expense breakdown yet</div>';
      return;
    }
    leg.innerHTML = cats.map(function (c, i) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">' +
        '<span style="display:flex;align-items:center;gap:7px;color:var(--text2);">' +
        '<span style="width:9px;height:9px;border-radius:2px;background:' + colors[i % colors.length] + ';display:inline-block;flex-shrink:0;"></span>' +
        esc(c[0]) + '</span>' +
        '<span style="color:var(--text);font-weight:500;">' + Math.round(c[1] / totalExp * 100) + '%</span>' +
        '</div>';
    }).join('');
  }

  function updateIncomeStatement(incomes, expenses, period) {
    var opsEl = document.getElementById('dashboard-ops-statement');
    var legEl = document.getElementById('dashboard-legacy-statement');
    var hint  = document.getElementById('income-statement-hint');
    if (!opsEl || !legEl) return;

    var hasOps = incomes.length > 0 || expenses.length > 0;

    if (!hasOps) {
      // No records for this period — clean empty state
      if (period !== 'all') {
        opsEl.style.display = 'none';
        legEl.style.display = 'none';
        if (hint) hint.textContent = 'No records for ' + monthKeyToLabel(period);
      }
      // If all-time + no ops → leave legacy statement as-is (ge() handles it)
      return;
    }

    // Show ops statement
    opsEl.style.display = 'block';
    legEl.style.display = 'none';
    if (hint) {
      hint.textContent = period === 'all'
        ? 'All-time income & expense records'
        : 'Income & expenses for ' + monthKeyToLabel(period);
    }

    var totalRev = sumAmounts(incomes);
    var totalExp = sumAmounts(expenses);

    var revCats = categoryTotals(incomes, function (i) { return i.category || i.source; });
    var expCats = categoryTotals(expenses, function (e) { return e.category; });

    var revLines = document.getElementById('dashboard-revenue-lines');
    var expLines = document.getElementById('dashboard-expense-lines');

    if (revLines) {
      revLines.innerHTML = revCats.map(function (c) {
        return '<div class="fr"><span class="lbl">' + esc(c[0]) + '</span><span class="val pos">' + fmt(c[1]) + '</span></div>';
      }).join('') || '<div class="fr"><span class="lbl">(none)</span><span class="val">—</span></div>';
    }
    if (expLines) {
      expLines.innerHTML = expCats.map(function (c) {
        return '<div class="fr"><span class="lbl">' + esc(c[0]) + '</span><span class="val neg">−' + fmt(c[1]) + '</span></div>';
      }).join('') || '<div class="fr"><span class="lbl">(none)</span><span class="val neg">—</span></div>';
    }

    setText('f-gro', fmt(totalRev));
    var fnet = document.getElementById('f-net');
    if (fnet) {
      var net = totalRev - totalExp;
      fnet.textContent = fmt(net);
      fnet.className = 'val ' + (net >= 0 ? 'pos' : 'neg');
    }
  }

  function updateSubtitle(ws, period) {
    var sub = document.getElementById('dash-subtitle');
    if (!sub) return;
    var name = ((ws && ws.profile && ws.profile.companyName) || '').trim();
    var label = period === 'all' ? 'All-time' : monthKeyToLabel(period);
    sub.textContent = name ? label + ' — ' + name : label;
  }

  // ── Main refresh ──────────────────────────────────────────────────────

  var _refreshing = false;
  var _observer   = null;

  function refreshDashboard() {
    if (_refreshing) return;
    _refreshing = true;

    // Pause observer so our own DOM writes don't re-trigger it
    if (_observer) _observer.disconnect();

    try {
      var ws = getWorkspace();
      if (!ws) return;

      var period   = getActivePeriod();
      var incomes  = filterByPeriod(ws.incomes  || [], period);
      var expenses = filterByPeriod(ws.expenses || [], period);

      var totalRev = sumAmounts(incomes);
      var totalExp = sumAmounts(expenses);
      var netProfit = totalRev - totalExp;

      // Only override KPI values when we have real income/expense records.
      // If none exist, the main bundle's ge() already shows manual-bucket totals
      // correctly for all-time; for a specific month with no data we still show zeros.
      var hasAnyOps = (ws.incomes && ws.incomes.length > 0) ||
                      (ws.expenses && ws.expenses.length > 0);

      if (hasAnyOps || period !== 'all') {
        updateKPIs(totalRev, totalExp, netProfit);
      }

      updateRevExpChart(ws, period);
      updateExpenseBreakdown(expenses, totalExp, ws.profile && ws.profile.accent);
      updateIncomeStatement(incomes, expenses, period);
      updateSubtitle(ws, period);

    } finally {
      _refreshing = false;

      // Reconnect observer — mutations made while disconnected are not queued,
      // so we won't get a spurious callback from our own DOM writes.
      if (_observer) {
        var kpiRev = document.getElementById('kpi-rev');
        if (kpiRev) _observer.observe(kpiRev, { childList: true, subtree: true });
      }
    }
  }

  // ── Initialisation ────────────────────────────────────────────────────

  function init() {
    var ws = getWorkspace();
    populateSelect(ws);

    // Replace the select to remove the stub handler wired by io() in the main bundle.
    // Cloning the node strips all existing addEventListener bindings.
    var oldSel = document.getElementById('dash-period-select');
    if (oldSel) {
      var newSel = oldSel.cloneNode(true);
      oldSel.parentNode.replaceChild(newSel, oldSel);
      newSel.addEventListener('change', refreshDashboard);
    }

    // Observe #kpi-rev so that whenever ge() rewrites it we immediately re-apply
    // the active filter. The disconnect/reconnect pattern in refreshDashboard()
    // prevents infinite loops from our own writes.
    var kpiRev = document.getElementById('kpi-rev');
    if (kpiRev && window.MutationObserver) {
      _observer = new MutationObserver(function () {
        if (!_refreshing) refreshDashboard();
      });
      _observer.observe(kpiRev, { childList: true, subtree: true });
    }

    refreshDashboard();
  }

  // Wait until the main bundle has initialised Chart.js instances before running.
  // cRevExp is the last chart created, so its presence means everything is ready.
  var _waitTries = 0;
  function waitForCharts() {
    var canvas = document.getElementById('cRevExp');
    if (canvas && window.Chart && window.Chart.getChart(canvas)) {
      init();
    } else if (_waitTries++ < 30) {   // max ~4.5 s
      setTimeout(waitForCharts, 150);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForCharts);
  } else {
    waitForCharts();
  }

})();
