// financial-core.js
// Standalone financial data layer: transactions are the single source of truth.

(function () {
  'use strict';

  var STORAGE_KEY = 'bizdash:transactions:v1';

  // ---------- Data model ----------

  function loadTransactions() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveTransactions(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  function uuid() {
    return 'tx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  var state = {
    transactions: loadTransactions(),
    filter: { mode: 'all', start: null, end: null }, // all | month | range
    computed: null,
  };

  // ---------- Clients store ----------

  var CLIENTS_KEY = 'bizdash:clients:v1';

  function loadClients() {
    try {
      var raw = localStorage.getItem(CLIENTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveClients(list) {
    try {
      localStorage.setItem(CLIENTS_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  var clients = loadClients();

  // Project statuses (for Manage statuses modal)
  var STATUS_KEY = 'bizdash:project-statuses:v1';

  function loadStatuses() {
    try {
      var raw = localStorage.getItem(STATUS_KEY);
      if (!raw) {
        return ['Not started', 'In progress', 'Blocked', 'Complete'];
      }
      var arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? arr : ['Not started', 'In progress', 'Blocked', 'Complete'];
    } catch (_) {
      return ['Not started', 'In progress', 'Blocked', 'Complete'];
    }
  }

  function saveStatuses(list) {
    try {
      localStorage.setItem(STATUS_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  var projectStatuses = loadStatuses();

  // Projects store
  var PROJECTS_KEY = 'bizdash:projects:v1';

  function loadProjects() {
    try {
      var raw = localStorage.getItem(PROJECTS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveProjects(list) {
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  var projects = loadProjects();

  // Invoices store
  var INVOICES_KEY = 'bizdash:invoices:v1';

  function loadInvoices() {
    try {
      var raw = localStorage.getItem(INVOICES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveInvoices(list) {
    try {
      localStorage.setItem(INVOICES_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  var invoices = loadInvoices();

  function getInvoiceByIncomeTxId(txId) {
    return invoices.find(function (inv) { return inv.incomeTxId === txId; }) || null;
  }

  function nextInvoiceNumber() {
    var max = 0;
    invoices.forEach(function (inv) {
      var m = String(inv.number || '').match(/(\d+)$/);
      if (!m) return;
      var n = parseInt(m[1], 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return 'INV-' + String(max + 1).padStart(4, '0');
  }

  // ---------- Shared helpers ----------

  function populateProjectClientOptions() {
    var select = $('project-client');
    if (!select) return;
    var opts = ['<option value="">— None —</option>'];
    clients.forEach(function (c) {
      opts.push('<option value="' + (c.id || '') + '">' + (c.companyName || 'Untitled client') + '</option>');
    });
    select.innerHTML = opts.join('');
  }

  function populateProjectStatusOptions() {
    var select = $('project-status');
    if (!select) return;
    var opts = ['<option value="">— Select status —</option>'];
    projectStatuses.forEach(function (label) {
      opts.push('<option value="' + label + '">' + label + '</option>');
    });
    select.innerHTML = opts.join('');
  }

  function populateIncomeClientOptions() {
    var select = $('income-client');
    if (!select) return;
    var opts = ['<option value="">— None —</option>'];
    clients.forEach(function (c) {
      opts.push('<option value="' + (c.id || '') + '">' + (c.companyName || 'Untitled client') + '</option>');
    });
    select.innerHTML = opts.join('');
  }

  function populateIncomeProjectOptions() {
    var select = $('income-project');
    if (!select) return;
    var opts = ['<option value="">— None —</option>'];
    projects.forEach(function (p) {
      opts.push('<option value="' + (p.id || '') + '">' + (p.name || 'Untitled project') + '</option>');
    });
    select.innerHTML = opts.join('');
  }

  // ---------- Date helpers ----------

  function parseDate(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  function isWithinRange(dateStr, filter) {
    if (filter.mode === 'all') return true;
    var d = parseDate(dateStr);
    if (!d) return false;
    if (filter.mode === 'month') {
      var now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }
    if (filter.mode === 'range') {
      var start = filter.start ? parseDate(filter.start) : null;
      var end = filter.end ? parseDate(filter.end) : null;
      if (start && d < start) return false;
      if (end) {
        var endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
        if (d > endDay) return false;
      }
      return true;
    }
    return true;
  }

  // ---------- Compute ----------

  function compute(filter) {
    var txs = state.transactions.slice().filter(function (tx) {
      return isWithinRange(tx.date, filter);
    });

    var revenueByCat = { svc: 0, ret: 0 };
    var expenseByCat = { lab: 0, sw: 0, ads: 0, oth: 0 };

    txs.forEach(function (tx) {
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      switch (tx.category) {
        case 'svc':
        case 'ret':
          revenueByCat[tx.category] += amt;
          break;
        case 'lab':
        case 'sw':
        case 'ads':
        case 'oth':
          expenseByCat[tx.category] += amt;
          break;
      }
    });

    var revenueTotal = revenueByCat.svc + revenueByCat.ret;
    var expenseTotal = expenseByCat.lab + expenseByCat.sw + expenseByCat.ads + expenseByCat.oth;
    var net = revenueTotal - expenseTotal;

    return {
      filter: filter,
      txs: txs.sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      }),
      revenueByCat: revenueByCat,
      expenseByCat: expenseByCat,
      revenueTotal: revenueTotal,
      expenseTotal: expenseTotal,
      netProfit: net,
    };
  }

  // ---------- DOM helpers ----------

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function fmtCurrency(n) {
    var v = Math.round(n);
    return '$' + v.toLocaleString();
  }

  // ---------- Charts ----------

var expenseChart = null;
var revExpChart = null;
var projTypeChart = null;
var projMonthlyChart = null;
var revTrendChart = null;

  function renderExpenseChart(c) {
    var canvas = document.getElementById('cExp');
    if (!canvas || !window.Chart) return;

    var labels = [];
    var data = [];
    var colors = ['#e8501a', '#3366aa', '#a86e28', '#c8c7c2'];

    var map = [
      ['Labor', c.expenseByCat.lab],
      ['Software', c.expenseByCat.sw],
      ['Advertising', c.expenseByCat.ads],
      ['Other', c.expenseByCat.oth],
    ].filter(function (x) { return x[1] > 0.01; });

    if (map.length === 0) {
      labels = ['No expense data'];
      data = [1];
    } else {
      map.forEach(function (pair) {
        labels.push(pair[0]);
        data.push(pair[1]);
      });
    }

    if (!expenseChart) {
      expenseChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: map.length === 0 ? ['#e8e6e1'] : colors,
            borderWidth: 0,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '68%',
          plugins: { legend: { display: false } },
        },
      });
    } else {
      expenseChart.data.labels = labels;
      expenseChart.data.datasets[0].data = data;
      expenseChart.data.datasets[0].backgroundColor = map.length === 0 ? ['#e8e6e1'] : colors;
      expenseChart.update('none');
    }

    var leg = $('exp-leg');
    if (!leg) return;
    if (map.length === 0 || c.expenseTotal < 0.01) {
      leg.innerHTML = '<div style="font-size:12px;color:var(--text3);">No expense breakdown yet</div>';
      return;
    }
    leg.innerHTML = map.map(function (pair, idx) {
      var pct = Math.round(pair[1] / c.expenseTotal * 100);
      var color = colors[idx % colors.length];
      return '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;">' +
        '<span style="display:flex;align-items:center;gap:7px;color:var(--text2);">' +
        '<span style="width:9px;height:9px;border-radius:2px;background:' + color + ';display:inline-block;flex-shrink:0;"></span>' +
        pair[0] + '</span>' +
        '<span style="color:var(--text);font-weight:500;">' + pct + '%</span>' +
        '</div>';
    }).join('');
  }

  function renderRevenueVsExpenses(c) {
    var canvas = document.getElementById('cRevExp');
    if (!canvas || !window.Chart) return;

    // Group by month key YYYY-MM
    var revByMonth = {};
    var expByMonth = {};

    c.txs.forEach(function (tx) {
      var d = parseDate(tx.date);
      if (!d) return;
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (tx.category === 'svc' || tx.category === 'ret') {
        revByMonth[key] = (revByMonth[key] || 0) + amt;
      } else if (['lab','sw','ads','oth'].indexOf(tx.category) !== -1) {
        expByMonth[key] = (expByMonth[key] || 0) + amt;
      }
    });

    var keys = Object.keys(revByMonth).concat(Object.keys(expByMonth));
    if (!keys.length) {
      // No data; clear chart if it exists.
      if (revExpChart) {
        revExpChart.data.labels = [];
        revExpChart.data.datasets[0].data = [];
        revExpChart.data.datasets[1].data = [];
        revExpChart.update('none');
      }
      return;
    }

    // Unique + sort ascending, then keep last 6
    keys = Array.from(new Set(keys)).sort();
    if (keys.length > 6) {
      keys = keys.slice(keys.length - 6);
    }

    var labels = keys.map(function (key) {
      var parts = key.split('-').map(Number);
      return new Date(parts[0], parts[1] - 1, 1).toLocaleString('en-US', {
        month: 'short',
        year: '2-digit',
      });
    });
    var revData = keys.map(function (key) { return revByMonth[key] || 0; });
    var expData = keys.map(function (key) { return expByMonth[key] || 0; });

    if (!revExpChart) {
      revExpChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Revenue',
              data: revData,
              backgroundColor: '#e8501a',
              borderRadius: 4,
            },
            {
              label: 'Expenses',
              data: expData,
              backgroundColor: '#c0bfb8',
              borderRadius: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, position: 'bottom' },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { color: '#aaa99f', font: { size: 11 } },
            },
            y: {
              grid: { color: 'rgba(0,0,0,0.05)' },
              ticks: {
                color: '#aaa99f',
                font: { size: 11 },
                callback: function (v) { return '$' + v.toLocaleString(); },
              },
            },
          },
        },
      });
    } else {
      revExpChart.data.labels = labels;
      revExpChart.data.datasets[0].data = revData; // Revenue
      revExpChart.data.datasets[1].data = expData; // Expenses
      revExpChart.update('none');
    }
  }

  // ---------- Render ----------

  function renderKPIs(c) {
    setText('kpi-rev', fmtCurrency(c.revenueTotal));
    setText('kpi-exp', fmtCurrency(c.expenseTotal));
    setText('kpi-pft', fmtCurrency(c.netProfit));

    var pftEl = $('kpi-pft');
    if (pftEl) {
      pftEl.style.color = c.netProfit < 0 ? 'var(--red)' : '';
    }
  }

  function renderIncomeStatement(c) {
    var ops = $('dashboard-ops-statement');
    var legacy = $('dashboard-legacy-statement');
    if (ops) ops.style.display = 'block';
    if (legacy) legacy.style.display = 'none';

    var revLines = $('dashboard-revenue-lines');
    var expLines = $('dashboard-expense-lines');

    if (revLines) {
      var revMap = [
        ['Services', c.revenueByCat.svc],
        ['Retainers', c.revenueByCat.ret],
      ].filter(function (x) { return x[1] > 0.01; });
      revLines.innerHTML = revMap.length ? revMap.map(function (pair) {
        return '<div class="fr"><span class="lbl">' + pair[0] + '</span><span class="val pos">' + fmtCurrency(pair[1]) + '</span></div>';
      }).join('') : '<div class="fr"><span class="lbl">(none)</span><span class="val">$0</span></div>';
    }

    if (expLines) {
      var expMap = [
        ['Labor', c.expenseByCat.lab],
        ['Software & Tools', c.expenseByCat.sw],
        ['Advertising', c.expenseByCat.ads],
        ['Other', c.expenseByCat.oth],
      ].filter(function (x) { return x[1] > 0.01; });
      expLines.innerHTML = expMap.length ? expMap.map(function (pair) {
        return '<div class="fr"><span class="lbl">' + pair[0] + '</span><span class="val neg">−' + fmtCurrency(pair[1]) + '</span></div>';
      }).join('') : '<div class="fr"><span class="lbl">(none)</span><span class="val neg">−$0</span></div>';
    }

    setText('f-gro', fmtCurrency(c.revenueTotal));
    var fnet = $('f-net');
    if (fnet) {
      fnet.textContent = fmtCurrency(c.netProfit);
      fnet.className = 'val ' + (c.netProfit >= 0 ? 'pos' : 'neg');
    }
  }

  function renderTransactionLog(c) {
    var tbody = $('transaction-log-body');
    var empty = $('transaction-log-empty');
    var table = $('transaction-log-table');
    if (!tbody) return;
    if (c.txs.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    tbody.innerHTML = c.txs.map(function (tx) {
      var d = tx.date ? tx.date : '—';
      var catLabel = {
        svc: 'Services',
        ret: 'Retainers',
        lab: 'Labor',
        sw: 'Software',
        ads: 'Ads',
        oth: 'Other',
      }[tx.category] || tx.category || '—';
      return '<tr>' +
        '<td>' + d + '</td>' +
        '<td>' + catLabel + '</td>' +
        '<td class="tdp">' + fmtCurrency(tx.amount) + '</td>' +
        '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (tx.description || '') + '">' + (tx.description || '—') + '</td>' +
        '<td style="white-space:nowrap;"><button type="button" class="btn" data-tx-del="' + tx.id + '" style="font-size:11px;padding:4px 10px;color:var(--red);">Delete</button></td>' +
        '</tr>';
    }).join('');
  }

  function renderExpensesTable(c) {
    var tbody = $('expenses-tbody');
    var empty = $('expenses-empty');
    var table = $('expenses-table');
    if (!tbody) return;

    var expenseTxs = c.txs.filter(function (tx) {
      return ['lab','sw','ads','oth'].indexOf(tx.category) !== -1;
    });

    if (expenseTxs.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    tbody.innerHTML = expenseTxs.map(function (tx) {
      var label = {
        lab: 'Labor',
        sw: 'Software',
        ads: 'Advertising',
        oth: 'Other',
      }[tx.category] || tx.category || 'Expense';
      return '<tr>' +
        '<td>' + (tx.date || '—') + '</td>' +
        '<td class="tdp">' + label + '</td>' +
        '<td>' + label + '</td>' +
        '<td>' + fmtCurrency(tx.amount) + '</td>' +
        '<td>—</td>' +
        '<td>No</td>' +
        '<td style="white-space:nowrap;">' +
          '<button type="button" class="btn" data-exp-edit="' + tx.id + '" style="font-size:11px;padding:4px 10px;margin-right:6px;">Edit</button>' +
          '<button type="button" class="btn" data-exp-del="' + tx.id + '" style="font-size:11px;padding:4px 10px;color:var(--red);">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  function renderAll() {
    var c = state.computed;
    if (!c) return;
    renderKPIs(c);
    renderExpenseChart(c);
    renderIncomeStatement(c);
    renderTransactionLog(c);
    renderExpensesTable(c);
    renderRevenueVsExpenses(c);
    renderIncomeSection(c);
  }

  // ---------- Projects rendering ----------

  function renderProjects() {
    var tbody = $('projects-tbody');
    var empty = $('projects-empty');
    var table = $('projects-table');
    if (!tbody) return;

    if (!projects.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
    } else {
      if (empty) empty.style.display = 'none';
      if (table) table.style.display = 'table';
      tbody.innerHTML = projects.map(function (p) {
        var client = clients.find(function (c) { return c.id === p.clientId; });
        var clientName = client ? client.companyName : '—';
        return '<tr>' +
          '<td class="tdp">' + (p.name || 'Untitled') + '</td>' +
          '<td>' + clientName + '</td>' +
          '<td>' + (p.type || '—') + '</td>' +
          '<td>' + (p.description || '—') + '</td>' +
          '<td>' + (p.dueDate || '—') + '</td>' +
          '<td>' + fmtCurrency(p.value || 0) + '</td>' +
          '<td>' + (p.status || '—') + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button type="button" class="btn" data-project-edit="' + p.id + '" style="font-size:11px;padding:4px 10px;margin-right:6px;">Edit</button>' +
            '<button type="button" class="btn" data-project-del="' + p.id + '" style="font-size:11px;padding:4px 10px;color:var(--red);">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    // Simple KPIs and charts based on projects array
    renderProjectKpisAndCharts();
  }

  // ---------- Income (revenue page) ----------

  function renderIncomeSection(c) {
    // Revenue-only transactions, respecting current date filter (c.txs already filtered).
    var revTxs = c.txs.filter(function (tx) {
      return tx.category === 'svc' || tx.category === 'ret';
    });

    var now = new Date();
    var thisMonthKey = now.getFullYear() + '-' + now.getMonth();

    var collectedThisMonth = 0;

    // Group by month for Revenue Trend
    var revByMonth = {};

    revTxs.forEach(function (tx) {
      var d = parseDate(tx.date);
      if (!d) return;
      var key = d.getFullYear() + '-' + d.getMonth();
      revByMonth[key] = (revByMonth[key] || 0) + (+tx.amount || 0);
      if (key === thisMonthKey) {
        collectedThisMonth += (+tx.amount || 0);
      }
    });

    var invoiceForTx = {};
    revTxs.forEach(function (tx) {
      var inv = getInvoiceByIncomeTxId(tx.id);
      if (inv) invoiceForTx[tx.id] = inv;
    });

    // Outstanding + AR aging from invoices not marked paid
    var nowTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var bucketCurrent = 0;
    var bucket31 = 0;
    var bucket61 = 0;
    var bucket90 = 0;
    var outstandingTotal = 0;
    var sentCount = 0;
    var paidLagDays = 0;
    var paidCount = 0;

    invoices.forEach(function (inv) {
      var amt = +inv.amount || 0;
      if (amt <= 0) return;
      if (inv.status === 'sent' || inv.status === 'paid') sentCount += 1;

      if (inv.status === 'paid') {
        if (inv.paidAt && inv.dateIssued) {
          var paidAt = new Date(inv.paidAt).getTime();
          var issuedAt = new Date(inv.dateIssued).getTime();
          if (!isNaN(paidAt) && !isNaN(issuedAt) && paidAt >= issuedAt) {
            paidLagDays += Math.round((paidAt - issuedAt) / (1000 * 60 * 60 * 24));
            paidCount += 1;
          }
        }
        return;
      }

      outstandingTotal += amt;
      var dueTs = inv.dueDate ? new Date(inv.dueDate).getTime() : nowTs;
      if (isNaN(dueTs)) dueTs = nowTs;
      var daysOverdue = Math.max(0, Math.floor((nowTs - dueTs) / (1000 * 60 * 60 * 24)));
      if (daysOverdue <= 30) bucketCurrent += amt;
      else if (daysOverdue <= 60) bucket31 += amt;
      else if (daysOverdue <= 90) bucket61 += amt;
      else bucket90 += amt;
    });

    var avgDaysToPay = paidCount ? Math.round(paidLagDays / paidCount) : null;

    // KPIs
    setText('rev-kpi-1', fmtCurrency(collectedThisMonth));
    setText('rev-kpi-2', fmtCurrency(outstandingTotal));
    setText('rev-kpi-3', String(sentCount));
    setText('rev-kpi-4', avgDaysToPay == null ? '—' : String(avgDaysToPay));

    // AR section values + bars
    setText('ar-current-amt', fmtCurrency(bucketCurrent));
    setText('ar-31-60-amt', fmtCurrency(bucket31));
    setText('ar-61-90-amt', fmtCurrency(bucket61));
    setText('ar-90-plus-amt', fmtCurrency(bucket90));
    setText('ar-total-outstanding', fmtCurrency(outstandingTotal));
    var denom = outstandingTotal > 0 ? outstandingTotal : 1;
    var barCurrent = $('ar-current-bar');
    var bar31 = $('ar-31-60-bar');
    var bar61 = $('ar-61-90-bar');
    var bar90 = $('ar-90-plus-bar');
    if (barCurrent) barCurrent.style.width = Math.round((bucketCurrent / denom) * 100) + '%';
    if (bar31) bar31.style.width = Math.round((bucket31 / denom) * 100) + '%';
    if (bar61) bar61.style.width = Math.round((bucket61 / denom) * 100) + '%';
    if (bar90) bar90.style.width = Math.round((bucket90 / denom) * 100) + '%';

    // Income entries table
    var tbody = $('income-tbody');
    var empty = $('income-empty');
    var table = $('income-table');
    if (tbody) {
      if (!revTxs.length) {
        tbody.innerHTML = '';
        if (empty) empty.style.display = 'block';
        if (table) table.style.display = 'none';
      } else {
        if (empty) empty.style.display = 'none';
        if (table) table.style.display = 'table';
        var rows = revTxs.slice().sort(function (a, b) {
          return (b.date || '').localeCompare(a.date || '');
        }).map(function (tx) {
          var clientName = '—';
          if (tx.clientId) {
            var cl = clients.find(function (c) { return c.id === tx.clientId; });
            if (cl && cl.companyName) clientName = cl.companyName;
          }
          var projectName = '—';
          if (tx.projectId) {
            var pr = projects.find(function (p) { return p.id === tx.projectId; });
            if (pr && pr.name) projectName = pr.name;
          }
          var catLabel = tx.category === 'ret' ? 'Retainer' : 'Services';
          var inv = invoiceForTx[tx.id];
          var invBadge = inv
            ? ('<span class="pl ' + (inv.status === 'paid' ? 'pg-g' : 'pg-a') + '" style="margin-right:6px;">' +
              (inv.status === 'paid' ? 'Paid' : 'Sent') + '</span>')
            : '<span class="pl" style="margin-right:6px;background:var(--bg3);color:var(--text3);">No invoice</span>';
          return '<tr>' +
            '<td>' + (tx.date || '—') + '</td>' +
            '<td>' + (tx.description || '—') + '</td>' +
            '<td>' + clientName + '</td>' +
            '<td>' + projectName + '</td>' +
            '<td>' + catLabel + '</td>' +
            '<td class="tdp">' + fmtCurrency(tx.amount) + '</td>' +
            '<td style="white-space:nowrap;">' +
              invBadge +
              (inv
                ? '<button type="button" class="btn" data-income-invoice-edit="' + tx.id + '" style="font-size:11px;padding:4px 10px;margin-right:6px;">Edit invoice</button>'
                : '<button type="button" class="btn" data-income-invoice-create="' + tx.id + '" style="font-size:11px;padding:4px 10px;margin-right:6px;">Create invoice</button>') +
              (inv && inv.status !== 'paid'
                ? '<button type="button" class="btn" data-income-invoice-paid="' + tx.id + '" style="font-size:11px;padding:4px 10px;margin-right:6px;">Mark received</button>'
                : '') +
              '<button type="button" class="btn" data-income-edit="' + tx.id + '" style="font-size:11px;padding:4px 10px;margin-right:6px;">Edit</button>' +
              '<button type="button" class="btn" data-income-del="' + tx.id + '" style="font-size:11px;padding:4px 10px;color:var(--red);">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('');
        tbody.innerHTML = rows;
      }
    }

    // Revenue Trend chart (cRevT)
    var canvas = document.getElementById('cRevT');
    if (canvas && window.Chart) {
      var monthKeys = Object.keys(revByMonth);
      if (monthKeys.length) {
        monthKeys.sort();
        if (monthKeys.length > 6) {
          monthKeys = monthKeys.slice(monthKeys.length - 6);
        }
      }
      var labels = monthKeys.map(function (key) {
        var parts = key.split('-').map(Number);
        return new Date(parts[0], parts[1], 1).toLocaleString('en-US', {
          month: 'short',
          year: '2-digit',
        });
      });
      var data = monthKeys.map(function (k) { return revByMonth[k] || 0; });

      if (!revTrendChart) {
        revTrendChart = new Chart(canvas, {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{
              label: 'Revenue',
              data: data,
              backgroundColor: '#e8501a',
              borderRadius: 4,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { color: '#aaa99f', font: { size: 11 } },
              },
              y: {
                grid: { color: 'rgba(0,0,0,0.05)' },
                ticks: {
                  color: '#aaa99f',
                  font: { size: 11 },
                  callback: function (v) { return '$' + v.toLocaleString(); },
                },
              },
            },
          },
        });
      } else {
        revTrendChart.data.labels = labels;
        revTrendChart.data.datasets[0].data = data;
        revTrendChart.update('none');
      }
    }
  }

  function renderProjectKpisAndCharts() {
    var totalDelivered = 0;
    var byType = {};
    var byMonth = {};
    var totalDurationDays = 0;
    var durationCount = 0;
    var onTimeCount = 0;
    var completedCount = 0;
    var totalSatisfaction = 0;
    var satCount = 0;

    projects.forEach(function (p) {
      var status = (p.status || '').toLowerCase();
      var t = (p.type || 'Other').trim() || 'Other';
      byType[t] = (byType[t] || 0) + 1;

      var due = p.dueDate ? new Date(p.dueDate) : null;
      var start = p.startDate ? new Date(p.startDate) : null;
      if (due && !isNaN(due)) {
        var key = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0');
        byMonth[key] = (byMonth[key] || 0) + 1;
      }

      if (status.indexOf('complete') !== -1) {
        completedCount += 1;
        totalDelivered += 1;
        if (start && !isNaN(start) && due && !isNaN(due)) {
          var days = Math.max(1, Math.round((due - start) / (1000 * 60 * 60 * 24)));
          totalDurationDays += days;
          durationCount += 1;
        }
        // For now treat all completed projects as on-time (no explicit actual completion date field)
        onTimeCount += 1;
      }

      if (typeof p.satisfaction === 'number') {
        totalSatisfaction += p.satisfaction;
        satCount += 1;
      }
    });

    // KPIs
    setText('perf-kpi-1', String(totalDelivered));

    var onTimeRate = completedCount ? Math.round((onTimeCount / completedCount) * 100) : null;
    setText('perf-kpi-2', onTimeRate == null ? '—' : onTimeRate + '%');

    var avgDuration = durationCount ? Math.round(totalDurationDays / durationCount) : null;
    setText('perf-kpi-3', avgDuration == null ? '—' : avgDuration + ' days');

    var avgSat = satCount ? Math.round(totalSatisfaction / satCount) : null;
    setText('perf-kpi-4', avgSat == null ? '—' : avgSat + '/10');

    // Projects by Service Type chart (cSvc)
    var svcCanvas = document.getElementById('cSvc');
    if (svcCanvas && window.Chart) {
      var typeLabels = Object.keys(byType);
      var typeCounts = typeLabels.map(function (k) { return byType[k]; });
      if (!projTypeChart) {
        projTypeChart = new Chart(svcCanvas, {
          type: 'doughnut',
          data: {
            labels: typeLabels.length ? typeLabels : ['No projects'],
            datasets: [{
              data: typeLabels.length ? typeCounts : [1],
              backgroundColor: ['#e8501a','#3366aa','#a86e28','#4a8a4a','#c8c7c2'],
              borderWidth: 0,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: { legend: { display: true, position: 'bottom' } },
          },
        });
      } else {
        projTypeChart.data.labels = typeLabels.length ? typeLabels : ['No projects'];
        projTypeChart.data.datasets[0].data = typeLabels.length ? typeCounts : [1];
        projTypeChart.update('none');
      }
    }

    // Monthly Deliverables chart (cDel)
    var delCanvas = document.getElementById('cDel');
    if (delCanvas && window.Chart) {
      var monthKeys = Object.keys(byMonth);
      if (monthKeys.length) {
        monthKeys.sort();
        if (monthKeys.length > 6) {
          monthKeys = monthKeys.slice(monthKeys.length - 6);
        }
      }
      var monthLabels = monthKeys.map(function (key) {
        var parts = key.split('-').map(Number);
        return new Date(parts[0], parts[1] - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
      });
      var monthCounts = monthKeys.map(function (k) { return byMonth[k] || 0; });

      if (!projMonthlyChart) {
        projMonthlyChart = new Chart(delCanvas, {
          type: 'bar',
          data: {
            labels: monthLabels,
            datasets: [{
              label: 'Deliverables',
              data: monthCounts,
              backgroundColor: '#e8501a',
              borderRadius: 4,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { color: '#aaa99f', font: { size: 11 } },
              },
              y: {
                grid: { color: 'rgba(0,0,0,0.05)' },
                ticks: {
                  color: '#aaa99f',
                  font: { size: 11 },
                  precision: 0,
                },
              },
            },
          },
        });
      } else {
        projMonthlyChart.data.labels = monthLabels;
        projMonthlyChart.data.datasets[0].data = monthCounts;
        projMonthlyChart.update('none');
      }
    }
  }

  // ---------- Clients rendering ----------

  function computeClientKpis() {
    var total = clients.length;
    var activeRetainers = clients.filter(function (c) {
      return (c.status || '').toLowerCase().indexOf('retain') !== -1;
    }).length;
    var totalRevenue = clients.reduce(function (sum, c) {
      return sum + (c.totalRevenue || 0);
    }, 0);
    var avgValue = total ? totalRevenue / total : 0;
    return {
      total: total,
      activeRetainers: activeRetainers,
      avgValue: avgValue,
    };
  }

  function renderClients() {
    var tbody = $('customers-tbody');
    var empty = $('customers-empty');
    var table = $('customers-table');
    if (!tbody) return;

    if (!clients.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
    } else {
      if (empty) empty.style.display = 'none';
      if (table) table.style.display = 'table';
      tbody.innerHTML = clients.map(function (c) {
        return '<tr>' +
          '<td class="tdp">' + (c.companyName || '—') + '</td>' +
          '<td>' + (c.contactName || '—') + '</td>' +
          '<td>' + (c.email || '—') + '</td>' +
          '<td>' + (c.phone || '—') + '</td>' +
          '<td>' + (c.status || '—') + '</td>' +
          '<td>—</td>' +
          '<td>' + fmtCurrency(c.totalRevenue || 0) + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button type="button" class="btn" data-client-edit="' + c.id + '" style="font-size:11px;padding:4px 10px;margin-right:6px;">Edit</button>' +
            '<button type="button" class="btn" data-client-del="' + c.id + '" style="font-size:11px;padding:4px 10px;color:var(--red);">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    var k = computeClientKpis();
    setText('cust-kpi-1', String(k.total));
    setText('cust-kpi-2', String(k.activeRetainers));
    setText('cust-kpi-3', fmtCurrency(k.avgValue || 0));
  }

  // ---------- Mutations ----------

  function recomputeAndRender() {
    state.computed = compute(state.filter);
    renderAll();
  }

  function addTransaction(tx) {
    state.transactions.push(tx);
    saveTransactions(state.transactions);
    recomputeAndRender();
  }

  function deleteTransaction(id) {
    state.transactions = state.transactions.filter(function (tx) { return tx.id !== id; });
    invoices = invoices.filter(function (inv) { return inv.incomeTxId !== id; });
    saveTransactions(state.transactions);
    saveInvoices(invoices);
    recomputeAndRender();
  }

  // ---------- UI wiring ----------

  function openTransactionModal() {
    var modal = $('transactionModal');
    if (!modal) return;
    $('tx-date').value = new Date().toISOString().slice(0, 10);
    $('tx-amount').value = '';
    $('tx-note').value = '';
    $('tx-category').value = 'svc';
    var otherLabel = $('tx-other-label');
    var otherType = $('tx-other-type');
    if (otherLabel) otherLabel.value = '';
    if (otherType) otherType.value = '';
    modal.classList.add('on');
  }

  function closeTransactionModal() {
    var modal = $('transactionModal');
    if (modal) modal.classList.remove('on');
  }

  function wireTransactionForm() {
    var btnOpen1 = $('btn-open-transaction');
    var btnOpen2 = $('btn-open-transaction-2');
    var btnSave = $('btn-tx-save');
    var btnCancel = $('btn-tx-cancel');

    if (btnOpen1) btnOpen1.addEventListener('click', openTransactionModal);
    if (btnOpen2) btnOpen2.addEventListener('click', openTransactionModal);
    if (btnCancel) btnCancel.addEventListener('click', closeTransactionModal);
    // "Other expense" helpers are always visible; we just read their values when category is 'oth'.
    if (btnSave) {
      btnSave.addEventListener('click', function () {
        var amount = parseFloat(($('tx-amount').value || '').trim());
        if (!amount || amount <= 0) {
          alert('Enter a positive amount.');
          return;
        }
        var date = $('tx-date').value || new Date().toISOString().slice(0, 10);
        var category = $('tx-category').value || 'svc';
        var note = $('tx-note').value || '';
        var desc = note;
        if (category === 'oth') {
          var otherLabel = $('tx-other-label') ? $('tx-other-label').value.trim() : '';
          var otherType = $('tx-other-type') ? $('tx-other-type').value.trim() : '';
          var extraParts = [];
          if (otherLabel) extraParts.push(otherLabel);
          if (otherType) extraParts.push('(' + otherType + ')');
          var extra = extraParts.join(' ');
          if (extra) {
            desc = note ? note + ' · ' + extra : extra;
          }
        }
        addTransaction({
          id: uuid(),
          date: date,
          description: desc,
          amount: amount,
          category: category,
        });
        closeTransactionModal();
      });
    }
  }

  // Income / expense modals (Income tab, Expenses tab) wired into the same
  // transaction store.

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function openExpenseModal(existingTx) {
    var m = $('expenseModal');
    if (!m) return;
    var editId = $('expense-edit-id');
    var fDate = $('expense-date');
    var fAmount = $('expense-amount');
    var fTitle = $('expense-title');
    var fCat = $('expense-category');
    var fVendor = $('expense-vendor');
    var fNotes = $('expense-notes');

    if (existingTx) {
      if (editId) editId.value = existingTx.id || '';
      if (fDate) fDate.value = existingTx.date || todayISO();
      if (fAmount) fAmount.value = existingTx.amount != null ? String(existingTx.amount) : '';
      if (fTitle) fTitle.value = existingTx.title || '';
      if (fCat) fCat.value = existingTx.categoryLabel || '';
      if (fVendor) fVendor.value = existingTx.vendor || '';
      if (fNotes) fNotes.value = existingTx.notes || existingTx.description || '';
    } else {
      if (editId) editId.value = '';
      if (fDate) fDate.value = todayISO();
      if (fAmount) fAmount.value = '';
      if (fTitle) fTitle.value = '';
      if (fCat) fCat.value = '';
      if (fVendor) fVendor.value = '';
      if (fNotes) fNotes.value = '';
    }
    m.classList.add('on');
  }

  function closeExpenseModal() {
    var m = $('expenseModal');
    if (m) m.classList.remove('on');
  }

  function openIncomeModal() {
    var m = $('incomeModal');
    if (!m) return;
    var editId = $('income-edit-id');
    if (editId) editId.value = '';
    var fDate = $('income-date');
    var fAmount = $('income-amount');
    var fSource = $('income-source');
    var fCat = $('income-category');
    var fNotes = $('income-notes');
    if (fDate) fDate.value = todayISO();
    if (fAmount) fAmount.value = '';
    if (fSource) fSource.value = '';
    if (fCat) fCat.value = '';
    if (fNotes) fNotes.value = '';
    populateIncomeClientOptions();
    populateIncomeProjectOptions();
    m.classList.add('on');
  }

  function closeIncomeModal() {
    var m = $('incomeModal');
    if (m) m.classList.remove('on');
  }

  function createOrEditInvoiceForIncomeTx(txId, isEdit) {
    var tx = state.transactions.find(function (t) { return t.id === txId; });
    if (!tx) return;
    var existing = getInvoiceByIncomeTxId(txId);
    var today = new Date().toISOString().slice(0, 10);
    var defaultIssue = existing && existing.dateIssued ? existing.dateIssued : (tx.date || today);
    var issueDate = prompt('Invoice issue date (YYYY-MM-DD):', defaultIssue);
    if (!issueDate) return;
    var defaultDue = existing && existing.dueDate
      ? existing.dueDate
      : new Date(new Date(issueDate).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    var dueDate = prompt('Invoice due date (YYYY-MM-DD):', defaultDue);
    if (!dueDate) return;
    var defaultNumber = existing && existing.number ? existing.number : nextInvoiceNumber();
    var number = prompt('Invoice number:', defaultNumber);
    if (!number) return;
    var defaultAmount = existing && existing.amount ? String(existing.amount) : String(tx.amount || 0);
    var amountRaw = prompt('Invoice amount:', defaultAmount);
    if (!amountRaw) return;
    var amount = parseFloat(amountRaw);
    if (!amount || amount <= 0) {
      alert('Invoice amount must be greater than 0.');
      return;
    }

    if (existing) {
      invoices = invoices.map(function (inv) {
        if (inv.incomeTxId !== txId) return inv;
        return {
          id: inv.id,
          incomeTxId: txId,
          number: number,
          dateIssued: issueDate,
          dueDate: dueDate,
          amount: amount,
          status: inv.status || 'sent',
          paidAt: inv.paidAt || null,
        };
      });
    } else {
      invoices.push({
        id: uuid(),
        incomeTxId: txId,
        number: number,
        dateIssued: issueDate,
        dueDate: dueDate,
        amount: amount,
        status: 'sent',
        paidAt: null,
      });
    }
    saveInvoices(invoices);
    recomputeAndRender();
    if (!isEdit) {
      alert('Invoice created.');
    }
  }

  function mapExpenseCategory(raw) {
    var v = (raw || '').toLowerCase();
    if (v.match(/labor|payroll|team|staff/)) return 'lab';
    if (v.match(/soft|saas|tool/)) return 'sw';
    if (v.match(/ad|advertis|marketing|promo/)) return 'ads';
    return 'oth';
  }

  function mapIncomeCategory(raw) {
    var v = (raw || '').toLowerCase();
    if (v.match(/retain/)) return 'ret';
    return 'svc';
  }

  function wireIncomeExpenseForms() {
    // Expenses tab
    var btnAddExpense = $('btn-add-expense');
    var btnExpenseSave = $('btn-expense-save');
    var btnExpenseCancel = $('btn-expense-cancel');

    if (btnAddExpense) btnAddExpense.addEventListener('click', function () { openExpenseModal(null); });
    if (btnExpenseCancel) btnExpenseCancel.addEventListener('click', closeExpenseModal);
    if (btnExpenseSave) {
      btnExpenseSave.addEventListener('click', function () {
        var amount = parseFloat(($('expense-amount').value || '').trim());
        if (!amount || amount <= 0) {
          alert('Enter a positive amount.');
          return;
        }
        var date = $('expense-date').value || todayISO();
        var title = $('expense-title').value || '';
        var catText = $('expense-category').value || '';
        var vendor = $('expense-vendor').value || '';
        var notes = $('expense-notes').value || '';
        var cat = mapExpenseCategory(catText);
        var desc = title || vendor || notes;

        var editId = $('expense-edit-id') ? $('expense-edit-id').value : '';
        if (editId) {
          // Update existing transaction
          state.transactions = state.transactions.map(function (tx) {
            if (tx.id !== editId) return tx;
            return {
              id: tx.id,
              date: date,
              description: desc,
              amount: amount,
              category: cat,
            };
          });
          saveTransactions(state.transactions);
          recomputeAndRender();
        } else {
          // Create new expense transaction
          addTransaction({
            id: uuid(),
            date: date,
            description: desc,
            amount: amount,
            category: cat,
          });
        }
        closeExpenseModal();
      });
    }

    // Income tab
    var btnAddIncome = $('btn-add-income');
    var btnIncomeSave = $('btn-income-save');
    var btnIncomeCancel = $('btn-income-cancel');

    if (btnAddIncome) btnAddIncome.addEventListener('click', openIncomeModal);
    if (btnIncomeCancel) btnIncomeCancel.addEventListener('click', closeIncomeModal);
    if (btnIncomeSave) {
      btnIncomeSave.addEventListener('click', function () {
        var amount = parseFloat(($('income-amount').value || '').trim());
        if (!amount || amount <= 0) {
          alert('Enter a positive amount.');
          return;
        }
        var date = $('income-date').value || todayISO();
        var source = $('income-source').value || '';
        var catText = $('income-category').value || '';
        var notes = $('income-notes').value || '';
        var cat = mapIncomeCategory(catText);
        var desc = source || notes;
        var clientId = $('income-client') ? $('income-client').value : '';
        var projectId = $('income-project') ? $('income-project').value : '';
        var editId = $('income-edit-id') ? $('income-edit-id').value : '';
        if (editId) {
          state.transactions = state.transactions.map(function (tx) {
            if (tx.id !== editId) return tx;
            return {
              id: tx.id,
              date: date,
              description: desc,
              amount: amount,
              category: cat,
              clientId: clientId || null,
              projectId: projectId || null,
            };
          });
          saveTransactions(state.transactions);
          recomputeAndRender();
        } else {
          addTransaction({
            id: uuid(),
            date: date,
            description: desc,
            amount: amount,
            category: cat,
            clientId: clientId || null,
            projectId: projectId || null,
          });
        }
        closeIncomeModal();
      });
    }
  }

  function wireDeleteHandlers() {
    var txTable = $('transaction-log-table');
    if (txTable) {
      txTable.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-tx-del]');
        if (!btn) return;
        var id = btn.getAttribute('data-tx-del');
        if (!id) return;
        if (confirm('Delete this transaction?')) {
          deleteTransaction(id);
        }
      });
    }

    var expTable = $('expenses-table');
    if (expTable) {
      expTable.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-exp-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-exp-edit');
          if (!editId) return;
          var tx = state.transactions.find(function (t) { return t.id === editId; });
          if (!tx) return;
          var labelMap = {
            lab: 'Labor',
            sw: 'Software',
            ads: 'Advertising',
            oth: 'Other',
          };
          openExpenseModal({
            id: tx.id,
            date: tx.date,
            amount: tx.amount,
            categoryLabel: labelMap[tx.category] || tx.category || '',
            title: '',
            vendor: '',
            notes: tx.description || '',
          });
          return;
        }

        var delBtn = ev.target.closest('[data-exp-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-exp-del');
        if (!id) return;
        if (confirm('Delete this expense transaction?')) {
          deleteTransaction(id);
        }
      });
    }

    var custTable = $('customers-table');
    if (custTable) {
      custTable.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-client-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-client-edit');
          if (!editId) return;
          var client = clients.find(function (c) { return c.id === editId; });
          if (!client) return;
          var m = $('clientModal');
          if (!m) return;
          var hiddenId = $('client-edit-id');
          if (hiddenId) hiddenId.value = client.id;
          $('client-company').value = client.companyName || '';
          $('client-contact').value = client.contactName || '';
          $('client-status').value = client.status || '';
          $('client-email').value = client.email || '';
          $('client-phone').value = client.phone || '';
          $('client-notes').value = client.notes || '';
          m.classList.add('on');
          return;
        }

        var delBtn = ev.target.closest('[data-client-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-client-del');
        if (!id) return;
        if (confirm('Delete this client?')) {
          clients = clients.filter(function (c) { return c.id !== id; });
          saveClients(clients);
          renderClients();
        }
      });
    }

    var projTable = $('projects-table');
    if (projTable) {
      projTable.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-project-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-project-edit');
          if (!editId) return;
          var proj = projects.find(function (p) { return p.id === editId; });
          if (!proj) return;
          var m = $('projectModal');
          if (!m) return;
          var hiddenId = $('project-edit-id');
          if (hiddenId) hiddenId.value = proj.id;
          $('project-name').value = proj.name || '';
          populateProjectClientOptions();
          if (proj.clientId && $('project-client')) $('project-client').value = proj.clientId;
          populateProjectStatusOptions();
          if (proj.status && $('project-status')) $('project-status').value = proj.status;
          $('project-category').value = proj.type || '';
          $('project-start').value = proj.startDate || '';
          $('project-due').value = proj.dueDate || '';
          $('project-value').value = proj.value != null ? String(proj.value) : '';
          $('project-desc').value = proj.description || '';
          $('project-notes').value = proj.notes || '';
          var archived = $('project-archived');
          if (archived) archived.checked = !!proj.archived;
          m.classList.add('on');
          return;
        }

        var delBtn = ev.target.closest('[data-project-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-project-del');
        if (!id) return;
        if (confirm('Delete this project?')) {
          projects = projects.filter(function (p) { return p.id !== id; });
          saveProjects(projects);
          renderProjects();
          populateIncomeProjectOptions();
        }
      });
    }

    var incomeTable = $('income-table');
    if (incomeTable) {
      incomeTable.addEventListener('click', function (ev) {
        var createInvBtn = ev.target.closest('[data-income-invoice-create]');
        if (createInvBtn) {
          var createTxId = createInvBtn.getAttribute('data-income-invoice-create');
          if (!createTxId) return;
          createOrEditInvoiceForIncomeTx(createTxId, false);
          return;
        }

        var editInvBtn = ev.target.closest('[data-income-invoice-edit]');
        if (editInvBtn) {
          var editTxId = editInvBtn.getAttribute('data-income-invoice-edit');
          if (!editTxId) return;
          createOrEditInvoiceForIncomeTx(editTxId, true);
          return;
        }

        var paidBtn = ev.target.closest('[data-income-invoice-paid]');
        if (paidBtn) {
          var paidTxId = paidBtn.getAttribute('data-income-invoice-paid');
          if (!paidTxId) return;
          invoices = invoices.map(function (inv) {
            if (inv.incomeTxId !== paidTxId) return inv;
            return {
              id: inv.id,
              incomeTxId: inv.incomeTxId,
              number: inv.number,
              dateIssued: inv.dateIssued,
              dueDate: inv.dueDate,
              amount: inv.amount,
              status: 'paid',
              paidAt: new Date().toISOString().slice(0, 10),
            };
          });
          saveInvoices(invoices);
          recomputeAndRender();
          return;
        }

        var editBtn = ev.target.closest('[data-income-edit]');
        if (editBtn) {
          var editId = editBtn.getAttribute('data-income-edit');
          if (!editId) return;
          var tx = state.transactions.find(function (t) { return t.id === editId; });
          if (!tx) return;
          var m = $('incomeModal');
          if (!m) return;
          var hiddenId = $('income-edit-id');
          if (hiddenId) hiddenId.value = tx.id;
          var fDate = $('income-date');
          var fAmount = $('income-amount');
          var fSource = $('income-source');
          var fCat = $('income-category');
          var fNotes = $('income-notes');
          if (fDate) fDate.value = tx.date || todayISO();
          if (fAmount) fAmount.value = tx.amount != null ? String(tx.amount) : '';
          if (fSource) fSource.value = tx.description || '';
          if (fCat) fCat.value = tx.category === 'ret' ? 'Retainer' : 'Services';
          if (fNotes) fNotes.value = '';
          populateIncomeClientOptions();
          populateIncomeProjectOptions();
          if (tx.clientId && $('income-client')) $('income-client').value = tx.clientId;
          if (tx.projectId && $('income-project')) $('income-project').value = tx.projectId;
          m.classList.add('on');
          return;
        }

        var delBtn = ev.target.closest('[data-income-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-income-del');
        if (!id) return;
        if (confirm('Delete this income entry?')) {
          deleteTransaction(id);
        }
      });
    }
  }

  // ---------- Client form wiring ----------

  function wireClientForm() {
    var btnAddClient = $('btn-add-client');
    var btnClientSave = $('btn-client-save');
    var btnClientCancel = $('btn-client-cancel');

    function openClientModal() {
      var m = $('clientModal');
      if (!m) return;
      var editId = $('client-edit-id');
      if (editId) editId.value = '';
      $('client-company').value = '';
      $('client-contact').value = '';
      $('client-status').value = '';
      $('client-email').value = '';
      $('client-phone').value = '';
      $('client-notes').value = '';
      m.classList.add('on');
    }

    function closeClientModal() {
      var m = $('clientModal');
      if (m) m.classList.remove('on');
    }

    if (btnAddClient) btnAddClient.addEventListener('click', openClientModal);
    if (btnClientCancel) btnClientCancel.addEventListener('click', closeClientModal);
    if (btnClientSave) {
      btnClientSave.addEventListener('click', function () {
        var company = $('client-company').value.trim();
        if (!company) {
          alert('Company name is required.');
          return;
        }
        var existingId = $('client-edit-id') ? $('client-edit-id').value : '';
        if (existingId) {
          clients = clients.map(function (c) {
            if (c.id !== existingId) return c;
            return {
              id: c.id,
              companyName: company,
              contactName: $('client-contact').value.trim(),
              status: $('client-status').value.trim(),
              email: $('client-email').value.trim(),
              phone: $('client-phone').value.trim(),
              notes: $('client-notes').value.trim(),
              totalRevenue: c.totalRevenue || 0,
              createdAt: c.createdAt || Date.now(),
            };
          });
        } else {
          var client = {
            id: uuid(),
            companyName: company,
            contactName: $('client-contact').value.trim(),
            status: $('client-status').value.trim(),
            email: $('client-email').value.trim(),
            phone: $('client-phone').value.trim(),
            notes: $('client-notes').value.trim(),
            totalRevenue: 0,
            createdAt: Date.now(),
          };
          clients.push(client);
        }
        saveClients(clients);
        renderClients();
        // Keep project / income dropdowns in sync with new client list
        populateProjectClientOptions();
        populateIncomeClientOptions();
        closeClientModal();
      });
    }
  }

  // ---------- Projects & statuses wiring ----------

  function wireProjectsAndStatuses() {
    var btnAddProject = $('btn-add-project');
    var btnProjectSave = $('btn-project-save');
    var btnProjectCancel = $('btn-project-cancel');
    var btnManageStatuses = $('btn-manage-statuses');
    var btnStatusClose = $('btn-status-close');
    var btnStatusAdd = $('btn-status-add');
    var statusInput = $('status-new-label');
    var statusList = $('status-list');

    function renderStatusList() {
      if (!statusList) return;
      if (!projectStatuses.length) {
        statusList.innerHTML = '<div style="font-size:13px;color:var(--text3);padding:6px 0;">No custom statuses yet.</div>';
        return;
      }
      statusList.innerHTML = projectStatuses.map(function (label, idx) {
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">' +
          '<span>' + label + '</span>' +
          '<button type="button" class="btn" data-status-del="' + idx + '" style="font-size:11px;padding:3px 8px;color:var(--red);">Remove</button>' +
        '</div>';
      }).join('');
    }

    function openProjectModal() {
      var m = $('projectModal');
      if (!m) return;
      // Clear simple fields so the form starts fresh.
      var editId = $('project-edit-id');
      if (editId) editId.value = '';
      $('project-name').value = '';
      $('project-client').value = '';
      $('project-status').value = '';
      $('project-category').value = '';
      $('project-start').value = '';
      $('project-due').value = '';
      $('project-value').value = '';
      $('project-desc').value = '';
      $('project-notes').value = '';
      var archived = $('project-archived');
      if (archived) archived.checked = false;
      populateProjectClientOptions();
      populateProjectStatusOptions();
      m.classList.add('on');
    }

    function closeProjectModal() {
      var m = $('projectModal');
      if (m) m.classList.remove('on');
    }

    function openStatusModal() {
      var m = $('statusModal');
      if (m) {
        renderStatusList();
        // Also refresh the status dropdown used in the project modal so new labels appear there.
        populateProjectStatusOptions();
        m.classList.add('on');
      }
    }

    function closeStatusModal() {
      var m = $('statusModal');
      if (m) m.classList.remove('on');
    }

    if (btnAddProject) btnAddProject.addEventListener('click', openProjectModal);
    if (btnProjectCancel) btnProjectCancel.addEventListener('click', closeProjectModal);
    if (btnProjectSave) {
      btnProjectSave.addEventListener('click', function () {
        var name = $('project-name').value.trim();
        if (!name) {
          alert('Project name is required.');
          return;
        }
        var clientId = $('project-client').value || '';
        var statusVal = $('project-status').value || '';
        var type = $('project-category').value.trim();
        var start = $('project-start').value || '';
        var due = $('project-due').value || '';
        var value = parseFloat(($('project-value').value || '').trim()) || 0;
        var desc = $('project-desc').value.trim();
        var notes = $('project-notes').value.trim();
        var archived = $('project-archived') && $('project-archived').checked;

        var existingId = $('project-edit-id') ? $('project-edit-id').value : '';
        if (existingId) {
          projects = projects.map(function (p) {
            if (p.id !== existingId) return p;
            return {
              id: p.id,
              name: name,
              clientId: clientId || null,
              status: statusVal,
              type: type,
              startDate: start,
              dueDate: due,
              value: value,
              description: desc,
              notes: notes,
              archived: !!archived,
              createdAt: p.createdAt || Date.now(),
            };
          });
        } else {
          var proj = {
            id: uuid(),
            name: name,
            clientId: clientId || null,
            status: statusVal,
            type: type,
            startDate: start,
            dueDate: due,
            value: value,
            description: desc,
            notes: notes,
            archived: !!archived,
            createdAt: Date.now(),
          };
          projects.push(proj);
        }
        saveProjects(projects);
        renderProjects();
        closeProjectModal();
      });
    }

    if (btnManageStatuses) btnManageStatuses.addEventListener('click', openStatusModal);
    if (btnStatusClose) btnStatusClose.addEventListener('click', closeStatusModal);

    if (btnStatusAdd && statusInput) {
      btnStatusAdd.addEventListener('click', function () {
        var label = statusInput.value.trim();
        if (!label) return;
        projectStatuses.push(label);
        saveStatuses(projectStatuses);
        statusInput.value = '';
        renderStatusList();
      });
    }

    if (statusList) {
      statusList.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-status-del]');
        if (!btn) return;
        var idx = parseInt(btn.getAttribute('data-status-del'), 10);
        if (isNaN(idx)) return;
        projectStatuses.splice(idx, 1);
        saveStatuses(projectStatuses);
        renderStatusList();
      });
    }
  }

  function wireFilter() {
    var sel = $('dash-period-select');
    if (!sel) return;
    sel.innerHTML = '' +
      '<option value="all">All-Time</option>' +
      '<option value="month">This Month</option>' +
      '<option value="range">Custom range…</option>';

    var container = sel.parentElement;
    var startInput = document.createElement('input');
    startInput.type = 'date';
    startInput.id = 'filter-start';
    startInput.className = 'fi';
    startInput.style.maxWidth = '150px';
    startInput.style.display = 'none';

    var endInput = document.createElement('input');
    endInput.type = 'date';
    endInput.id = 'filter-end';
    endInput.className = 'fi';
    endInput.style.maxWidth = '150px';
    endInput.style.display = 'none';

    container.insertBefore(startInput, sel.nextSibling);
    container.insertBefore(endInput, startInput.nextSibling);

    function applyFilter() {
      var mode = sel.value || 'all';
      state.filter.mode = mode;
      if (mode === 'range') {
        startInput.style.display = '';
        endInput.style.display = '';
        state.filter.start = startInput.value || null;
        state.filter.end = endInput.value || null;
      } else {
        startInput.style.display = 'none';
        endInput.style.display = 'none';
        state.filter.start = null;
        state.filter.end = null;
      }
      recomputeAndRender();
    }

    sel.addEventListener('change', applyFilter);
    startInput.addEventListener('change', applyFilter);
    endInput.addEventListener('change', applyFilter);
  }

  function init() {
    state.transactions = loadTransactions();
    state.filter = { mode: 'all', start: null, end: null };
    state.computed = compute(state.filter);
    renderAll();
    if (typeof renderClients === 'function') {
      renderClients();
    }
    renderProjects();
    wireTransactionForm();
    wireIncomeExpenseForms();
    wireDeleteHandlers();
    wireClientForm();
    wireProjectsAndStatuses();
    wireFilter();

    // Simple page navigation wiring to replace the original bundle's nav().
    // Exposed globally so existing onclick="nav('dashboard', this)" continues to work.
    window.nav = function (pageId, el) {
      // Switch visible page
      var pages = document.querySelectorAll('.pg');
      pages.forEach(function (pg) {
        pg.classList.remove('on');
      });
      var target = document.getElementById('page-' + pageId);
      if (target) target.classList.add('on');

      // Sidebar active state
      var items = document.querySelectorAll('.ni');
      items.forEach(function (n) { n.classList.remove('active'); });
      if (el && el.classList) {
        el.classList.add('active');
      } else {
        var sideItem = document.querySelector('.ni[data-nav="' + pageId + '"]');
        if (sideItem) sideItem.classList.add('active');
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

