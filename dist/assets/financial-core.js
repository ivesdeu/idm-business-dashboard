// financial-core.js
// Standalone financial data layer: transactions are the single source of truth.

(function () {
  'use strict';

  // Supabase client/user (set by supabase-auth.js when available)
  var supabase = window.supabaseClient || null;
  var currentUser = window.currentUser || null;

  // Debug ingest: only on localhost — public origins cannot reach 127.0.0.1 (browser blocks loopback from HTTPS sites).
  function debugAgentLog(entry) {
    try {
      var h = window.location && window.location.hostname;
      if (h !== 'localhost' && h !== '127.0.0.1') return;
      fetch('http://127.0.0.1:7475/ingest/507d12bf-babb-4204-8816-34a6e29c9b5b', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'c7d7dd' },
        body: JSON.stringify(Object.assign({ sessionId: 'c7d7dd', timestamp: Date.now() }, entry)),
      }).catch(function () {});
    } catch (_) {}
  }

  var STORAGE_KEY = 'bizdash:transactions:v1';
  // Ids the user deleted locally; applied after remote merge so a row does not reappear in the ledger (expenses + transaction log) if the server delete lags or fails once.
  var TX_DELETED_IDS_KEY = 'bizdash:tx-deleted-ids:v1';

  function loadDeletedTxIdMap() {
    try {
      var raw = localStorage.getItem(TX_DELETED_IDS_KEY);
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function saveDeletedTxIdMap(map) {
    try {
      localStorage.setItem(TX_DELETED_IDS_KEY, JSON.stringify(map || {}));
    } catch (_) {}
  }

  function markTransactionsDeletedLocally(ids) {
    if (!ids || !ids.length) return;
    var m = loadDeletedTxIdMap();
    var ts = Date.now();
    ids.forEach(function (id) {
      if (id) m[id] = ts;
    });
    saveDeletedTxIdMap(m);
  }

  function pruneDeletedTxMarksAbsentFromRemote(remoteList) {
    var remoteIds = {};
    (remoteList || []).forEach(function (r) {
      if (r && r.id) remoteIds[r.id] = true;
    });
    var m = loadDeletedTxIdMap();
    var changed = false;
    Object.keys(m).forEach(function (id) {
      if (!remoteIds[id]) {
        delete m[id];
        changed = true;
      }
    });
    if (changed) saveDeletedTxIdMap(m);
  }

  function omitLocallyDeletedTransactions(list) {
    var m = loadDeletedTxIdMap();
    return (list || []).filter(function (tx) {
      return tx && tx.id && !m[tx.id];
    });
  }

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

  function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // RFC4122-ish fallback for older browsers.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      var v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  var state = {
    transactions: [],
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

  var clients = [];

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

  var projects = [];

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

  var invoices = [];

  // Marketing campaigns (local only)
  var CAMPAIGNS_KEY = 'bizdash:campaigns:v1';

  var CAMPAIGN_STATUS_PIPELINE = 'pipeline';
  var CAMPAIGN_STATUS_WON = 'won';
  var CAMPAIGN_STATUS_LOST = 'lost';

  function normalizeCampaign(c) {
    if (!c || typeof c !== 'object') return null;
    var next = Object.assign({}, c);
    if (!next.status || [CAMPAIGN_STATUS_PIPELINE, CAMPAIGN_STATUS_WON, CAMPAIGN_STATUS_LOST].indexOf(next.status) === -1) {
      next.status = CAMPAIGN_STATUS_PIPELINE;
    }
    next.pipelineValue = Math.max(0, Number(next.pipelineValue) || 0);
    return next;
  }

  function loadCampaigns() {
    try {
      var raw = localStorage.getItem(CAMPAIGNS_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeCampaign).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function saveCampaigns(list) {
    try {
      localStorage.setItem(CAMPAIGNS_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  var campaigns = [];

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

  function buildTransactionMetadata(tx) {
    var m = {};
    if (tx.title) m.title = tx.title;
    if (tx.vendor) m.vendor = tx.vendor;
    if (tx.notes) m.notes = tx.notes;
    if (tx.source) m.source = tx.source;
    if (tx.recurrence && typeof tx.recurrence === 'object') m.recurrence = tx.recurrence;
    if (tx.recurrenceSeriesId) m.recurrenceSeriesId = tx.recurrenceSeriesId;
    if (tx.expenseRecurringLead === true) m.expenseRecurringLead = true;
    if (tx.expenseRecurrenceInstance === true) m.expenseRecurrenceInstance = true;
    if (tx.recurring === true) m.recurring = true;
    return Object.keys(m).length ? m : null;
  }

  function applyTransactionMetadata(tx, meta) {
    if (!meta || typeof meta !== 'object') return tx;
    var out = Object.assign({}, tx);
    if (meta.title != null) out.title = meta.title;
    if (meta.vendor != null) out.vendor = meta.vendor;
    if (meta.notes != null) out.notes = meta.notes;
    if (meta.source != null) out.source = meta.source;
    if (meta.recurrence != null) out.recurrence = meta.recurrence;
    if (meta.recurrenceSeriesId != null) out.recurrenceSeriesId = meta.recurrenceSeriesId;
    if (meta.expenseRecurringLead === true) out.expenseRecurringLead = true;
    if (meta.expenseRecurrenceInstance === true) out.expenseRecurrenceInstance = true;
    if (meta.recurring === true) out.recurring = true;
    return out;
  }

  // Match Supabase `transactions` table + optional columns (see supabase/dashboard_sync.sql).
  function transactionRowForDb(tx, userId) {
    var line = tx.description || tx.title || tx.note || null;
    if (!line && (tx.vendor || tx.notes)) {
      line = [tx.title, tx.vendor, tx.notes].filter(function (s) { return s && String(s).trim(); }).join(' · ') || null;
    }
    var meta = buildTransactionMetadata(tx);
    var row = {
      id: tx.id,
      user_id: userId,
      date: tx.date,
      category: tx.category,
      amount: tx.amount,
      description: line,
      client_id: tx.clientId || null,
      project_id: tx.projectId || null,
      other_label: tx.otherLabel || null,
      other_type: tx.otherType || null,
      note: tx.note || null,
    };
    if (meta) row.metadata = meta;
    return row;
  }

  async function persistTransactionToSupabase(tx) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      // Still keep local cache in sync.
      saveTransactions(state.transactions);
      return;
    }

    var payload = transactionRowForDb(tx, currentUser.id);

    // #region agent log
    debugAgentLog({ runId: 'run1', hypothesisId: 'H1', location: 'financial-core.js:persistTransactionToSupabase', message: 'tx upsert payload shape', data: { keys: Object.keys(payload), hasClientIdKey: Object.prototype.hasOwnProperty.call(payload, 'client_id') } });
    // #endregion

    try {
      var result = await supabase
        .from('transactions')
        .upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('upsert transaction error', result.error);
      }
    } catch (err) {
      console.error('persistTransactionToSupabase error', err);
    }
  }

  async function deleteTransactionRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      saveTransactions(state.transactions);
      return;
    }
    try {
      var result = await supabase
        .from('transactions')
        .delete()
        .eq('id', id)
        .eq('user_id', currentUser.id);
      if (result.error) {
        console.error('delete transaction error', result.error);
      }
    } catch (err) {
      console.error('deleteTransactionRemote error', err);
    }
  }

  async function persistClientToSupabase(client) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      saveClients(clients);
      return;
    }

    var payload = {
      id: client.id,
      user_id: currentUser.id,
      company_name: client.companyName,
      contact_name: client.contactName,
      status: client.status,
      industry: client.industry,
      email: client.email,
      phone: client.phone,
      notes: client.notes,
      total_revenue: client.totalRevenue || 0,
      created_at: client.createdAt ? new Date(client.createdAt).toISOString() : new Date().toISOString(),
      // Requires column: is_retainer boolean (see Supabase clients table). Omit if not migrated yet.
      is_retainer: client.retainer === true,
    };

    try {
      var result = await supabase
        .from('clients')
        .upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('upsert client error', result.error);
        var errStr = JSON.stringify(result.error || {});
        if (/is_retainer|schema|column/i.test(errStr)) {
          var payload2 = Object.assign({}, payload);
          delete payload2.is_retainer;
          var result2 = await supabase.from('clients').upsert(payload2, { onConflict: 'id' });
          if (result2.error) console.error('upsert client (no is_retainer) error', result2.error);
        }
      }
    } catch (err) {
      console.error('persistClientToSupabase error', err);
    }
  }

  async function deleteClientRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      saveClients(clients);
      return;
    }
    try {
      var result = await supabase
        .from('clients')
        .delete()
        .eq('id', id)
        .eq('user_id', currentUser.id);
      if (result.error) {
        console.error('delete client error', result.error);
      }
    } catch (err) {
      console.error('deleteClientRemote error', err);
    }
  }

  // Load data from Supabase (or fall back to localStorage) for the signed-in user.

  function normalizeLocalIdsForSupabase() {
    var changed = false;
    var clientIdMap = {};
    var txIdMap = {};
    var projectIdMap = {};

    clients = (clients || []).map(function (c) {
      var oldId = c && c.id;
      if (isUuid(oldId)) return c;
      var newId = uuid();
      clientIdMap[oldId || ''] = newId;
      changed = true;
      return Object.assign({}, c, { id: newId });
    });

    projects = (projects || []).map(function (p) {
      if (!p) return p;
      var next = Object.assign({}, p);
      if (next.clientId && clientIdMap[next.clientId]) {
        next.clientId = clientIdMap[next.clientId];
        changed = true;
      }
      var oldPid = p.id;
      if (!isUuid(oldPid)) {
        var newPid = uuid();
        projectIdMap[oldPid || ''] = newPid;
        next.id = newPid;
        changed = true;
      }
      return next;
    });

    state.transactions = (state.transactions || []).map(function (tx) {
      var oldTxId = tx && tx.id;
      var next = Object.assign({}, tx);
      if (!isUuid(oldTxId)) {
        var newTxId = uuid();
        txIdMap[oldTxId || ''] = newTxId;
        next.id = newTxId;
        changed = true;
      }
      if (next.clientId && clientIdMap[next.clientId]) {
        next.clientId = clientIdMap[next.clientId];
        changed = true;
      }
      if (next.projectId && projectIdMap[next.projectId]) {
        next.projectId = projectIdMap[next.projectId];
        changed = true;
      }
      return next;
    });

    invoices = (invoices || []).map(function (inv) {
      if (!inv) return inv;
      var next = Object.assign({}, inv);
      if (!isUuid(next.id)) {
        next.id = uuid();
        changed = true;
      }
      if (next.incomeTxId && txIdMap[next.incomeTxId]) {
        next.incomeTxId = txIdMap[next.incomeTxId];
        changed = true;
      }
      return next;
    });

    campaigns = (campaigns || []).map(function (c) {
      if (!c) return c;
      if (isUuid(c.id)) return c;
      changed = true;
      return Object.assign({}, c, { id: uuid() });
    });

    if (changed) {
      saveTransactions(state.transactions);
      saveClients(clients);
      saveProjects(projects);
      saveInvoices(invoices);
      saveCampaigns(campaigns);
    }
  }

  async function uploadTransactionsToSupabase(list) {
    if (!supabase || !currentUser || !Array.isArray(list) || !list.length) return false;
    var payload = list.map(function (tx) {
      return transactionRowForDb(tx, currentUser.id);
    });
    // #region agent log
    debugAgentLog({ runId: 'run1', hypothesisId: 'H1', location: 'financial-core.js:uploadTransactionsToSupabase', message: 'bulk tx upsert first row keys', data: { count: payload.length, firstKeys: payload[0] ? Object.keys(payload[0]) : [], firstHasClientId: payload[0] ? Object.prototype.hasOwnProperty.call(payload[0], 'client_id') : null } });
    // #endregion
    try {
      var result = await supabase.from('transactions').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert transactions error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadTransactionsToSupabase error', err);
      return false;
    }
  }

  async function uploadClientsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !Array.isArray(list) || !list.length) return false;
    var payload = list.map(function (client) {
      return {
        id: client.id,
        user_id: currentUser.id,
        company_name: client.companyName,
        contact_name: client.contactName,
        status: client.status,
        industry: client.industry,
        email: client.email,
        phone: client.phone,
        notes: client.notes,
        total_revenue: client.totalRevenue || 0,
        created_at: client.createdAt ? new Date(client.createdAt).toISOString() : new Date().toISOString(),
        is_retainer: client.retainer === true,
      };
    });
    try {
      var result = await supabase.from('clients').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert clients error', result.error);
        var errStr = JSON.stringify(result.error || {});
        if (/is_retainer|schema|column/i.test(errStr)) {
          var payload2 = payload.map(function (row) {
            var copy = Object.assign({}, row);
            delete copy.is_retainer;
            return copy;
          });
          var result2 = await supabase.from('clients').upsert(payload2, { onConflict: 'id' });
          if (result2.error) {
            console.error('bulk upsert clients (no is_retainer) error', result2.error);
            return false;
          }
          return true;
        }
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadClientsToSupabase error', err);
      return false;
    }
  }

  function mergeRemoteWithLocalOrphans(localList, remoteRows, mapRow) {
    var remoteMapped = (remoteRows || []).map(mapRow);
    var rid = {};
    remoteMapped.forEach(function (x) {
      if (x && x.id) rid[x.id] = true;
    });
    var out = remoteMapped.slice();
    (localList || []).forEach(function (x) {
      if (x && x.id && !rid[x.id]) out.push(x);
    });
    return out;
  }

  function parseJsonbLoose(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch (_) {
        return null;
      }
    }
    return val;
  }

  function normalizeCaseStudyStrategyFromDb(raw) {
    var v = parseJsonbLoose(raw);
    if (v == null) return [];
    if (typeof v === 'string' && v.trim()) return [{ title: '', body: v.trim() }];
    if (!Array.isArray(v)) return [];
    if (!v.length) return [];
    if (typeof v[0] === 'string') {
      return v.map(function (s) {
        return { title: '', body: String(s || '') };
      }).filter(function (x) {
        return x.body;
      });
    }
    return v.map(function (it) {
      if (!it || typeof it !== 'object') return { title: '', body: '' };
      return { title: String(it.title || ''), body: String(it.body || '') };
    }).filter(function (x) {
      return x.title || x.body;
    });
  }

  function normalizeCaseStudyResultsFromDb(raw) {
    var v = parseJsonbLoose(raw);
    if (v == null) return [];
    if (Array.isArray(v)) {
      return v.map(function (x) {
        return String(x == null ? '' : x).trim();
      }).filter(Boolean);
    }
    if (typeof v === 'string' && v.trim()) {
      return v.split(/\n+/).map(function (s) {
        return s.trim();
      }).filter(Boolean);
    }
    return [];
  }

  function projectHasCaseStudyViewable(p) {
    if (!p) return false;
    if (p.caseStudyPublished) return true;
    if (p.caseStudyCategory && String(p.caseStudyCategory).trim()) return true;
    if (p.caseStudyChallenge && String(p.caseStudyChallenge).trim()) return true;
    var st = p.caseStudyStrategy;
    if (Array.isArray(st) && st.some(function (x) {
      return x && (String(x.title || '').trim() || String(x.body || '').trim());
    })) return true;
    var rs = p.caseStudyResults;
    if (Array.isArray(rs) && rs.some(function (s) {
      return String(s || '').trim();
    })) return true;
    return false;
  }

  function appendCaseStudyStrategyRow(title, body) {
    var list = $('case-study-strategy-list');
    if (!list) return;
    var wrap = document.createElement('div');
    wrap.className = 'case-strategy-row';
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--border);border-radius:var(--rl);background:var(--bg);';
    wrap.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
        '<span style="font-size:12px;font-weight:600;color:var(--text2);">Strategy point</span>' +
        '<button type="button" class="btn case-strategy-remove" style="color:var(--red);">Remove</button>' +
      '</div>' +
      '<input class="fi cs-strat-title" type="text" placeholder="Title (optional)" />' +
      '<textarea class="fi cs-strat-body" rows="2" style="min-height:48px;resize:vertical;" placeholder="Body"></textarea>';
    list.appendChild(wrap);
    var ti = wrap.querySelector('.cs-strat-title');
    var bd = wrap.querySelector('.cs-strat-body');
    if (ti) ti.value = title || '';
    if (bd) bd.value = body || '';
  }

  function clearCaseStudyForm() {
    var pub = $('project-case-study-published');
    if (pub) pub.checked = false;
    if ($('project-case-study-category')) $('project-case-study-category').value = '';
    if ($('project-case-study-challenge')) $('project-case-study-challenge').value = '';
    if ($('project-case-study-strategy-plain')) $('project-case-study-strategy-plain').value = '';
    if ($('project-case-study-results')) $('project-case-study-results').value = '';
    var list = $('case-study-strategy-list');
    if (list) list.innerHTML = '';
  }

  function fillCaseStudyForm(p) {
    clearCaseStudyForm();
    if (!p) return;
    if ($('project-case-study-published')) $('project-case-study-published').checked = !!p.caseStudyPublished;
    if ($('project-case-study-category')) $('project-case-study-category').value = p.caseStudyCategory || '';
    if ($('project-case-study-challenge')) $('project-case-study-challenge').value = p.caseStudyChallenge || '';
    var strat = Array.isArray(p.caseStudyStrategy) ? p.caseStudyStrategy : [];
    var meaningful = strat.filter(function (x) {
      return x && (String(x.title || '').trim() || String(x.body || '').trim());
    });
    if (meaningful.length === 1 && !String(meaningful[0].title || '').trim() && String(meaningful[0].body || '').trim()) {
      if ($('project-case-study-strategy-plain')) $('project-case-study-strategy-plain').value = meaningful[0].body;
    } else {
      meaningful.forEach(function (x) {
        appendCaseStudyStrategyRow(x.title || '', x.body || '');
      });
    }
    var res = Array.isArray(p.caseStudyResults) ? p.caseStudyResults : [];
    if ($('project-case-study-results')) $('project-case-study-results').value = res.join('\n');
  }

  function readCaseStudyFromUi() {
    var published = !!($('project-case-study-published') && $('project-case-study-published').checked);
    var category = ($('project-case-study-category') && $('project-case-study-category').value || '').trim();
    var challenge = ($('project-case-study-challenge') && $('project-case-study-challenge').value || '').trim();
    var resultsRaw = ($('project-case-study-results') && $('project-case-study-results').value || '').trim();
    var results = resultsRaw ? resultsRaw.split(/\n+/).map(function (s) {
      return s.trim();
    }).filter(Boolean) : [];
    var items = [];
    var list = document.querySelectorAll('#case-study-strategy-list .case-strategy-row');
    list.forEach(function (row) {
      var t = row.querySelector('.cs-strat-title');
      var b = row.querySelector('.cs-strat-body');
      var title = t ? t.value.trim() : '';
      var body = b ? b.value.trim() : '';
      if (title || body) items.push({ title: title, body: body });
    });
    if (!items.length) {
      var plain = ($('project-case-study-strategy-plain') && $('project-case-study-strategy-plain').value || '').trim();
      if (plain) items = [{ title: '', body: plain }];
    }
    return {
      caseStudyPublished: published,
      caseStudyCategory: category || null,
      caseStudyChallenge: challenge || null,
      caseStudyStrategy: items,
      caseStudyResults: results,
    };
  }

  // ---------- Projects (Supabase) ----------
  function mapProjectRow(row) {
    return {
      id: row.id,
      clientId: row.client_id || null,
      name: row.name || '',
      status: row.status || '',
      type: row.type || '',
      startDate: row.start_date ? String(row.start_date).slice(0, 10) : '',
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : '',
      value: Number(row.value || 0),
      description: row.description || '',
      notes: row.notes || '',
      satisfaction: row.satisfaction != null && row.satisfaction !== '' ? Number(row.satisfaction) : null,
      archived: !!row.archived,
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
      caseStudyPublished: !!row.case_study_published,
      caseStudyChallenge: row.case_study_challenge || '',
      caseStudyStrategy: normalizeCaseStudyStrategyFromDb(row.case_study_strategy),
      caseStudyResults: normalizeCaseStudyResultsFromDb(row.case_study_results),
      caseStudyCategory: row.case_study_category || '',
    };
  }

  function projectRowForDb(p, userId) {
    var strat = Array.isArray(p.caseStudyStrategy) ? p.caseStudyStrategy : [];
    var res = Array.isArray(p.caseStudyResults) ? p.caseStudyResults : [];
    return {
      id: p.id,
      user_id: userId,
      client_id: p.clientId || null,
      name: p.name || '',
      status: p.status || '',
      type: p.type || '',
      start_date: p.startDate || null,
      due_date: p.dueDate || null,
      value: p.value || 0,
      description: p.description || '',
      notes: p.notes || '',
      satisfaction: p.satisfaction != null && !isNaN(p.satisfaction) ? p.satisfaction : null,
      archived: !!p.archived,
      created_at: p.createdAt ? new Date(p.createdAt).toISOString() : new Date().toISOString(),
      case_study_published: !!p.caseStudyPublished,
      case_study_challenge: p.caseStudyChallenge || null,
      case_study_strategy: strat,
      case_study_results: res,
      case_study_category: p.caseStudyCategory || null,
    };
  }

  async function persistProjectToSupabase(p) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !p || !p.id) return;
    try {
      var result = await supabase.from('projects').upsert(projectRowForDb(p, currentUser.id), { onConflict: 'id' });
      if (result.error) console.error('upsert project error', result.error);
    } catch (err) {
      console.error('persistProjectToSupabase error', err);
    }
  }

  async function deleteProjectRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !id) return;
    try {
      await supabase.from('projects').delete().eq('id', id).eq('user_id', currentUser.id);
    } catch (err) {
      console.error('deleteProjectRemote error', err);
    }
  }

  async function claimUnassignedProjects(ids) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !ids || !ids.length) return;
    try {
      var res = await supabase.from('projects').update({ user_id: currentUser.id }).in('id', ids).is('user_id', null);
      if (res.error) console.warn('claimUnassignedProjects', res.error);
    } catch (e) {
      console.warn('claimUnassignedProjects error', e);
    }
  }

  async function fetchProjectsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return loadProjects();
    try {
      var result = await supabase.from('projects').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: true });
      if (result.error) {
        console.error('load projects error', result.error);
        return loadProjects();
      }
      var rows = result.data || [];
      if (!rows.length) {
        var legacy = await supabase.from('projects').select('*').is('user_id', null).order('created_at', { ascending: true });
        if (!legacy.error && legacy.data && legacy.data.length) {
          rows = legacy.data;
          claimUnassignedProjects(rows.map(function (r) { return r.id; }).filter(Boolean));
        }
      }
      return rows.map(mapProjectRow);
    } catch (err) {
      console.error('fetchProjectsFromSupabase error', err);
      return loadProjects();
    }
  }

  async function uploadProjectsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = list.map(function (p) { return projectRowForDb(p, currentUser.id); });
      var result = await supabase.from('projects').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert projects error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadProjectsToSupabase error', err);
      return false;
    }
  }

  // ---------- Invoices (Supabase) ----------
  function mapInvoiceRow(row) {
    return {
      id: row.id,
      incomeTxId: row.income_tx_id,
      number: row.number || '',
      dateIssued: row.date_issued ? String(row.date_issued).slice(0, 10) : '',
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : '',
      amount: Number(row.amount || 0),
      status: row.status || 'sent',
      paidAt: row.paid_at ? String(row.paid_at).slice(0, 10) : null,
    };
  }

  function invoiceRowForDb(inv, userId) {
    return {
      id: inv.id,
      user_id: userId,
      income_tx_id: inv.incomeTxId,
      number: inv.number,
      date_issued: inv.dateIssued,
      due_date: inv.dueDate,
      amount: inv.amount,
      status: inv.status || 'sent',
      paid_at: inv.paidAt || null,
    };
  }

  async function persistInvoiceToSupabase(inv) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !inv || !inv.id) return;
    try {
      var result = await supabase.from('invoices').upsert(invoiceRowForDb(inv, currentUser.id), { onConflict: 'id' });
      if (result.error) console.error('upsert invoice error', result.error);
    } catch (err) {
      console.error('persistInvoiceToSupabase error', err);
    }
  }

  async function deleteInvoiceRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !id) return;
    try {
      await supabase.from('invoices').delete().eq('id', id).eq('user_id', currentUser.id);
    } catch (err) {
      console.error('deleteInvoiceRemote error', err);
    }
  }

  async function claimUnassignedInvoices(ids) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !ids || !ids.length) return;
    try {
      var res = await supabase.from('invoices').update({ user_id: currentUser.id }).in('id', ids).is('user_id', null);
      if (res.error) console.warn('claimUnassignedInvoices', res.error);
    } catch (e) {
      console.warn('claimUnassignedInvoices error', e);
    }
  }

  async function fetchInvoicesFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return loadInvoices();
    try {
      var result = await supabase.from('invoices').select('*').eq('user_id', currentUser.id).order('date_issued', { ascending: false });
      if (result.error) {
        console.error('load invoices error', result.error);
        return loadInvoices();
      }
      var rows = result.data || [];
      if (!rows.length) {
        var legacy = await supabase.from('invoices').select('*').is('user_id', null);
        if (!legacy.error && legacy.data && legacy.data.length) {
          rows = legacy.data;
          claimUnassignedInvoices(rows.map(function (r) { return r.id; }).filter(Boolean));
        }
      }
      return rows.map(mapInvoiceRow);
    } catch (err) {
      console.error('fetchInvoicesFromSupabase error', err);
      return loadInvoices();
    }
  }

  async function uploadInvoicesToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = list.map(function (inv) { return invoiceRowForDb(inv, currentUser.id); });
      var result = await supabase.from('invoices').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert invoices error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadInvoicesToSupabase error', err);
      return false;
    }
  }

  // ---------- Campaigns (Supabase) ----------
  function mapCampaignRow(row) {
    var st = row.status;
    if ([CAMPAIGN_STATUS_PIPELINE, CAMPAIGN_STATUS_WON, CAMPAIGN_STATUS_LOST].indexOf(st) === -1) st = CAMPAIGN_STATUS_PIPELINE;
    return {
      id: row.id,
      name: row.name || '',
      channel: row.channel || '',
      startDate: row.start_date ? String(row.start_date).slice(0, 10) : '',
      notes: row.notes || '',
      pipelineValue: Math.max(0, Number(row.pipeline_value || 0)),
      status: st,
      createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    };
  }

  function campaignRowForDb(c, userId) {
    var n = normalizeCampaign(c);
    if (!n) return null;
    return {
      id: n.id,
      user_id: userId,
      name: n.name || '',
      channel: n.channel || '',
      start_date: n.startDate || null,
      notes: n.notes || '',
      pipeline_value: n.pipelineValue || 0,
      status: n.status || CAMPAIGN_STATUS_PIPELINE,
      created_at: n.createdAt ? new Date(n.createdAt).toISOString() : new Date().toISOString(),
    };
  }

  async function persistCampaignToSupabase(c) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !c || !c.id) return;
    var row = campaignRowForDb(c, currentUser.id);
    if (!row) return;
    try {
      var result = await supabase.from('campaigns').upsert(row, { onConflict: 'id' });
      if (result.error) console.error('upsert campaign error', result.error);
    } catch (err) {
      console.error('persistCampaignToSupabase error', err);
    }
  }

  async function deleteCampaignRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !id) return;
    try {
      await supabase.from('campaigns').delete().eq('id', id).eq('user_id', currentUser.id);
    } catch (err) {
      console.error('deleteCampaignRemote error', err);
    }
  }

  async function claimUnassignedCampaigns(ids) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !ids || !ids.length) return;
    try {
      var res = await supabase.from('campaigns').update({ user_id: currentUser.id }).in('id', ids).is('user_id', null);
      if (res.error) console.warn('claimUnassignedCampaigns', res.error);
    } catch (e) {
      console.warn('claimUnassignedCampaigns error', e);
    }
  }

  async function fetchCampaignsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return loadCampaigns();
    try {
      var result = await supabase.from('campaigns').select('*').eq('user_id', currentUser.id).order('start_date', { ascending: false });
      if (result.error) {
        console.error('load campaigns error', result.error);
        return loadCampaigns();
      }
      var rows = result.data || [];
      if (!rows.length) {
        var legacy = await supabase.from('campaigns').select('*').is('user_id', null);
        if (!legacy.error && legacy.data && legacy.data.length) {
          rows = legacy.data;
          claimUnassignedCampaigns(rows.map(function (r) { return r.id; }).filter(Boolean));
        }
      }
      return rows.map(mapCampaignRow);
    } catch (err) {
      console.error('fetchCampaignsFromSupabase error', err);
      return loadCampaigns();
    }
  }

  async function uploadCampaignsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = [];
      list.forEach(function (c) {
        var row = campaignRowForDb(normalizeCampaign(c) || c, currentUser.id);
        if (row) payload.push(row);
      });
      if (!payload.length) return true;
      var result = await supabase.from('campaigns').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert campaigns error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadCampaignsToSupabase error', err);
      return false;
    }
  }

  // ---------- App settings (custom project status labels) ----------
  async function fetchAppSettingsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return null;
    try {
      var result = await supabase.from('app_settings').select('*').eq('user_id', currentUser.id).maybeSingle();
      if (result.error) {
        console.error('load app_settings error', result.error);
        return null;
      }
      return result.data;
    } catch (err) {
      console.error('fetchAppSettingsFromSupabase error', err);
      return null;
    }
  }

  async function persistAppSettingsToSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return;
    try {
      var result = await supabase.from('app_settings').upsert({
        user_id: currentUser.id,
        project_statuses: projectStatuses,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' });
      if (result.error) console.error('upsert app_settings error', result.error);
    } catch (err) {
      console.error('persistAppSettingsToSupabase error', err);
    }
  }

  function mapTransactionRow(row) {
    var metaRaw = row.metadata;
    var meta = typeof metaRaw === 'string' ? (function () {
      try { return JSON.parse(metaRaw); } catch (_) { return null; }
    })() : metaRaw;
    var tx = {
      id: row.id,
      userId: row.user_id,
      date: row.date,
      category: row.category,
      amount: Number(row.amount || 0),
      description: row.description || row.note || '',
      note: row.note || row.description || '',
      clientId: row.client_id || null,
      projectId: row.project_id || null,
      otherLabel: row.other_label || '',
      otherType: row.other_type || '',
      source: row.source || '',
      createdAt: row.created_at || null,
    };
    return applyTransactionMetadata(tx, meta);
  }

  async function claimUnassignedTransactions(ids) {
    if (!supabase || !currentUser || !ids || !ids.length) return;
    try {
      var res = await supabase
        .from('transactions')
        .update({ user_id: currentUser.id })
        .in('id', ids)
        .is('user_id', null);
      if (res.error) {
        console.warn('Could not assign user_id to legacy rows (RLS may block). Run SQL in Supabase to set user_id, or add an UPDATE policy for unassigned rows.', res.error);
      }
    } catch (e) {
      console.warn('claimUnassignedTransactions error', e);
    }
  }

  async function fetchTransactionsFromSupabase() {
    // If Supabase or user is not ready, fall back to local cache.
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      return loadTransactions();
    }

    try {
      var result = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('date', { ascending: false });

      if (result.error) {
        console.error('load transactions error', result.error);
        return loadTransactions();
      }

      var rows = result.data || [];

      // Legacy rows were often inserted with user_id NULL; .eq(user_id) returns nothing on other devices.
      if (!rows.length) {
        var legacy = await supabase
          .from('transactions')
          .select('*')
          .is('user_id', null)
          .order('date', { ascending: false });
        if (legacy.error) {
          console.error('load legacy transactions error', legacy.error);
        } else if (legacy.data && legacy.data.length) {
          rows = legacy.data;
          var ids = rows.map(function (r) { return r.id; }).filter(Boolean);
          claimUnassignedTransactions(ids);
        }
      }

      return rows.map(mapTransactionRow);
    } catch (err) {
      console.error('fetchTransactionsFromSupabase error', err);
      return loadTransactions();
    }
  }

  function mapClientRow(row) {
    var st = row.status || '';
    var fromStatus = st.toLowerCase().indexOf('retain') !== -1;
    var ex = row.is_retainer;
    var retainer = ex === true || ex === false ? ex : fromStatus;
    return {
      id: row.id,
      companyName: row.company_name || '',
      contactName: row.contact_name || '',
      status: st,
      industry: row.industry || '',
      email: row.email || '',
      phone: row.phone || '',
      notes: row.notes || '',
      totalRevenue: Number(row.total_revenue || 0),
      createdAt: row.created_at || null,
      retainer: retainer,
    };
  }

  /**
   * Merge remote clients (source of truth for ids present on server) with local-only rows
   * so devices that never received a row still upload it. Preserve explicit retainer checkbox from local when ids match.
   */
  function mergeClientsPreserveRetainer(prevList, remoteList) {
    var prevById = {};
    (prevList || []).forEach(function (c) {
      if (c && c.id) prevById[c.id] = c;
    });
    var onServer = {};
    var out = (remoteList || []).map(function (c) {
      if (!c || !c.id) return null;
      onServer[c.id] = true;
      var prev = prevById[c.id];
      var next = Object.assign({}, c);
      if (prev && typeof prev.retainer === 'boolean') next.retainer = prev.retainer;
      return next;
    }).filter(Boolean);
    (prevList || []).forEach(function (c) {
      if (c && c.id && !onServer[c.id]) {
        out.push(Object.assign({}, c));
      }
    });
    return out;
  }

  function clientIsRetainer(c) {
    if (!c) return false;
    if (c.retainer === true) return true;
    return (c.status || '').toLowerCase().indexOf('retain') !== -1;
  }

  var TX_RECURRENCE_KEYS = ['recurrence', 'recurrenceSeriesId', 'expenseRecurringLead', 'expenseRecurrenceInstance', 'recurring'];

  function mergeTransactionsPreserveRecurrence(prevList, remoteList) {
    var prevById = {};
    (prevList || []).forEach(function (t) {
      if (t && t.id) prevById[t.id] = t;
    });
    return (remoteList || []).map(function (t) {
      var p = prevById[t.id];
      if (!p) return t;
      var next = Object.assign({}, t);
      TX_RECURRENCE_KEYS.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(p, k)) next[k] = p[k];
      });
      return next;
    });
  }

  async function claimUnassignedClients(ids) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !ids || !ids.length) return;
    try {
      var res = await supabase
        .from('clients')
        .update({ user_id: currentUser.id })
        .in('id', ids)
        .is('user_id', null);
      if (res.error) {
        console.warn('Could not assign user_id to legacy clients (RLS).', res.error);
      }
    } catch (e) {
      console.warn('claimUnassignedClients error', e);
    }
  }

  async function fetchClientsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      return loadClients();
    }

    try {
      var result = await supabase
        .from('clients')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: true });

      if (result.error) {
        console.error('load clients error', result.error);
        return loadClients();
      }

      var rows = result.data || [];

      if (!rows.length) {
        var legacy = await supabase
          .from('clients')
          .select('*')
          .is('user_id', null)
          .order('created_at', { ascending: true });
        if (legacy.error) {
          console.error('load legacy clients error', legacy.error);
        } else if (legacy.data && legacy.data.length) {
          rows = legacy.data;
          var ids = rows.map(function (r) { return r.id; }).filter(Boolean);
          claimUnassignedClients(ids);
        }
      }

      return rows.map(mapClientRow);
    } catch (err) {
      console.error('fetchClientsFromSupabase error', err);
      return loadClients();
    }
  }

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

  /** Options HTML for the inline status select in Active Projects (same labels as the modal). */
  function buildProjectRowStatusOptionsHtml(currentStatus) {
    var cur = String(currentStatus || '').trim();
    var opts = [];
    var seen = {};
    if (!cur) {
      opts.push('<option value="" selected>—</option>');
    }
    projectStatuses.forEach(function (label) {
      seen[label] = true;
      var selected = label === cur ? ' selected' : '';
      opts.push('<option value="' + esc(label) + '"' + selected + '>' + esc(label) + '</option>');
    });
    if (cur && !seen[cur]) {
      opts.unshift('<option value="' + esc(cur) + '" selected>' + esc(cur) + '</option>');
    }
    return opts.join('');
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

  /** Month, day, and full year for chart labels/tooltips (avoids "Mar 26" reading as month + day when 26 is the year). */
  function chartPointDateLabel(isoDateStr, fallbackYear, fallbackMonthIndex0) {
    var d = isoDateStr ? parseDate(isoDateStr) : null;
    if (!d || isNaN(d.getTime())) {
      d = new Date(fallbackYear, fallbackMonthIndex0, 1);
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
        case 'own':
          // Owner equity injection: tracked in ledger but excluded from revenue / expense / net.
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

  function fmtCurrencyPrecise(n) {
    var v = Number(n || 0);
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDateDisplay(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US');
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- Charts ----------

var expenseChart = null;
var revExpChart = null;
var projTypeChart = null;
var projMonthlyChart = null;
var revTrendChart = null;
var verticalChart = null;
var leadSourceChart = null;
var spendTrendChart = null;
var spendReportTooltipTitles = [];
var spendReportCsvPayload = null;
var spendReportUi = {
  slice: 'category',
  range: '90d',
  interval: 'weekly',
  chartType: 'line',
  tab: 'all',
  q: '',
};

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

    var revTotal = c.revenueTotal || 0;
    var expTotal = c.expenseTotal || 0;

    if (revTotal < 0.01 && expTotal < 0.01) {
      if (revExpChart) {
        revExpChart.data.labels = [];
        revExpChart.data.datasets[0].data = [];
        revExpChart.data.datasets[1].data = [];
        revExpChart.update('none');
      }
      return;
    }

    // Single x category so both bars group side-by-side (not one bar per axis slot).
    var labels = [''];
    var revData = [revTotal];
    var expData = [expTotal];

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
          datasets: {
            bar: {
              categoryPercentage: 0.45,
              barPercentage: 0.9,
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { display: false },
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
        own: 'Owner investment',
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
        '<td style="white-space:nowrap;"><button type="button" class="btn" data-tx-del="' + tx.id + '" style="color:var(--red);">Delete</button></td>' +
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
      var titleText = (tx.title && String(tx.title).trim()) || (tx.description && String(tx.description).trim()) || '—';
      var vendorText = (tx.vendor && String(tx.vendor).trim()) || '—';
      return '<tr>' +
        '<td>' + (tx.date || '—') + '</td>' +
        '<td class="tdp">' + titleText + '</td>' +
        '<td>' + label + '</td>' +
        '<td>' + fmtCurrency(tx.amount) + '</td>' +
        '<td>' + vendorText + '</td>' +
        '<td>' + (tx.expenseRecurringLead ? '<span class="pl pg-c">Series</span>' : tx.expenseRecurrenceInstance ? '<span class="pl pg-c">Yes</span>' : 'No') + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button type="button" class="btn" data-exp-edit="' + tx.id + '" style="margin-right:6px;">Edit</button>' +
          '<button type="button" class="btn" data-exp-del="' + tx.id + '" style="color:var(--red);">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');
  }

  var SPEND_EXP_CATS = ['lab', 'sw', 'ads', 'oth'];
  var SPEND_CAT_META = {
    lab: { label: 'Labor', color: '#e8501a' },
    sw: { label: 'Software', color: '#3366aa' },
    ads: { label: 'Advertising', color: '#a86e28' },
    oth: { label: 'Other', color: '#c8c7c2' },
  };

  function spendStartOfWeekMonday(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    var day = x.getDay();
    var diff = (day + 6) % 7;
    x.setDate(x.getDate() - diff);
    return x;
  }

  function spendEnumerateBuckets(rangeStart, rangeEnd, interval) {
    var keys = [];
    var shortLabels = [];
    var titles = [];
    var rs = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate(), 12, 0, 0, 0);
    var re = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate(), 12, 0, 0, 0);
    if (interval === 'daily') {
      var cur = new Date(rs);
      while (cur <= re) {
        var k = dateYMD(cur);
        keys.push(k);
        shortLabels.push(cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        titles.push(cur.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }));
        cur.setDate(cur.getDate() + 1);
      }
    } else if (interval === 'weekly') {
      var w0 = spendStartOfWeekMonday(rs);
      var curW = new Date(w0);
      while (curW <= re) {
        var wk = dateYMD(curW);
        keys.push(wk);
        var wEnd = new Date(curW);
        wEnd.setDate(wEnd.getDate() + 6);
        shortLabels.push(curW.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        titles.push('Week of ' + curW.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
          ' – ' + wEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
        curW.setDate(curW.getDate() + 7);
      }
    } else {
      var curM = new Date(rs.getFullYear(), rs.getMonth(), 1, 12, 0, 0, 0);
      var endM = new Date(re.getFullYear(), re.getMonth(), 1, 12, 0, 0, 0);
      while (curM <= endM) {
        var mk = curM.getFullYear() + '-' + String(curM.getMonth() + 1).padStart(2, '0');
        keys.push(mk);
        shortLabels.push(curM.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }));
        titles.push(curM.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
        curM.setMonth(curM.getMonth() + 1);
      }
    }
    return { keys: keys, shortLabels: shortLabels, titles: titles };
  }

  function spendTxBucketKey(txDateStr, interval) {
    var d = parseYMD(txDateStr);
    if (isNaN(d.getTime())) return null;
    if (interval === 'daily') return dateYMD(d);
    if (interval === 'weekly') return dateYMD(spendStartOfWeekMonday(d));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function spendResolveRange(mode, expenseTxs) {
    var now = new Date();
    now.setHours(12, 0, 0, 0);
    var today = dateYMD(now);
    var start;
    var end = today;
    if (mode === 'month') {
      start = dateYMD(new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0));
    } else if (mode === '30d') {
      var s30 = new Date(now);
      s30.setDate(s30.getDate() - 29);
      start = dateYMD(s30);
    } else if (mode === '90d') {
      var s90 = new Date(now);
      s90.setDate(s90.getDate() - 89);
      start = dateYMD(s90);
    } else if (mode === 'ytd') {
      start = dateYMD(new Date(now.getFullYear(), 0, 1, 12, 0, 0, 0));
    } else {
      var minD = null;
      var maxD = null;
      expenseTxs.forEach(function (tx) {
        var d = parseYMD(tx.date);
        if (isNaN(d.getTime())) return;
        if (!minD || d < minD) minD = d;
        if (!maxD || d > maxD) maxD = d;
      });
      if (!minD) {
        start = today;
        end = today;
      } else {
        start = dateYMD(minD);
        end = maxD && parseYMD(maxD) > parseYMD(today) ? dateYMD(maxD) : today;
      }
    }
    return { start: start, end: end, startDate: parseYMD(start), endDate: parseYMD(end) };
  }

  function spendPriorRange(startStr, endStr) {
    var a = parseYMD(startStr);
    var b = parseYMD(endStr);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return { start: startStr, end: endStr };
    var days = Math.max(1, Math.round((b - a) / 86400000) + 1);
    var pe = new Date(a);
    pe.setDate(pe.getDate() - 1);
    var ps = new Date(pe);
    ps.setDate(ps.getDate() - (days - 1));
    return { start: dateYMD(ps), end: dateYMD(pe) };
  }

  function spendFormatKpiSplit(n) {
    var v = Number(n || 0);
    var s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var dot = s.lastIndexOf('.');
    if (dot === -1) {
      return '<span class="spend-kpi-dollars">$' + esc(s) + '</span>';
    }
    return '<span class="spend-kpi-dollars">$' + esc(s.slice(0, dot)) + '</span>' +
      '<span class="spend-kpi-cents">' + esc(s.slice(dot)) + '</span>';
  }

  function spendMatchesQuery(tx, q) {
    if (!q) return true;
    var hay = [tx.title, tx.vendor, tx.description, tx.note, tx.notes].map(function (x) {
      return String(x || '').toLowerCase();
    }).join(' ');
    return hay.indexOf(q) !== -1;
  }

  function renderSpendingReport() {
    var canvas = document.getElementById('cSpendTrend');
    if (!canvas || !window.Chart) return;

    var slice = spendReportUi.slice;
    var rangeMode = spendReportUi.range;
    var interval = spendReportUi.interval;
    var chartType = spendReportUi.chartType;
    var tab = spendReportUi.tab;
    var q = (spendReportUi.q || '').trim().toLowerCase();

    var allExpense = (state.transactions || []).filter(function (tx) {
      return SPEND_EXP_CATS.indexOf(tx.category) !== -1 && (+tx.amount || 0) > 0;
    });

    var range = spendResolveRange(rangeMode, allExpense);
    var rs = range.startDate;
    var re = range.endDate;
    if (isNaN(rs.getTime()) || isNaN(re.getTime())) return;

    var inRange = allExpense.filter(function (tx) {
      if (!tx.date) return false;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return false;
      return d >= rs && d <= re;
    });

    var missingDates = allExpense.filter(function (tx) { return !tx.date || isNaN(parseYMD(tx.date).getTime()); }).length;
    if (missingDates) {
      console.warn('Spending chart: ' + missingDates + ' expense row(s) have no valid date and are omitted from the series.');
    }

    var forPills = inRange.filter(function (tx) { return spendMatchesQuery(tx, q); });

    var pillsEl = document.getElementById('spend-pills');
    var pillsLbl = document.getElementById('spend-pills-lbl');
    if (pillsLbl) {
      pillsLbl.textContent = slice === 'vendor' ? 'Vendor' : 'Category';
    }

    var pillDefs = [{ id: 'all', label: 'All', color: 'var(--text)' }];
    if (slice === 'category') {
      SPEND_EXP_CATS.forEach(function (k) {
        var has = forPills.some(function (tx) { return tx.category === k; });
        if (has) pillDefs.push({ id: 'cat:' + k, label: SPEND_CAT_META[k].label, color: SPEND_CAT_META[k].color });
      });
    } else {
      var venTot = {};
      forPills.forEach(function (tx) {
        var v = (tx.vendor && String(tx.vendor).trim()) || '—';
        venTot[v] = (venTot[v] || 0) + (+tx.amount || 0);
      });
      var venList = Object.keys(venTot).sort(function (a, b) { return venTot[b] - venTot[a]; });
      var maxV = 12;
      var top = venList.slice(0, maxV);
      var rest = venList.slice(maxV);
      var PAL = ['#e8501a', '#3366aa', '#4a8a4a', '#a86e28', '#3366cc', '#cc3333', '#7b2d8e', '#2d8e7b'];
      top.forEach(function (v, i) {
        pillDefs.push({ id: 'ven:' + v, label: v, color: PAL[i % PAL.length] });
      });
      if (rest.length) pillDefs.push({ id: 'ven:__other__', label: 'Other', color: '#c8c7c2' });
    }

    var tabOk = pillDefs.some(function (p) { return p.id === tab; });
    if (!tabOk) tab = 'all';
    spendReportUi.tab = tab;

    if (pillsEl) {
      pillsEl.innerHTML = pillDefs.map(function (p) {
        var on = p.id === tab ? ' on' : '';
        var dot = '<span class="spend-pill-dot" style="background:' + p.color + ';"></span>';
        return '<button type="button" class="spend-pill' + on + '" data-spend-tab="' + esc(p.id) + '">' + dot + esc(p.label) + '</button>';
      }).join('');
    }

    var filtered = forPills.filter(function (tx) {
      if (tab === 'all') return true;
      if (tab.indexOf('cat:') === 0) return tx.category === tab.slice(4);
      if (tab.indexOf('ven:') === 0) {
        var want = tab.slice(4);
        if (want === '__other__') {
          var topSet = {};
          pillDefs.forEach(function (p) {
            if (p.id.indexOf('ven:') === 0 && p.id !== 'ven:__other__') topSet[p.id.slice(4)] = true;
          });
          var v = (tx.vendor && String(tx.vendor).trim()) || '—';
          return !topSet[v];
        }
        var vv = (tx.vendor && String(tx.vendor).trim()) || '—';
        return vv === want;
      }
      return true;
    });

    var enumed = spendEnumerateBuckets(rs, re, interval);
    var keys = enumed.keys;
    var shortLabels = enumed.shortLabels;
    spendReportTooltipTitles = enumed.titles.slice();

    var sums = {};
    keys.forEach(function (k) { sums[k] = 0; });

    var useIndexAxis = filtered.length > 0 && filtered.every(function (tx) {
      return !tx.date || isNaN(parseYMD(tx.date).getTime());
    });

    if (!useIndexAxis) {
      filtered.forEach(function (tx) {
        var bk = spendTxBucketKey(tx.date, interval);
        if (bk && sums.hasOwnProperty(bk)) sums[bk] += (+tx.amount || 0);
      });
    } else {
      keys = filtered.map(function (_, i) { return 'i' + i; });
      shortLabels = filtered.map(function (_, i) { return 'Entry ' + (i + 1); });
      spendReportTooltipTitles = filtered.map(function (tx) {
        return (tx.title || tx.vendor || tx.description || 'Expense') + ' · ' + (tx.date || 'no date');
      });
      sums = {};
      filtered.forEach(function (tx, i) {
        sums['i' + i] = (+tx.amount || 0);
      });
    }

    if (!keys.length) {
      keys = ['_empty'];
      shortLabels = ['—'];
      spendReportTooltipTitles = ['No data in range'];
      sums = { _empty: 0 };
    }

    var dataVals = keys.map(function (k) { return Math.round((sums[k] || 0) * 100) / 100; });
    var periodTotal = dataVals.reduce(function (a, b) { return a + b; }, 0);

    var pr = spendPriorRange(range.start, range.end);
    var priorTxs = allExpense.filter(function (tx) {
      if (!tx.date) return false;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return false;
      return d >= parseYMD(pr.start) && d <= parseYMD(pr.end);
    }).filter(function (tx) { return spendMatchesQuery(tx, q); }).filter(function (tx) {
      if (tab === 'all') return true;
      if (tab.indexOf('cat:') === 0) return tx.category === tab.slice(4);
      if (tab.indexOf('ven:') === 0) {
        var want = tab.slice(4);
        if (want === '__other__') {
          var topSet = {};
          pillDefs.forEach(function (p) {
            if (p.id.indexOf('ven:') === 0 && p.id !== 'ven:__other__') topSet[p.id.slice(4)] = true;
          });
          var v = (tx.vendor && String(tx.vendor).trim()) || '—';
          return !topSet[v];
        }
        var vv = (tx.vendor && String(tx.vendor).trim()) || '—';
        return vv === want;
      }
      return true;
    });
    var priorTotal = 0;
    if (!useIndexAxis) {
      var pEnumPrior = spendEnumerateBuckets(parseYMD(pr.start), parseYMD(pr.end), interval);
      var priorSums = {};
      pEnumPrior.keys.forEach(function (k) { priorSums[k] = 0; });
      priorTxs.forEach(function (tx) {
        var bk = spendTxBucketKey(tx.date, interval);
        if (bk && priorSums.hasOwnProperty(bk)) priorSums[bk] += (+tx.amount || 0);
      });
      priorTotal = pEnumPrior.keys.reduce(function (a, k) { return a + (priorSums[k] || 0); }, 0);
    }

    var kpiPrimaryLbl = document.getElementById('spend-kpi-primary-lbl');
    var kpiSecondaryLbl = document.getElementById('spend-kpi-secondary-lbl');
    var kpiPrimaryVal = document.getElementById('spend-kpi-primary-val');
    var kpiSecondaryVal = document.getElementById('spend-kpi-secondary-val');

    if (kpiPrimaryLbl) {
      if (rangeMode === 'month') {
        kpiPrimaryLbl.textContent = re.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ' spend';
      } else if (rangeMode === '30d') {
        kpiPrimaryLbl.textContent = 'Last 30 days spend';
      } else if (rangeMode === '90d') {
        kpiPrimaryLbl.textContent = 'Last 90 days spend';
      } else if (rangeMode === 'ytd') {
        kpiPrimaryLbl.textContent = 'Year-to-date spend';
      } else {
        kpiPrimaryLbl.textContent = 'All-time spend';
      }
    }
    if (kpiSecondaryLbl) {
      kpiSecondaryLbl.textContent = 'Prior period · ' + fmtDateDisplay(pr.start) + ' – ' + fmtDateDisplay(pr.end);
    }
    if (kpiPrimaryVal) kpiPrimaryVal.innerHTML = spendFormatKpiSplit(periodTotal);
    if (kpiSecondaryVal) kpiSecondaryVal.innerHTML = spendFormatKpiSplit(priorTotal);

    spendReportCsvPayload = { labels: shortLabels.slice(), values: dataVals.slice(), titles: spendReportTooltipTitles.slice() };

    var avgRef = dataVals.length ? dataVals.reduce(function (a, b) { return a + b; }, 0) / dataVals.length : 0;
    avgRef = Math.round(avgRef * 100) / 100;
    var refLine = keys.map(function () { return avgRef; });

    var gridMuted = 'rgba(0,0,0,0.06)';
    var axisTick = '#aaa99f';
    var lineStroke = '#111110';
    var lineFill = 'rgba(17,17,16,0.07)';
    var refStroke = 'rgba(0,0,0,0.18)';

    if (spendTrendChart) {
      spendTrendChart.destroy();
      spendTrendChart = null;
    }

    var commonPlugins = {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#111110',
        titleColor: '#ffffff',
        bodyColor: '#ffffff',
        borderColor: 'rgba(255,255,255,0.12)',
        borderWidth: 1,
        padding: 10,
        cornerRadius: 6,
        displayColors: false,
        filter: function (item) { return item.datasetIndex === 0; },
        callbacks: {
          title: function (items) {
            var i = items[0].dataIndex;
            return spendReportTooltipTitles[i] || shortLabels[i] || '';
          },
          label: function (ctx) {
            var y = ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed;
            return fmtCurrencyPrecise(y);
          },
        },
      },
    };

    var commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          grid: { display: true, color: gridMuted, lineWidth: 1, drawTicks: false },
          ticks: { color: axisTick, font: { size: 11 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 14 },
          border: { display: false },
        },
        y: {
          grid: { display: false },
          ticks: {
            color: axisTick,
            font: { size: 11 },
            callback: function (v) { return '$' + Number(v).toLocaleString(); },
          },
          border: { display: false },
        },
      },
    };

    if (chartType === 'bar') {
      spendTrendChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: shortLabels,
          datasets: [
            {
              type: 'bar',
              label: 'Spend',
              data: dataVals,
              backgroundColor: 'rgba(17,17,16,0.2)',
              borderColor: lineStroke,
              borderWidth: 1,
              borderRadius: 4,
              order: 2,
            },
            {
              type: 'line',
              label: 'Average',
              data: refLine,
              borderColor: refStroke,
              borderDash: [5, 5],
              borderWidth: 1,
              pointRadius: 0,
              fill: false,
              tension: 0,
              order: 1,
            },
          ],
        },
        options: Object.assign({ plugins: commonPlugins }, commonOptions),
      });
    } else {
      spendTrendChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels: shortLabels,
          datasets: [
            {
              type: 'line',
              label: 'Spend',
              data: dataVals,
              borderColor: lineStroke,
              backgroundColor: lineFill,
              borderWidth: 2,
              fill: true,
              tension: 0.35,
              pointRadius: 0,
              pointHoverRadius: 6,
              pointHoverBackgroundColor: lineStroke,
              pointHoverBorderColor: '#ffffff',
              pointHoverBorderWidth: 2,
              order: 2,
            },
            {
              type: 'line',
              label: 'Average',
              data: refLine,
              borderColor: refStroke,
              borderDash: [5, 5],
              borderWidth: 1,
              pointRadius: 0,
              fill: false,
              tension: 0,
              order: 1,
            },
          ],
        },
        options: Object.assign({ plugins: commonPlugins }, commonOptions),
      });
    }

    var lineBtn = document.getElementById('spend-chart-line');
    var barBtn = document.getElementById('spend-chart-bar');
    if (lineBtn) lineBtn.classList.toggle('on', chartType === 'line');
    if (barBtn) barBtn.classList.toggle('on', chartType === 'bar');
  }

  function wireSpendingReport() {
    function syncFromDom() {
      var sl = document.getElementById('spend-slice');
      var rg = document.getElementById('spend-range');
      var iv = document.getElementById('spend-interval');
      if (sl) spendReportUi.slice = sl.value || 'category';
      if (rg) spendReportUi.range = rg.value || '90d';
      if (iv) spendReportUi.interval = iv.value || 'weekly';
    }

    var sliceEl = document.getElementById('spend-slice');
    var rangeEl = document.getElementById('spend-range');
    var intEl = document.getElementById('spend-interval');
    var qEl = document.getElementById('spend-filter-q');
    if (sliceEl) {
      sliceEl.addEventListener('change', function () {
        syncFromDom();
        spendReportUi.tab = 'all';
        if (state.computed) renderSpendingReport();
      });
    }
    if (rangeEl) {
      rangeEl.addEventListener('change', function () {
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }
    if (intEl) {
      intEl.addEventListener('change', function () {
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }
    if (qEl) {
      var t = null;
      qEl.addEventListener('input', function () {
        spendReportUi.q = qEl.value || '';
        clearTimeout(t);
        t = setTimeout(function () {
          if (state.computed) renderSpendingReport();
        }, 160);
      });
    }

    var pillHost = document.getElementById('spend-pills');
    if (pillHost) {
      pillHost.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-spend-tab]');
        if (!btn) return;
        spendReportUi.tab = btn.getAttribute('data-spend-tab') || 'all';
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }

    var lineB = document.getElementById('spend-chart-line');
    if (lineB) {
      lineB.addEventListener('click', function () {
        spendReportUi.chartType = 'line';
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }
    var barB = document.getElementById('spend-chart-bar');
    if (barB) {
      barB.addEventListener('click', function () {
        spendReportUi.chartType = 'bar';
        syncFromDom();
        if (state.computed) renderSpendingReport();
      });
    }

    var dl = document.getElementById('spend-download');
    if (dl) {
      dl.addEventListener('click', function () {
        var p = spendReportCsvPayload;
        if (!p || !p.labels || !p.labels.length) return;
        var rows = ['Period,Amount'];
        for (var i = 0; i < p.labels.length; i++) {
          var lab = String(p.titles && p.titles[i] != null ? p.titles[i] : p.labels[i]).replace(/"/g, '""');
          rows.push('"' + lab + '",' + (p.values[i] != null ? p.values[i] : 0));
        }
        var blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'spending-report.csv';
        a.click();
        URL.revokeObjectURL(a.href);
      });
    }

    syncFromDom();
  }

  function renderDashAR() {
    var empty = $('dash-ar-empty');
    var table = $('dash-ar-table');
    var tbody = $('dash-ar-body');
    if (!tbody) return;

    var now = new Date();
    var nowTs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    var outstanding = invoices.filter(function (inv) {
      return inv.status !== 'paid' && (+inv.amount || 0) > 0;
    }).sort(function (a, b) {
      return (a.dueDate || '').localeCompare(b.dueDate || '');
    });

    if (!outstanding.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
      setText('kpi-ar', '$0');
      return;
    }

    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    var total = 0;
    tbody.innerHTML = outstanding.map(function (inv) {
      var amt = +inv.amount || 0;
      total += amt;

      var clientName = '—';
      var tx = state.transactions && state.transactions.find(function (t) { return t.id === inv.incomeTxId; });
      if (tx && tx.clientId) {
        var cl = clients.find(function (c) { return c.id === tx.clientId; });
        if (cl) clientName = esc(cl.companyName || cl.contactName || '—');
      }
      if (clientName === '—' && inv.clientName) clientName = esc(inv.clientName);

      var dueStr = inv.dueDate || '—';
      var statusLabel = inv.status === 'sent' ? 'Sent' : inv.status === 'draft' ? 'Draft' : (inv.status || 'Unpaid');
      var statusClass = inv.status === 'sent' ? 'pg-b' : 'pg-a';

      var overdue = '';
      if (inv.dueDate) {
        var dueTs = new Date(inv.dueDate).getTime();
        if (!isNaN(dueTs) && dueTs < nowTs) {
          var days = Math.floor((nowTs - dueTs) / (1000 * 60 * 60 * 24));
          overdue = ' <span class="pl pg-r" style="font-size:10px;">' + days + 'd overdue</span>';
        }
      }

      return '<tr>' +
        '<td class="tdp">' + clientName + (inv.number ? '<br><span class="td-sub">' + esc(inv.number) + '</span>' : '') + '</td>' +
        '<td>' + fmtCurrency(amt) + '</td>' +
        '<td>' + esc(dueStr) + overdue + '</td>' +
        '<td><span class="pl ' + statusClass + '">' + esc(statusLabel) + '</span></td>' +
        '</tr>';
    }).join('');

    setText('kpi-ar', fmtCurrency(total));
  }

  function renderAll() {
    var c = state.computed;
    if (!c) return;
    renderKPIs(c);
    renderExpenseChart(c);
    renderIncomeStatement(c);
    renderTransactionLog(c);
    renderExpensesTable(c);
    renderSpendingReport();
    renderRevenueVsExpenses(c);
    renderIncomeSection(c);
    renderRevenueByVertical(c);
    renderInsights();
    renderMarketing();
    renderDashAR();
    renderClients();
  }

  function renderRevenueByVertical(c) {
    var canvas = document.getElementById('cVert');
    if (!canvas || !window.Chart) return;

    var byVertical = {};
    c.txs.forEach(function (tx) {
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = +tx.amount || 0;
      if (amt <= 0) return;

      var industry = 'Uncategorized';
      if (tx.clientId) {
        var cl = clients.find(function (cc) { return cc.id === tx.clientId; });
        if (cl && cl.industry && cl.industry.trim()) {
          industry = cl.industry.trim();
        }
      }
      byVertical[industry] = (byVertical[industry] || 0) + amt;
    });

    var labels = Object.keys(byVertical);
    var data = labels.map(function (k) { return byVertical[k]; });

    if (!labels.length) {
      labels = ['No data'];
      data = [1];
    }

    var colors = ['#e8501a', '#3366aa', '#4a8a4a', '#a86e28', '#c8c7c2',
                  '#7b2d8e', '#2d8e7b', '#8e2d3a', '#5a5a9e', '#9e8a2d'];

    if (!verticalChart) {
      verticalChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: colors,
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
      verticalChart.data.labels = labels;
      verticalChart.data.datasets[0].data = data;
      verticalChart.update('none');
    }
  }

  // ---------- Insights ----------

  var insTrendChart = null;

  function computeMonthlyRevenueSeries() {
    var byMonth = {};
    (state.transactions || []).forEach(function (tx) {
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = +tx.amount || 0;
      if (amt <= 0 || !tx.date) return;
      var key = tx.date.slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + amt;
    });
    var keys = Object.keys(byMonth).sort();
    return keys.map(function (k) { return { month: k, revenue: byMonth[k] }; });
  }

  function linearForecast(series) {
    var n = series.length;
    if (n < 2) return null;
    var xs = series.map(function (_, i) { return i; });
    var ys = series.map(function (s) { return s.revenue; });
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; sumXY += xs[i] * ys[i]; sumXX += xs[i] * xs[i]; }
    var denom = n * sumXX - sumX * sumX;
    if (!denom) return null;
    var slope = (n * sumXY - sumX * sumY) / denom;
    var intercept = (sumY - slope * sumX) / n;
    return { slope: slope, intercept: intercept, nextValue: Math.max(0, slope * n + intercept) };
  }

  function fmtMonthLabel(ym) {
    var parts = ym.split('-');
    var d = new Date(+parts[0], +parts[1] - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function nextMonthLabel(ym) {
    var parts = ym.split('-');
    var d = new Date(+parts[0], +parts[1], 1);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function renderInsights() {
    var allTxs = state.transactions || [];
    var now = new Date();
    var todayStr = dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12));

    // ---- Monthly revenue series ----
    var series = computeMonthlyRevenueSeries();
    var last3 = series.slice(-3);
    var avg3 = last3.length ? last3.reduce(function (s, x) { return s + x.revenue; }, 0) / last3.length : 0;
    var thisMonthKey = todayStr.slice(0, 7);
    var thisMonthRev = (series.find(function (s) { return s.month === thisMonthKey; }) || {}).revenue || 0;

    // ---- Expense totals ----
    var expByCat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    var expLabels = { lab: 'Labor', sw: 'Software & Tools', ads: 'Advertising', oth: 'Other' };
    allTxs.forEach(function (tx) {
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (expByCat.hasOwnProperty(tx.category)) expByCat[tx.category] += amt;
    });
    var expTotal = expByCat.lab + expByCat.sw + expByCat.ads + expByCat.oth;

    // ---- MRR from retainer clients ----
    var retainerClients = clients.filter(clientIsRetainer);
    var mrr = retainerClients.reduce(function (sum, c) {
      var rev = clientRevenueFromTransactions(c.id);
      return sum + (rev > 0 ? rev / Math.max(1, series.length) : 0);
    }, 0);

    // ---- Top client ----
    var clientRevs = clients.map(function (c) {
      return { client: c, rev: clientRevenueFromTransactions(c.id) };
    }).filter(function (x) { return x.rev > 0; }).sort(function (a, b) { return b.rev - a.rev; });
    var topClient = clientRevs[0] || null;

    // ---- Churn risk: clients with income tx but none in 60 days ----
    var churnRisk = clients.filter(function (c) {
      var incomeTxs = allTxs.filter(function (tx) {
        return tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
      });
      if (!incomeTxs.length) return false;
      var latestDate = incomeTxs.map(function (tx) { return tx.date; }).sort().pop();
      var diff = (parseYMD(todayStr) - parseYMD(latestDate)) / 86400000;
      return diff >= 60;
    });

    // ---- Forecast ----
    var forecast = linearForecast(series);

    // ---- Alerts ----
    var alertsEl = document.getElementById('insights-alerts');
    if (alertsEl) {
      var alerts = [];
      // Expense spike vs 3-month avg
      var thisMonthExp = 0;
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
        var amt = +tx.amount || 0;
        if (expByCat.hasOwnProperty(tx.category) && amt > 0) thisMonthExp += amt;
      });
      var last3Exp = [];
      for (var mi = 1; mi <= 3; mi++) {
        var d = new Date(now.getFullYear(), now.getMonth() - mi, 1);
        var mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        var mExp = 0;
        allTxs.forEach(function (tx) {
          if (!tx.date || tx.date.slice(0, 7) !== mk) return;
          var amt = +tx.amount || 0;
          if (expByCat.hasOwnProperty(tx.category) && amt > 0) mExp += amt;
        });
        last3Exp.push(mExp);
      }
      var avgExp3 = last3Exp.length ? last3Exp.reduce(function (a, b) { return a + b; }, 0) / last3Exp.length : 0;
      if (avgExp3 > 0 && thisMonthExp > avgExp3 * 1.35) {
        var pct = Math.round((thisMonthExp / avgExp3 - 1) * 100);
        alerts.push({ type: 'warn', msg: 'Expenses this month are <strong>' + pct + '% above</strong> your 3-month average (' + fmtCurrency(thisMonthExp) + ' vs avg ' + fmtCurrency(avgExp3) + ').' });
      }
      // Revenue vs avg
      if (avg3 > 0 && thisMonthRev > 0 && thisMonthRev < avg3 * 0.6) {
        alerts.push({ type: 'warn', msg: 'Revenue this month (' + fmtCurrency(thisMonthRev) + ') is tracking <strong>below</strong> your 3-month average of ' + fmtCurrency(avg3) + '.' });
      }
      if (avg3 > 0 && thisMonthRev > avg3 * 1.25) {
        var upPct = Math.round((thisMonthRev / avg3 - 1) * 100);
        alerts.push({ type: 'good', msg: 'Revenue this month is <strong>' + upPct + '% above</strong> your 3-month average — great month!' });
      }
      // Churn
      if (churnRisk.length) {
        alerts.push({ type: 'warn', msg: churnRisk.length + ' client' + (churnRisk.length > 1 ? 's have' : ' has') + ' had no income in 60+ days: <strong>' + churnRisk.map(function (c) { return esc(c.companyName || c.contactName || 'Unknown'); }).join(', ') + '</strong>.' });
      }
      // No retainers
      if (!retainerClients.length && clients.length > 0) {
        alerts.push({ type: 'info', msg: 'You have no retainer clients yet. Retainers provide predictable monthly revenue.' });
      }
      if (!alerts.length && allTxs.length > 0) {
        alerts.push({ type: 'good', msg: 'Everything looks healthy — no anomalies detected.' });
      }
      alertsEl.innerHTML = alerts.map(function (a) {
        var bg = a.type === 'good' ? 'var(--green-bg)' : a.type === 'warn' ? 'var(--amber-bg)' : 'var(--blue-bg)';
        var border = a.type === 'good' ? 'var(--green)' : a.type === 'warn' ? 'var(--amber)' : 'var(--blue)';
        var icon = a.type === 'good' ? '✓' : a.type === 'warn' ? '⚠' : 'ℹ';
        return '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:var(--r);background:' + bg + ';border-left:3px solid ' + border + ';">' +
          '<span style="font-size:14px;line-height:1.4;flex-shrink:0;">' + icon + '</span>' +
          '<span style="font-size:13px;line-height:1.5;color:var(--text);">' + a.msg + '</span>' +
          '</div>';
      }).join('');
    }

    // ---- KPI cards ----
    setText('ins-mrr', fmtCurrency(mrr));
    if (topClient) {
      setText('ins-top-client-rev', fmtCurrency(topClient.rev));
      setText('ins-top-client-name', esc(topClient.client.companyName || topClient.client.contactName || '—'));
    } else {
      setText('ins-top-client-rev', '$0');
      setText('ins-top-client-name', '—');
    }
    setText('ins-avg-monthly', fmtCurrency(avg3));
    setText('ins-churn-count', String(churnRisk.length));

    // ---- Trend badge ----
    if (forecast && series.length >= 2) {
      var lastRev = series[series.length - 1].revenue;
      var trendPct = lastRev > 0 ? Math.round((forecast.slope / lastRev) * 100) : 0;
      var trendBadge = document.getElementById('ins-trend-badge');
      if (trendBadge) {
        trendBadge.textContent = trendPct >= 0 ? '↑ ' + trendPct + '% trend' : '↓ ' + Math.abs(trendPct) + '% trend';
        trendBadge.style.color = trendPct >= 0 ? 'var(--green)' : 'var(--red)';
      }
    }

    // ---- Revenue trend chart ----
    var trendCanvas = document.getElementById('cInsTrend');
    if (trendCanvas && window.Chart) {
      var trendLabels = series.map(function (s) { return fmtMonthLabel(s.month); });
      var trendData = series.map(function (s) { return s.revenue; });
      if (!insTrendChart) {
        insTrendChart = new Chart(trendCanvas, {
          type: 'line',
          data: {
            labels: trendLabels,
            datasets: [{
              label: 'Revenue',
              data: trendData,
              borderColor: '#e8501a',
              backgroundColor: 'rgba(232,80,26,0.08)',
              borderWidth: 2,
              pointRadius: 3,
              fill: true,
              tension: 0.35,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: '#aaa99f', font: { size: 11 } } },
              y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { color: '#aaa99f', font: { size: 11 }, callback: function (v) { return '$' + v.toLocaleString(); } } },
            },
          },
        });
      } else {
        insTrendChart.data.labels = trendLabels;
        insTrendChart.data.datasets[0].data = trendData;
        insTrendChart.update('none');
      }
    }

    // ---- Expense breakdown ----
    var expBreakEl = document.getElementById('ins-expense-breakdown');
    if (expBreakEl) {
      var expPairs = Object.keys(expByCat).map(function (k) {
        return [expLabels[k], expByCat[k]];
      }).filter(function (p) { return p[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; });
      if (!expPairs.length) {
        expBreakEl.innerHTML = '<div style="font-size:13px;color:var(--text3);">No expense data yet.</div>';
      } else {
        expBreakEl.innerHTML = expPairs.map(function (p) {
          var pct = expTotal > 0 ? Math.round(p[1] / expTotal * 100) : 0;
          return '<div>' +
            '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;">' +
              '<span>' + esc(p[0]) + '</span>' +
              '<span style="font-weight:600;">' + fmtCurrency(p[1]) + ' <span style="font-weight:400;color:var(--text3);">(' + pct + '%)</span></span>' +
            '</div>' +
            '<div style="height:5px;background:var(--bg3);border-radius:3px;overflow:hidden;">' +
              '<div style="height:100%;width:' + pct + '%;background:var(--coral);border-radius:3px;"></div>' +
            '</div>' +
          '</div>';
        }).join('');
      }
    }

    // ---- Forecast card ----
    var forecastEl = document.getElementById('ins-forecast-body');
    if (forecastEl) {
      if (!forecast || series.length < 2) {
        forecastEl.innerHTML = '<div style="font-size:13px;color:var(--text3);">Need at least 2 months of data for a forecast.</div>';
      } else {
        var nextLabel = nextMonthLabel(series[series.length - 1].month);
        var lastActual = series[series.length - 1].revenue;
        var delta = forecast.nextValue - lastActual;
        var deltaColor = delta >= 0 ? 'var(--green)' : 'var(--red)';
        var deltaSign = delta >= 0 ? '+' : '';
        forecastEl.innerHTML =
          '<div style="font-size:13px;color:var(--text3);margin-bottom:12px;">' + nextLabel + '</div>' +
          '<div style="font-size:32px;font-weight:600;letter-spacing:-0.03em;margin-bottom:6px;">' + fmtCurrency(forecast.nextValue) + '</div>' +
          '<div style="font-size:13px;color:' + deltaColor + ';font-weight:500;">' + deltaSign + fmtCurrency(delta) + ' vs last month</div>' +
          '<div style="font-size:12px;color:var(--text3);margin-top:10px;line-height:1.5;">Based on a linear trend across ' + series.length + ' month' + (series.length > 1 ? 's' : '') + ' of data.</div>';
      }
    }

    // ---- Client performance table ----
    var clientsTbody = document.getElementById('ins-clients-tbody');
    var clientsTable = document.getElementById('ins-clients-table');
    var clientsEmpty = document.getElementById('ins-clients-empty');
    if (clientsTbody) {
      var sortedClients = clients.slice().sort(function (a, b) {
        return clientRevenueFromTransactions(b.id) - clientRevenueFromTransactions(a.id);
      });
      if (!sortedClients.length) {
        if (clientsEmpty) clientsEmpty.style.display = 'block';
        if (clientsTable) clientsTable.style.display = 'none';
      } else {
        if (clientsEmpty) clientsEmpty.style.display = 'none';
        if (clientsTable) clientsTable.style.display = 'table';
        clientsTbody.innerHTML = sortedClients.map(function (c) {
          var rev = clientRevenueFromTransactions(c.id);
          var pcount = clientProjectCount(c.id);
          var incomeTxs = allTxs.filter(function (tx) {
            return tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
          });
          var lastDate = incomeTxs.length ? incomeTxs.map(function (tx) { return tx.date; }).sort().pop() : null;
          var daysSince = lastDate ? Math.floor((parseYMD(todayStr) - parseYMD(lastDate)) / 86400000) : null;
          var activityLabel = daysSince === null ? '—' : daysSince === 0 ? 'Today' : daysSince + 'd ago';
          var activityColor = daysSince === null ? 'var(--text3)' : daysSince >= 60 ? 'var(--red)' : daysSince >= 30 ? 'var(--amber)' : 'var(--green)';
          var retainerBadge = clientIsRetainer(c) ? '<span class="pl pg-c">Retainer</span>' : '—';
          var statusBadge = (c.status || '—');
          return '<tr>' +
            '<td class="tdp">' + esc(c.companyName || c.contactName || '—') + '</td>' +
            '<td>' + fmtCurrency(rev) + '</td>' +
            '<td>' + (pcount || '—') + '</td>' +
            '<td>' + retainerBadge + '</td>' +
            '<td style="color:' + activityColor + ';font-weight:500;">' + activityLabel + '</td>' +
            '<td>' + esc(statusBadge) + '</td>' +
          '</tr>';
        }).join('');
      }
    }

    // ---- Churn risk list ----
    var churnList = document.getElementById('ins-churn-list');
    var churnEmpty = document.getElementById('ins-churn-empty');
    if (churnList) {
      if (!churnRisk.length) {
        if (churnEmpty) churnEmpty.style.display = 'block';
        churnList.innerHTML = '';
      } else {
        if (churnEmpty) churnEmpty.style.display = 'none';
        churnList.innerHTML = churnRisk.map(function (c) {
          var incomeTxs = allTxs.filter(function (tx) {
            return tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
          });
          var lastDate = incomeTxs.map(function (tx) { return tx.date; }).sort().pop();
          var daysSince = Math.floor((parseYMD(todayStr) - parseYMD(lastDate)) / 86400000);
          var rev = clientRevenueFromTransactions(c.id);
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-radius:var(--r);border:1px solid var(--border);background:var(--bg2);">' +
            '<div>' +
              '<div style="font-weight:600;font-size:14px;">' + esc(c.companyName || c.contactName || '—') + '</div>' +
              '<div style="font-size:12px;color:var(--text3);margin-top:3px;">Last income: ' + fmtDateDisplay(lastDate) + ' · Total revenue: ' + fmtCurrency(rev) + '</div>' +
            '</div>' +
            '<span class="pl pg-r">' + daysSince + 'd inactive</span>' +
          '</div>';
        }).join('');
      }
    }
  }

  function renderLeadSourcesChart(activePipeline) {
    var canvas = document.getElementById('cLead');
    if (!canvas || !window.Chart) return;

    var byChannel = {};
    (activePipeline || []).forEach(function (c) {
      var ch = (c.channel || '').trim() || 'Unspecified';
      byChannel[ch] = (byChannel[ch] || 0) + 1;
    });

    var pairs = Object.keys(byChannel).map(function (k) {
      return [k, byChannel[k]];
    }).sort(function (a, b) { return b[1] - a[1]; });

    var labels = [];
    var data = [];
    var colors = ['#e8501a', '#3366aa', '#a86e28', '#2d8a6e', '#7c6f9c', '#c0bfb8', '#c94a4a'];

    if (!pairs.length) {
      labels = ['No active pipeline'];
      data = [1];
    } else {
      pairs.forEach(function (p) {
        labels.push(p[0]);
        data.push(p[1]);
      });
    }

    var bg = !pairs.length
      ? ['#e8e6e1']
      : labels.map(function (_, i) { return colors[i % colors.length]; });

    if (!leadSourceChart) {
      leadSourceChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: bg,
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
      leadSourceChart.data.labels = labels;
      leadSourceChart.data.datasets[0].data = data;
      leadSourceChart.data.datasets[0].backgroundColor = bg;
      leadSourceChart.update('none');
    }
  }

  function renderMarketing() {
    var empty = $('campaigns-empty');
    var pipe = $('marketing-pipeline');
    if (!empty || !pipe) return;

    var activePipeline = campaigns.filter(function (c) {
      return (c.status || CAMPAIGN_STATUS_PIPELINE) === CAMPAIGN_STATUS_PIPELINE;
    });

    if (!campaigns.length) {
      empty.style.display = 'block';
      empty.textContent = 'No campaigns yet. Use + New Campaign to add one.';
      pipe.style.display = 'none';
      pipe.innerHTML = '';
    } else {
      empty.style.display = 'none';
      pipe.style.display = 'flex';
      if (!activePipeline.length) {
        pipe.innerHTML = '<div style="font-size:13px;color:var(--text3);line-height:1.5;padding:8px 0;">No active pipeline. Won or lost campaigns are hidden here—edit a campaign and set status to Pipeline to show it, or add a new campaign.</div>';
      } else {
        pipe.innerHTML = activePipeline.slice().sort(function (a, b) {
          return (b.startDate || '').localeCompare(a.startDate || '');
        }).map(function (c) {
          var val = fmtCurrency(c.pipelineValue || 0);
          return '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:12px;border:1px solid var(--border);border-radius:var(--r);background:var(--bg2);">' +
            '<div style="min-width:0;">' +
            '<div style="font-weight:600;font-size:14px;">' + esc(c.name || 'Untitled') + '</div>' +
            '<div style="font-size:12px;color:var(--text2);margin-top:4px;">' + esc(c.channel || '—') + ' · ' + esc(c.startDate || '—') + '</div>' +
            '<div style="font-size:12px;color:var(--text);margin-top:6px;font-weight:500;">' + val + ' pipeline</div>' +
            (c.notes ? '<div style="font-size:12px;color:var(--text3);margin-top:6px;">' + esc(c.notes) + '</div>' : '') +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;align-items:flex-end;">' +
            '<button type="button" class="btn" data-campaign-edit="' + esc(c.id) + '">Edit</button>' +
            '<button type="button" class="btn" data-campaign-del="' + esc(c.id) + '" style="color:var(--red);">Delete</button>' +
            '</div></div>';
        }).join('');
      }
    }

    var now = new Date();
    var monthKey = now.getFullYear() + '-' + now.getMonth();
    var startedThisMonth = campaigns.filter(function (c) {
      if (!c.startDate) return false;
      var d = new Date(c.startDate + 'T12:00:00');
      if (isNaN(d.getTime())) return false;
      return d.getFullYear() + '-' + d.getMonth() === monthKey;
    }).length;
    setText('mkt-kpi-1', String(startedThisMonth));

    var won = campaigns.filter(function (c) { return c.status === CAMPAIGN_STATUS_WON; }).length;
    var lost = campaigns.filter(function (c) { return c.status === CAMPAIGN_STATUS_LOST; }).length;
    var closed = won + lost;
    if (closed < 1) {
      setText('mkt-kpi-2', '—');
    } else {
      setText('mkt-kpi-2', Math.round(won / closed * 100) + '%');
    }

    var pipeSum = activePipeline.reduce(function (acc, c) {
      return acc + (Number(c.pipelineValue) || 0);
    }, 0);
    setText('mkt-kpi-3', fmtCurrency(pipeSum));

    renderLeadSourcesChart(activePipeline);
  }

  function openCampaignModal(editId) {
    var m = $('campaignModal');
    if (!m) return;
    var hid = $('campaign-edit-id');
    if (hid) hid.value = editId || '';
    var titleEl = $('campaign-modal-title');
    if (editId) {
      var camp = campaigns.find(function (c) { return c.id === editId; });
      if (!camp) return;
      if (titleEl) titleEl.textContent = 'Edit campaign';
      if ($('campaign-name')) $('campaign-name').value = camp.name || '';
      if ($('campaign-channel')) $('campaign-channel').value = camp.channel || '';
      if ($('campaign-start')) $('campaign-start').value = camp.startDate || todayISO();
      if ($('campaign-pipeline-value')) $('campaign-pipeline-value').value = camp.pipelineValue != null ? String(camp.pipelineValue) : '';
      if ($('campaign-status')) $('campaign-status').value = camp.status || CAMPAIGN_STATUS_PIPELINE;
      if ($('campaign-notes')) $('campaign-notes').value = camp.notes || '';
    } else {
      if (titleEl) titleEl.textContent = 'New campaign';
      if ($('campaign-name')) $('campaign-name').value = '';
      if ($('campaign-channel')) $('campaign-channel').value = '';
      if ($('campaign-start')) $('campaign-start').value = todayISO();
      if ($('campaign-pipeline-value')) $('campaign-pipeline-value').value = '';
      if ($('campaign-status')) $('campaign-status').value = CAMPAIGN_STATUS_PIPELINE;
      if ($('campaign-notes')) $('campaign-notes').value = '';
    }
    m.classList.add('on');
  }

  function closeCampaignModal() {
    var m = $('campaignModal');
    if (m) m.classList.remove('on');
    var hid = $('campaign-edit-id');
    if (hid) hid.value = '';
  }

  function wireMarketingCampaign() {
    var btn = $('btn-new-campaign');
    var modal = $('campaignModal');
    var btnCancel = $('btn-campaign-cancel');
    var btnSave = $('btn-campaign-save');
    if (btn) btn.addEventListener('click', function () { openCampaignModal(''); });
    if (btnCancel) btnCancel.addEventListener('click', closeCampaignModal);
    if (btnSave) {
      btnSave.addEventListener('click', function () {
        var name = ($('campaign-name') && $('campaign-name').value || '').trim();
        if (!name) {
          alert('Campaign name is required.');
          return;
        }
        var channel = ($('campaign-channel') && $('campaign-channel').value || '').trim();
        var startDate = ($('campaign-start') && $('campaign-start').value) || todayISO();
        var notes = ($('campaign-notes') && $('campaign-notes').value || '').trim();
        var pipelineVal = Math.max(0, parseFloat(($('campaign-pipeline-value') && $('campaign-pipeline-value').value) || '0') || 0);
        var statusRaw = ($('campaign-status') && $('campaign-status').value) || CAMPAIGN_STATUS_PIPELINE;
        var status = [CAMPAIGN_STATUS_PIPELINE, CAMPAIGN_STATUS_WON, CAMPAIGN_STATUS_LOST].indexOf(statusRaw) === -1
          ? CAMPAIGN_STATUS_PIPELINE
          : statusRaw;
        var existingId = ($('campaign-edit-id') && $('campaign-edit-id').value) || '';
        var savedCampaign = null;
        if (existingId) {
          campaigns = campaigns.map(function (c) {
            if (c.id !== existingId) return c;
            return normalizeCampaign({
              id: c.id,
              name: name,
              channel: channel,
              startDate: startDate,
              notes: notes,
              pipelineValue: pipelineVal,
              status: status,
              createdAt: c.createdAt || Date.now(),
            });
          });
          savedCampaign = campaigns.find(function (c) { return c.id === existingId; }) || null;
        } else {
          var newCamp = normalizeCampaign({
            id: uuid(),
            name: name,
            channel: channel,
            startDate: startDate,
            notes: notes,
            pipelineValue: pipelineVal,
            status: status,
            createdAt: Date.now(),
          });
          campaigns.push(newCamp);
          savedCampaign = newCamp;
        }
        saveCampaigns(campaigns);
        if (savedCampaign) persistCampaignToSupabase(savedCampaign);
        closeCampaignModal();
        renderMarketing();
      });
    }
    if (modal) {
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) closeCampaignModal();
      });
    }
  }

  function openCaseStudyViewModal(projectId) {
    var p = projects.find(function (x) { return x.id === projectId; });
    var modal = $('caseStudyViewModal');
    var body = $('case-study-view-body');
    if (!p || !modal || !body) return;
    var client = p.clientId ? clients.find(function (c) { return c.id === p.clientId; }) : null;
    var clientName = client && client.companyName ? client.companyName : '—';
    var industry = client && client.industry ? client.industry : '—';
    var period = '—';
    if (p.startDate || p.dueDate) {
      period = (p.startDate ? fmtDateDisplay(p.startDate) : '…') + ' – ' + (p.dueDate ? fmtDateDisplay(p.dueDate) : '…');
    }
    var pubBadge = p.caseStudyPublished
      ? '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:rgba(34,197,94,0.15);color:#15803d;font-size:12px;font-weight:600;">Published</span>'
      : '<span style="display:inline-block;padding:2px 10px;border-radius:999px;background:var(--bg2);color:var(--text3);font-size:12px;font-weight:600;">Draft</span>';

    var strategyHtml = '';
    (p.caseStudyStrategy || []).forEach(function (item) {
      if (!item || (!String(item.title || '').trim() && !String(item.body || '').trim())) return;
      strategyHtml += '<div style="margin-bottom:14px;">';
      if (String(item.title || '').trim()) {
        strategyHtml += '<div style="font-weight:700;margin-bottom:4px;">' + esc(item.title) + '</div>';
      }
      if (String(item.body || '').trim()) {
        strategyHtml += '<div style="color:var(--text2);white-space:pre-wrap;">' + esc(item.body) + '</div>';
      }
      strategyHtml += '</div>';
    });

    var results = Array.isArray(p.caseStudyResults) ? p.caseStudyResults : [];
    var resultsHtml = '';
    if (results.length) {
      resultsHtml = '<ul style="margin:0;padding-left:1.25em;">' + results.map(function (r) {
        return '<li style="margin-bottom:6px;">' + esc(String(r)) + '</li>';
      }).join('') + '</ul>';
    }

    var cat = (p.caseStudyCategory || '').trim();
    var challenge = (p.caseStudyChallenge || '').trim();

    body.innerHTML =
      '<div style="margin-bottom:18px;padding-bottom:16px;border-bottom:1px solid var(--border);">' +
        '<div style="font-size:20px;font-weight:700;margin-bottom:8px;">' + esc(p.name || 'Project') + '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px 16px;font-size:13px;color:var(--text2);">' +
          '<div><strong style="color:var(--text);">Client</strong> ' + esc(clientName) + '</div>' +
          '<div><strong style="color:var(--text);">Industry</strong> ' + esc(industry) + '</div>' +
          '<div><strong style="color:var(--text);">Work period</strong> ' + esc(period) + '</div>' +
          (p.type ? '<div><strong style="color:var(--text);">Project type</strong> ' + esc(p.type) + '</div>' : '') +
        '</div>' +
        '<div style="margin-top:10px;">' + pubBadge + '</div>' +
      '</div>' +
      (cat ? '<div style="margin-bottom:16px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:4px;">Case study category</div><div>' + esc(cat) + '</div></div>' : '') +
      (challenge ? '<div style="margin-bottom:16px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:6px;">The challenge</div><div style="white-space:pre-wrap;color:var(--text2);">' + esc(challenge) + '</div></div>' : '') +
      (strategyHtml ? '<div style="margin-bottom:16px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:8px;">Our strategy</div>' + strategyHtml + '</div>' : '') +
      (resultsHtml ? '<div style="margin-bottom:8px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text3);margin-bottom:8px;">The results</div>' + resultsHtml + '</div>' : '') +
      (!cat && !challenge && !strategyHtml && !resultsHtml ? '<div style="color:var(--text3);font-size:13px;">No case study copy yet. Use Edit to add challenge, strategy, and results.</div>' : '');

    modal.classList.add('on');
  }

  function closeCaseStudyViewModal() {
    var modal = $('caseStudyViewModal');
    if (modal) modal.classList.remove('on');
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
        var canView = projectHasCaseStudyViewable(p);
        var pubLabel = p.caseStudyPublished ? 'Yes' : 'No';
        var csCell = '<div style="font-size:12px;line-height:1.4;">' +
          '<div><span style="color:var(--text3);">Pub.</span> <strong>' + pubLabel + '</strong></div>';
        if (canView) {
          csCell += '<button type="button" class="btn" data-project-casestudy="' + esc(p.id) + '" style="margin-top:6px;">View</button>';
        } else {
          csCell += '<div style="margin-top:4px;color:var(--text3);">—</div>';
        }
        csCell += '</div>';
        return '<tr>' +
          '<td class="tdp">' + (p.name || 'Untitled') + '</td>' +
          '<td>' + clientName + '</td>' +
          '<td>' + (p.type || '—') + '</td>' +
          '<td>' + (p.description || '—') + '</td>' +
          '<td>' + (p.dueDate || '—') + '</td>' +
          '<td>' + fmtCurrency(p.value || 0) + '</td>' +
          '<td style="min-width:140px;">' +
            '<select class="fi project-row-status" data-project-status-id="' + esc(p.id) + '" ' +
            'style="width:100%;max-width:200px;box-sizing:border-box;">' +
            buildProjectRowStatusOptionsHtml(p.status) +
            '</select></td>' +
          '<td style="vertical-align:top;">' + csCell + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button type="button" class="btn" data-project-edit="' + p.id + '" style="margin-right:6px;">Edit</button>' +
            '<button type="button" class="btn" data-project-del="' + p.id + '" style="color:var(--red);">Delete</button>' +
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
    var revMonthLatestTxDate = {};

    revTxs.forEach(function (tx) {
      var d = parseDate(tx.date);
      if (!d) return;
      var key = d.getFullYear() + '-' + d.getMonth();
      revByMonth[key] = (revByMonth[key] || 0) + (+tx.amount || 0);
      var ds = (tx.date || '').trim();
      if (ds && (!revMonthLatestTxDate[key] || ds > revMonthLatestTxDate[key])) {
        revMonthLatestTxDate[key] = ds;
      }
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
                ? '<button type="button" class="btn" data-income-invoice-edit="' + tx.id + '" style="margin-right:6px;">Edit invoice</button>'
                : '<button type="button" class="btn" data-income-invoice-create="' + tx.id + '" style="margin-right:6px;">Create invoice</button>') +
              (inv
                ? '<button type="button" class="btn" data-income-invoice-view="' + tx.id + '" style="margin-right:6px;">View invoice</button>'
                : '') +
              (inv && inv.status !== 'paid'
                ? '<button type="button" class="btn" data-income-invoice-paid="' + tx.id + '" style="margin-right:6px;">Mark received</button>'
                : '') +
              '<button type="button" class="btn" data-income-edit="' + tx.id + '" style="margin-right:6px;">Edit</button>' +
              '<button type="button" class="btn" data-income-del="' + tx.id + '" style="color:var(--red);">Delete</button>' +
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
        monthKeys.sort(function (a, b) {
          var pa = a.split('-').map(Number);
          var pb = b.split('-').map(Number);
          if (pa[0] !== pb[0]) return pa[0] - pb[0];
          return pa[1] - pb[1];
        });
        if (monthKeys.length > 6) {
          monthKeys = monthKeys.slice(monthKeys.length - 6);
        }
      }
      var labels = monthKeys.map(function (key) {
        var parts = key.split('-').map(Number);
        var y = parts[0];
        var m0 = parts[1];
        return chartPointDateLabel(revMonthLatestTxDate[key], y, m0);
      });
      var data = monthKeys.map(function (k) { return revByMonth[k] || 0; });

      if (revTrendChart && revTrendChart.config && revTrendChart.config.type !== 'line') {
        revTrendChart.destroy();
        revTrendChart = null;
      }

      if (!revTrendChart) {
        revTrendChart = new Chart(canvas, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'Revenue',
              data: data,
              borderColor: '#e8501a',
              backgroundColor: 'rgba(232, 80, 26, 0.12)',
              borderWidth: 2,
              fill: true,
              tension: 0.35,
              pointBackgroundColor: '#e8501a',
              pointBorderColor: '#ffffff',
              pointBorderWidth: 2,
              pointRadius: 4,
              pointHoverRadius: 6,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
              legend: { display: false },
            },
            scales: {
              x: {
                grid: { display: false },
                ticks: { color: '#aaa99f', font: { size: 11 } },
              },
              y: {
                beginAtZero: true,
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
    var deliverMonthLatestDue = {};
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
        var dueStr = (p.dueDate || '').trim();
        if (dueStr && (!deliverMonthLatestDue[key] || dueStr > deliverMonthLatestDue[key])) {
          deliverMonthLatestDue[key] = dueStr;
        }
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
        var y = parts[0];
        var m1 = parts[1];
        return chartPointDateLabel(deliverMonthLatestDue[key], y, m1 - 1);
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

  /** Sum of recorded income (svc + ret) for a client from transactions (source of truth for this app). */
  function clientRevenueFromTransactions(clientId) {
    if (!clientId) return 0;
    var sum = 0;
    (state.transactions || []).forEach(function (tx) {
      if (tx.clientId !== clientId) return;
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = +tx.amount || 0;
      if (amt > 0) sum += amt;
    });
    return sum;
  }

  function clientProjectCount(clientId) {
    if (!clientId) return 0;
    return projects.filter(function (p) { return p.clientId === clientId; }).length;
  }

  function computeClientKpis() {
    var total = clients.length;
    var activeRetainers = clients.filter(clientIsRetainer).length;
    var totalRevenue = clients.reduce(function (sum, c) {
      return sum + clientRevenueFromTransactions(c.id);
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
        var rev = clientRevenueFromTransactions(c.id);
        var pcount = clientProjectCount(c.id);
        return '<tr>' +
          '<td class="tdp">' + (c.companyName || '—') + '</td>' +
          '<td>' + (c.contactName || '—') + '</td>' +
          '<td>' + (c.email || '—') + '</td>' +
          '<td>' + (c.phone || '—') + '</td>' +
          '<td>' + esc(c.status || '—') +
            (clientIsRetainer(c) ? ' <span style="font-size:10px;font-weight:600;color:var(--coral);white-space:nowrap;">Retainer</span>' : '') +
          '</td>' +
          '<td>' + (pcount ? String(pcount) : '—') + '</td>' +
          '<td>' + fmtCurrency(rev) + '</td>' +
          '<td style="white-space:nowrap;">' +
            '<button type="button" class="btn" data-client-edit="' + c.id + '" style="margin-right:6px;">Edit</button>' +
            '<button type="button" class="btn" data-client-del="' + c.id + '" style="color:var(--red);">Delete</button>' +
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
    persistTransactionToSupabase(tx);
  }

  function deleteTransaction(id) {
    markTransactionsDeletedLocally([id]);
    var invsToDelete = invoices.filter(function (inv) { return inv.incomeTxId === id; });
    state.transactions = state.transactions.filter(function (tx) { return tx.id !== id; });
    invoices = invoices.filter(function (inv) { return inv.incomeTxId !== id; });
    saveTransactions(state.transactions);
    saveInvoices(invoices);
    recomputeAndRender();
    deleteTransactionRemote(id);
    invsToDelete.forEach(function (inv) { deleteInvoiceRemote(inv.id); });
  }

  function deleteTransactionsByIds(ids) {
    if (!ids || !ids.length) return;
    markTransactionsDeletedLocally(ids);
    var remove = {};
    ids.forEach(function (id) { remove[id] = true; });
    var invsToDelete = invoices.filter(function (inv) { return remove[inv.incomeTxId]; });
    state.transactions = state.transactions.filter(function (tx) { return !remove[tx.id]; });
    invoices = invoices.filter(function (inv) { return !remove[inv.incomeTxId]; });
    saveTransactions(state.transactions);
    saveInvoices(invoices);
    recomputeAndRender();
    ids.forEach(function (id) { deleteTransactionRemote(id); });
    invsToDelete.forEach(function (inv) { deleteInvoiceRemote(inv.id); });
  }

  // ---------- UI wiring ----------

  function syncTransactionModalOtherFields() {
    var cat = $('tx-category') ? $('tx-category').value : '';
    var w1 = $('tx-other-wrapper');
    var w2 = $('tx-other-type-wrapper');
    var show = cat === 'oth';
    if (w1) w1.style.display = show ? '' : 'none';
    if (w2) w2.style.display = show ? '' : 'none';
  }

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
    syncTransactionModalOtherFields();
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
    var txCat = $('tx-category');
    if (txCat) txCat.addEventListener('change', syncTransactionModalOtherFields);
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

  function dateYMD(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function parseYMD(iso) {
    var p = (iso || '').split('-');
    if (p.length < 3) return new Date(NaN);
    return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0, 0);
  }

  function daysInMonth(y, m0) {
    return new Date(y, m0 + 1, 0).getDate();
  }

  function addMonthsKeepDom(y, m0, dom, deltaMonths) {
    var dt = new Date(y, m0 + deltaMonths, 1, 12, 0, 0, 0);
    var dim = daysInMonth(dt.getFullYear(), dt.getMonth());
    dt.setDate(Math.min(dom, dim));
    return dt;
  }

  function calendarDaysFromTo(start, d) {
    var ua = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    var ub = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return Math.round((ub - ua) / 86400000);
  }

  function generateMonthlyOccurrenceDates(rule, startStr, horizonEndStr) {
    var start = parseYMD(rule.startDate || startStr);
    var end = parseYMD(horizonEndStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
    var dom = rule.dayOfMonth != null ? Math.min(31, Math.max(1, +rule.dayOfMonth)) : start.getDate();
    var interval = Math.max(1, parseInt(rule.interval, 10) || 1);
    var y0 = start.getFullYear();
    var m0 = start.getMonth();
    var out = [];
    var step;
    for (step = 0; step < 240; step++) {
      var dt = addMonthsKeepDom(y0, m0, dom, step * interval);
      if (dt > end) break;
      if (dt >= start) out.push(dateYMD(dt));
    }
    return out;
  }

  function generateWeeklyOccurrenceDates(rule, startStr, horizonEndStr) {
    var start = parseYMD(rule.startDate || startStr);
    var end = parseYMD(horizonEndStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return [];
    var weekdays = (rule.weekdays && rule.weekdays.length) ? rule.weekdays.slice().sort(function (a, b) { return a - b; }) : [start.getDay()];
    var interval = Math.max(1, parseInt(rule.interval, 10) || 1);
    var seen = {};
    var out = [];
    var d = new Date(start.getTime());
    var guard = 0;
    while (d <= end && guard < 800) {
      guard++;
      if (weekdays.indexOf(d.getDay()) !== -1) {
        var daysFrom = calendarDaysFromTo(start, d);
        if (daysFrom >= 0) {
          var weeksFrom = Math.floor(daysFrom / 7);
          if (weeksFrom % interval === 0) {
            var iso = dateYMD(d);
            if (!seen[iso]) {
              seen[iso] = true;
              out.push(iso);
            }
          }
        }
      }
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function expandRecurringExpenseInstances() {
    var today = new Date();
    var todayStr = dateYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0));
    var futureInstanceIds = (state.transactions || []).filter(function (t) {
      return t && t.expenseRecurrenceInstance && t.date && t.date > todayStr;
    }).map(function (t) { return t.id; });
    if (futureInstanceIds.length) deleteTransactionsByIds(futureInstanceIds);

    var leads = (state.transactions || []).filter(function (t) {
      return t && t.expenseRecurringLead && t.recurrence && t.recurrenceSeriesId &&
        ['lab', 'sw', 'ads', 'oth'].indexOf(t.category) !== -1;
    });
    if (!leads.length) return;
    var added = false;

    leads.forEach(function (lead) {
      var rule = Object.assign({}, lead.recurrence);
      rule.startDate = rule.startDate || lead.date;
      // Only materialize occurrences on or before today so future months do not appear until those dates arrive.
      var materializeThrough = todayStr;
      if (rule.endDate && String(rule.endDate).trim() && rule.endDate < materializeThrough) {
        materializeThrough = rule.endDate;
      }
      var endCap = materializeThrough;
      var dates = rule.repeat === 'weekly'
        ? generateWeeklyOccurrenceDates(rule, rule.startDate, endCap)
        : generateMonthlyOccurrenceDates(rule, rule.startDate, endCap);
      var existing = {};
      state.transactions.forEach(function (t) {
        if (t.recurrenceSeriesId === lead.recurrenceSeriesId && t.date) existing[t.date] = true;
      });
      dates.forEach(function (iso) {
        if (existing[iso]) return;
        existing[iso] = true;
        added = true;
        var clone = {
          id: uuid(),
          date: iso,
          title: lead.title,
          vendor: lead.vendor,
          notes: lead.notes,
          description: lead.description,
          amount: lead.amount,
          category: lead.category,
          recurrenceSeriesId: lead.recurrenceSeriesId,
          expenseRecurrenceInstance: true,
        };
        state.transactions.push(clone);
        persistTransactionToSupabase(clone);
      });
    });
    if (added) saveTransactions(state.transactions);
  }

  function syncExpenseRecurrenceRepeatRows() {
    var rep = $('expense-recurrence-repeat');
    var mode = rep ? rep.value : 'monthly';
    var monthlyRow = $('expense-recurrence-monthly-row');
    var weeklyRow = $('expense-recurrence-weekly-row');
    var label = $('expense-recurrence-interval-label');
    if (monthlyRow) monthlyRow.style.display = mode === 'monthly' ? '' : 'none';
    if (weeklyRow) weeklyRow.style.display = mode === 'weekly' ? '' : 'none';
    if (label) label.textContent = mode === 'weekly' ? 'week(s)' : 'month(s)';
    var endDate = $('expense-recurrence-end-date');
    var endMode = $('expense-recurrence-end-mode');
    if (endDate) endDate.style.display = endMode && endMode.value === 'on' ? '' : 'none';
  }

  function updateExpenseRecurrenceSummary() {
    var el = $('expense-recurrence-summary');
    if (!el) return;
    var chk = $('expense-recurring');
    if (!chk || !chk.checked) {
      el.textContent = '';
      return;
    }
    var startStr = ($('expense-date') && $('expense-date').value) || todayISO();
    var rep = ($('expense-recurrence-repeat') && $('expense-recurrence-repeat').value) || 'monthly';
    var n = Math.max(1, parseInt($('expense-recurrence-interval') && $('expense-recurrence-interval').value, 10) || 1);
    var endMode = $('expense-recurrence-end-mode') && $('expense-recurrence-end-mode').value;
    var endPart = endMode === 'on' && $('expense-recurrence-end-date') && $('expense-recurrence-end-date').value
      ? ' until ' + fmtDateDisplay($('expense-recurrence-end-date').value) + '.'
      : '.';
    var startPretty = fmtDateDisplay(startStr);
    if (rep === 'monthly') {
      var dom = Math.min(31, Math.max(1, parseInt($('expense-recurrence-dom') && $('expense-recurrence-dom').value, 10) || 1));
      var unit = n === 1 ? 'month' : n + ' months';
      el.innerHTML = 'Occurs on day <strong>' + dom + '</strong> every <strong>' + unit + '</strong>, starting <strong>' + startPretty + '</strong>' + endPart;
      return;
    }
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var sel = [];
    var modal = $('expenseModal');
    if (modal) {
      modal.querySelectorAll('.exp-rec-dow.on').forEach(function (b) {
        var dow = parseInt(b.getAttribute('data-dow'), 10);
        if (!isNaN(dow)) sel.push(names[dow]);
      });
    }
    var sdW = parseYMD(startStr);
    var dayPart = sel.length ? sel.join(', ') : names[isNaN(sdW.getTime()) ? 0 : sdW.getDay()];
    var wunit = n === 1 ? 'week' : n + ' weeks';
    el.innerHTML = 'Occurs every <strong>' + dayPart + '</strong> (every <strong>' + wunit + '</strong>), starting <strong>' + startPretty + '</strong>' + endPart;
  }

  function resetExpenseRecurrenceUiDefaults() {
    var rep = $('expense-recurrence-repeat');
    if (rep) rep.value = 'monthly';
    var intv = $('expense-recurrence-interval');
    if (intv) intv.value = '1';
    var dom = $('expense-recurrence-dom');
    var dStr = ($('expense-date') && $('expense-date').value) || todayISO();
    var pd = parseYMD(dStr);
    if (dom && !isNaN(pd.getTime())) dom.value = String(pd.getDate());
    var endMode = $('expense-recurrence-end-mode');
    if (endMode) endMode.value = 'never';
    var endDate = $('expense-recurrence-end-date');
    if (endDate) endDate.value = '';
    var modal = $('expenseModal');
    if (modal) {
      modal.querySelectorAll('.exp-rec-dow').forEach(function (b) {
        b.classList.remove('on');
        b.setAttribute('aria-pressed', 'false');
      });
    }
    syncExpenseRecurrenceRepeatRows();
    updateExpenseRecurrenceSummary();
  }

  function readExpenseRecurrenceRuleFromUi(expenseDateIso) {
    var repeat = ($('expense-recurrence-repeat') && $('expense-recurrence-repeat').value) || 'monthly';
    var interval = Math.max(1, parseInt($('expense-recurrence-interval') && $('expense-recurrence-interval').value, 10) || 1);
    var endMode = $('expense-recurrence-end-mode') && $('expense-recurrence-end-mode').value;
    var endDate = endMode === 'on' && $('expense-recurrence-end-date') && $('expense-recurrence-end-date').value
      ? $('expense-recurrence-end-date').value
      : null;
    var rule = {
      repeat: repeat,
      interval: interval,
      startDate: expenseDateIso,
      endDate: endDate,
    };
    if (repeat === 'weekly') {
      var wds = [];
      var modal = $('expenseModal');
      if (modal) {
        modal.querySelectorAll('.exp-rec-dow.on').forEach(function (b) {
          var dow = parseInt(b.getAttribute('data-dow'), 10);
          if (!isNaN(dow)) wds.push(dow);
        });
      }
      if (!wds.length) {
        var sd0 = parseYMD(expenseDateIso);
        wds.push(isNaN(sd0.getTime()) ? 0 : sd0.getDay());
      }
      rule.weekdays = wds;
    } else {
      rule.dayOfMonth = Math.min(31, Math.max(1, parseInt($('expense-recurrence-dom') && $('expense-recurrence-dom').value, 10) || 1));
    }
    return rule;
  }

  function toggleExpenseRecurrencePanelVisible() {
    var panel = $('expense-recurrence-panel');
    var chk = $('expense-recurring');
    if (panel && chk) panel.style.display = chk.checked ? 'block' : 'none';
    if (chk && chk.checked) {
      var domIn = $('expense-recurrence-dom');
      var fDate = $('expense-date');
      var rep = $('expense-recurrence-repeat');
      if (domIn && fDate && rep && rep.value === 'monthly') {
        var pd = parseYMD(fDate.value || todayISO());
        if (!isNaN(pd.getTime())) domIn.value = String(pd.getDate());
      }
      syncExpenseRecurrenceRepeatRows();
    }
    updateExpenseRecurrenceSummary();
  }

  function wireExpenseRecurrenceControls() {
    var modal = $('expenseModal');
    if (!modal || modal.getAttribute('data-recurrence-wired') === '1') return;
    modal.setAttribute('data-recurrence-wired', '1');
    var chk = $('expense-recurring');
    if (chk) chk.addEventListener('change', toggleExpenseRecurrencePanelVisible);
    var rep = $('expense-recurrence-repeat');
    if (rep) rep.addEventListener('change', function () { syncExpenseRecurrenceRepeatRows(); updateExpenseRecurrenceSummary(); });
    var intv = $('expense-recurrence-interval');
    if (intv) intv.addEventListener('input', updateExpenseRecurrenceSummary);
    var domIn = $('expense-recurrence-dom');
    if (domIn) domIn.addEventListener('input', updateExpenseRecurrenceSummary);
    var endMode = $('expense-recurrence-end-mode');
    if (endMode) endMode.addEventListener('change', function () { syncExpenseRecurrenceRepeatRows(); updateExpenseRecurrenceSummary(); });
    var endDate = $('expense-recurrence-end-date');
    if (endDate) endDate.addEventListener('change', updateExpenseRecurrenceSummary);
    var fDate = $('expense-date');
    if (fDate) fDate.addEventListener('change', function () {
      var d = $('expense-recurrence-dom');
      var pd = parseYMD(fDate.value || todayISO());
      if (d && !isNaN(pd.getTime()) && $('expense-recurrence-repeat') && $('expense-recurrence-repeat').value === 'monthly') {
        d.value = String(pd.getDate());
      }
      updateExpenseRecurrenceSummary();
    });
    modal.addEventListener('click', function (ev) {
      var btn = ev.target.closest('.exp-rec-dow');
      if (!btn) return;
      var on = btn.classList.toggle('on');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      updateExpenseRecurrenceSummary();
    });
  }

  function openExpenseModal(existingTx) {
    wireExpenseRecurrenceControls();
    var m = $('expenseModal');
    if (!m) return;
    var editId = $('expense-edit-id');
    var fDate = $('expense-date');
    var fAmount = $('expense-amount');
    var fTitle = $('expense-title');
    var fCat = $('expense-category');
    var fVendor = $('expense-vendor');
    var fNotes = $('expense-notes');
    var recChk = $('expense-recurring');

    if (existingTx) {
      if (editId) editId.value = existingTx.id || '';
      if (fDate) fDate.value = existingTx.date || todayISO();
      if (fAmount) fAmount.value = existingTx.amount != null ? String(existingTx.amount) : '';
      if (fTitle) fTitle.value = (existingTx.title != null && existingTx.title !== '') ? existingTx.title : (existingTx.description || '');
      if (fCat) fCat.value = existingTx.categoryLabel || '';
      if (fVendor) fVendor.value = existingTx.vendor || '';
      if (fNotes) fNotes.value = existingTx.notes != null ? existingTx.notes : '';
      var isLead = !!existingTx.expenseRecurringLead && existingTx.recurrence;
      if (recChk) recChk.checked = isLead;
      if (isLead && existingTx.recurrence) {
        var r = existingTx.recurrence;
        if ($('expense-recurrence-repeat')) $('expense-recurrence-repeat').value = r.repeat === 'weekly' ? 'weekly' : 'monthly';
        if ($('expense-recurrence-interval')) $('expense-recurrence-interval').value = String(Math.max(1, r.interval || 1));
        if ($('expense-recurrence-dom')) {
          if (r.dayOfMonth != null) $('expense-recurrence-dom').value = String(r.dayOfMonth);
          else if (r.repeat !== 'weekly') {
            var pdDom = parseYMD(existingTx.date || todayISO());
            if (!isNaN(pdDom.getTime())) $('expense-recurrence-dom').value = String(pdDom.getDate());
          }
        }
        if ($('expense-recurrence-end-mode')) $('expense-recurrence-end-mode').value = r.endDate ? 'on' : 'never';
        if ($('expense-recurrence-end-date')) $('expense-recurrence-end-date').value = r.endDate || '';
        m.querySelectorAll('.exp-rec-dow').forEach(function (b) {
          b.classList.remove('on');
          b.setAttribute('aria-pressed', 'false');
        });
        if (r.weekdays && r.weekdays.length) {
          r.weekdays.forEach(function (wd) {
            var b = m.querySelector('.exp-rec-dow[data-dow="' + wd + '"]');
            if (b) {
              b.classList.add('on');
              b.setAttribute('aria-pressed', 'true');
            }
          });
        }
      } else {
        resetExpenseRecurrenceUiDefaults();
      }
    } else {
      if (editId) editId.value = '';
      if (fDate) fDate.value = todayISO();
      if (fAmount) fAmount.value = '';
      if (fTitle) fTitle.value = '';
      if (fCat) fCat.value = '';
      if (fVendor) fVendor.value = '';
      if (fNotes) fNotes.value = '';
      if (recChk) recChk.checked = false;
      resetExpenseRecurrenceUiDefaults();
    }
    syncExpenseRecurrenceRepeatRows();
    toggleExpenseRecurrencePanelVisible();
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
    var issueDefault = existing && existing.dateIssued ? existing.dateIssued : (tx.date || today);
    var dueDefault = existing && existing.dueDate
      ? existing.dueDate
      : new Date(new Date(issueDefault).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    var numberDefault = existing && existing.number ? existing.number : nextInvoiceNumber();
    var amountDefault = existing && existing.amount ? String(existing.amount) : String(tx.amount || 0);

    var modal = $('invoiceModal');
    if (!modal) return;
    var incomeIdInput = $('invoice-income-id');
    var numInput = $('invoice-number');
    var issueInput = $('invoice-issue-date');
    var dueInput = $('invoice-due-date');
    var amountInput = $('invoice-amount');
    var ctx = $('invoice-context');
    var title = $('invoice-modal-title');

    if (incomeIdInput) incomeIdInput.value = txId;
    if (numInput) numInput.value = numberDefault;
    if (issueInput) issueInput.value = issueDefault;
    if (dueInput) dueInput.value = dueDefault;
    if (amountInput) amountInput.value = amountDefault;

    if (ctx) {
      var clientLabel = 'No client';
      if (tx.clientId) {
        var cl = clients.find(function (c) { return c.id === tx.clientId; });
        if (cl && cl.companyName) clientLabel = cl.companyName;
      }
      var desc = tx.description || '';
      ctx.textContent = (clientLabel ? clientLabel + ' • ' : '') + desc;
    }
    if (title) title.textContent = isEdit ? 'Edit invoice' : 'Create invoice';

    modal.classList.add('on');
  }

  function buildInvoiceMarkup(tx, inv) {
    var client = null;
    if (tx && tx.clientId) {
      client = clients.find(function (c) { return c.id === tx.clientId; }) || null;
    }
    var fromName = 'ives deutschmann marketing';
    var fromAddress1 = 'Business Dashboard';
    var fromAddress2 = 'United States';
    var toName = client && client.companyName ? client.companyName : (tx.description || 'Client');
    var issueDate = inv && inv.dateIssued ? inv.dateIssued : todayISO();
    var dueDate = inv && inv.dueDate ? inv.dueDate : issueDate;
    var number = inv && inv.number ? inv.number : nextInvoiceNumber();
    var amount = Number(inv && inv.amount != null ? inv.amount : (tx && tx.amount ? tx.amount : 0));
    var taxRate = 0.10;
    var subtotal = amount;
    var tax = subtotal * taxRate;
    var total = subtotal + tax;
    var serviceLabel = tx && tx.description ? tx.description : 'Project consulting';

    return '' +
      '<div style="max-width:860px;margin:0 auto;background:#fff;border-radius:16px;padding:54px 58px;color:#1f1f1f;font-family:Inter,system-ui,-apple-system,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.08);">' +
        '<div style="display:flex;justify-content:space-between;gap:24px;margin-bottom:36px;">' +
          '<div>' +
            '<div style="font-size:42px;line-height:0.9;font-weight:700;letter-spacing:0.02em;margin-bottom:14px;">IDM</div>' +
            '<div style="font-size:30px;line-height:1.05;font-weight:500;">Invoice</div>' +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div style="font-size:44px;font-weight:700;letter-spacing:0.02em;">INVOICE</div>' +
            '<div style="margin-top:16px;font-size:16px;line-height:1.45;">' +
              '<div style="font-weight:600;">' + esc(fromName) + '</div>' +
              '<div>' + esc(fromAddress1) + '</div>' +
              '<div>' + esc(fromAddress2) + '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;gap:30px;margin-bottom:30px;">' +
          '<div style="font-size:16px;line-height:1.45;">' +
            '<div style="font-weight:700;margin-bottom:6px;">Bill To</div>' +
            '<div style="font-weight:600;">' + esc(toName) + '</div>' +
            (client && client.contactName ? '<div>' + esc(client.contactName) + '</div>' : '') +
            (client && client.email ? '<div>' + esc(client.email) + '</div>' : '') +
            (client && client.phone ? '<div>' + esc(client.phone) + '</div>' : '') +
          '</div>' +
          '<div style="font-size:32px;font-weight:700;text-align:right;line-height:1.2;">' +
            '<div style="font-size:16px;font-weight:600;">Invoice # ' + esc(number) + '</div>' +
            '<div style="font-size:15px;font-weight:500;color:#4c4c4c;margin-top:12px;">Issue date: ' + esc(fmtDateDisplay(issueDate)) + '</div>' +
            '<div style="font-size:15px;font-weight:500;color:#4c4c4c;">Due date: ' + esc(fmtDateDisplay(dueDate)) + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="border-radius:14px;background:#f5f5f5;padding:16px 18px;margin-bottom:18px;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
            '<thead><tr style="color:#6d6d6d;text-align:left;">' +
              '<th style="padding:8px 0;font-weight:500;">Product</th>' +
              '<th style="padding:8px 0;font-weight:500;">Rate</th>' +
              '<th style="padding:8px 0;font-weight:500;">Qty</th>' +
              '<th style="padding:8px 0;font-weight:500;">Tax</th>' +
              '<th style="padding:8px 0;font-weight:500;text-align:right;">Amount</th>' +
            '</tr></thead>' +
            '<tbody><tr>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;line-height:1.2;">' + esc(serviceLabel) + '</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;">' + esc(fmtCurrencyPrecise(subtotal)) + '</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;">1</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;">10%</td>' +
              '<td style="padding:10px 0 8px;font-size:28px;font-weight:500;text-align:right;">' + esc(fmtCurrencyPrecise(subtotal)) + '</td>' +
            '</tr></tbody>' +
          '</table>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;">' +
          '<div style="width:320px;font-size:20px;line-height:1.65;">' +
            '<div style="display:flex;justify-content:space-between;"><span style="font-weight:600;">Subtotal:</span><span>' + esc(fmtCurrencyPrecise(subtotal)) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;"><span style="font-weight:600;">Tax:</span><span>' + esc(fmtCurrencyPrecise(tax)) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;"><span style="font-weight:700;">Invoice total:</span><span style="font-weight:700;">' + esc(fmtCurrencyPrecise(total)) + '</span></div>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  function openInvoicePreviewForIncomeTx(txId) {
    var tx = state.transactions.find(function (t) { return t.id === txId; });
    if (!tx) return;
    var inv = getInvoiceByIncomeTxId(txId);
    if (!inv) {
      alert('Create the invoice first.');
      return;
    }
    var body = $('invoice-preview-body');
    var modal = $('invoicePreviewModal');
    if (!body || !modal) return;
    body.innerHTML = buildInvoiceMarkup(tx, inv);
    modal.classList.add('on');
  }

  function printCurrentInvoicePreview() {
    var body = $('invoice-preview-body');
    if (!body) return;
    var html = body.innerHTML;
    if (!html) return;
    var w = window.open('', '_blank', 'width=1100,height=900');
    if (!w) return;
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Invoice</title><style>body{margin:0;background:#fff;padding:24px;}*{box-sizing:border-box;}@media print{body{padding:0;}}</style></head><body>' + html + '</body></html>');
    w.document.close();
    w.focus();
    w.print();
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
        var titleTrim = (title || '').trim();
        var vendorTrim = (vendor || '').trim();
        var notesTrim = (notes || '').trim();
        var desc = titleTrim || vendorTrim || notesTrim;

        var editId = $('expense-edit-id') ? $('expense-edit-id').value : '';
        var recurring = $('expense-recurring') && $('expense-recurring').checked;
        if (editId) {
          var prevTx = state.transactions.find(function (t) { return t.id === editId; });
          state.transactions = state.transactions.map(function (tx) {
            if (tx.id !== editId) return tx;
            var next = {
              id: tx.id,
              date: date,
              title: titleTrim,
              vendor: vendorTrim,
              notes: notesTrim,
              description: desc,
              amount: amount,
              category: cat,
            };
            if (recurring) {
              next.recurrenceSeriesId = (prevTx && prevTx.recurrenceSeriesId) ? prevTx.recurrenceSeriesId : uuid();
              next.expenseRecurringLead = true;
              next.recurrence = readExpenseRecurrenceRuleFromUi(date);
              next.recurring = true;
            } else {
              if (prevTx && prevTx.expenseRecurrenceInstance) {
                next.recurrenceSeriesId = prevTx.recurrenceSeriesId;
                next.expenseRecurrenceInstance = true;
              }
            }
            return next;
          });
          saveTransactions(state.transactions);
          recomputeAndRender();
          var updated = state.transactions.find(function (t) { return t.id === editId; });
          if (updated) persistTransactionToSupabase(updated);
          if (recurring) {
            expandRecurringExpenseInstances();
            recomputeAndRender();
          }
        } else {
          if (recurring) {
            var seriesId = uuid();
            addTransaction({
              id: uuid(),
              date: date,
              title: titleTrim,
              vendor: vendorTrim,
              notes: notesTrim,
              description: desc,
              amount: amount,
              category: cat,
              recurrenceSeriesId: seriesId,
              expenseRecurringLead: true,
              recurrence: readExpenseRecurrenceRuleFromUi(date),
              recurring: true,
            });
            expandRecurringExpenseInstances();
            recomputeAndRender();
          } else {
            addTransaction({
              id: uuid(),
              date: date,
              title: titleTrim,
              vendor: vendorTrim,
              notes: notesTrim,
              description: desc,
              amount: amount,
              category: cat,
            });
          }
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
          var incomeUpdated = state.transactions.find(function (t) { return t.id === editId; });
          if (incomeUpdated) persistTransactionToSupabase(incomeUpdated);
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

  function wireInvoiceModal() {
    var modal = $('invoiceModal');
    if (!modal) return;
    var btnCancel = $('btn-invoice-cancel');
    var btnSave = $('btn-invoice-save');

    function closeInvoiceModal() {
      if (modal) modal.classList.remove('on');
    }

    if (btnCancel) btnCancel.addEventListener('click', closeInvoiceModal);
    if (btnSave) {
      btnSave.addEventListener('click', function () {
        var txId = $('invoice-income-id') ? $('invoice-income-id').value : '';
        if (!txId) {
          closeInvoiceModal();
          return;
        }
        var issueDate = $('invoice-issue-date') ? $('invoice-issue-date').value : '';
        var dueDate = $('invoice-due-date') ? $('invoice-due-date').value : '';
        var number = $('invoice-number') ? $('invoice-number').value.trim() : '';
        var amountRaw = $('invoice-amount') ? $('invoice-amount').value : '';
        var amount = parseFloat(amountRaw || '0');

        if (!number) {
          alert('Invoice number is required.');
          return;
        }
        if (!issueDate || !dueDate) {
          alert('Issue and due dates are required.');
          return;
        }
        if (!amount || amount <= 0) {
          alert('Invoice amount must be greater than 0.');
          return;
        }

        var existing = getInvoiceByIncomeTxId(txId);
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
        var invSaved = getInvoiceByIncomeTxId(txId);
        if (invSaved) persistInvoiceToSupabase(invSaved);
        closeInvoiceModal();
      });
    }
  }

  function wireInvoicePreviewModal() {
    var modal = $('invoicePreviewModal');
    if (!modal) return;
    var btnClose = $('btn-invoice-preview-close');
    var btnPrint = $('btn-invoice-preview-print');
    function closePreview() {
      modal.classList.remove('on');
    }
    if (btnClose) btnClose.addEventListener('click', closePreview);
    if (btnPrint) btnPrint.addEventListener('click', printCurrentInvoicePreview);
    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) closePreview();
    });
  }

  function wireDeleteHandlers() {
    var txTable = $('transaction-log-table');
    if (txTable && txTable.getAttribute('data-bizdash-del-wired') !== '1') {
      txTable.setAttribute('data-bizdash-del-wired', '1');
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
    if (expTable && expTable.getAttribute('data-bizdash-del-wired') !== '1') {
      expTable.setAttribute('data-bizdash-del-wired', '1');
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
            title: tx.title,
            vendor: tx.vendor,
            notes: tx.notes,
            description: tx.description,
            expenseRecurringLead: tx.expenseRecurringLead,
            recurrence: tx.recurrence,
          });
          return;
        }

        var delBtn = ev.target.closest('[data-exp-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-exp-del');
        if (!id) return;
        var delTx = state.transactions.find(function (t) { return t.id === id; });
        if (delTx && delTx.expenseRecurringLead && delTx.recurrenceSeriesId) {
          if (!confirm('Delete this recurring expense and all auto-generated occurrences in the series?')) return;
          var sid = delTx.recurrenceSeriesId;
          var ids = state.transactions.filter(function (t) { return t.recurrenceSeriesId === sid; }).map(function (t) { return t.id; });
          deleteTransactionsByIds(ids);
          return;
        }
        if (confirm('Delete this expense transaction?')) {
          deleteTransaction(id);
        }
      });
    }

    var mktPipe = $('marketing-pipeline');
    if (mktPipe) {
      mktPipe.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-campaign-edit]');
        if (editBtn) {
          var eid = editBtn.getAttribute('data-campaign-edit');
          if (eid) openCampaignModal(eid);
          return;
        }
        var delBtn = ev.target.closest('[data-campaign-del]');
        if (!delBtn) return;
        var id = delBtn.getAttribute('data-campaign-del');
        if (!id || !confirm('Remove this campaign?')) return;
        campaigns = campaigns.filter(function (c) { return c.id !== id; });
        saveCampaigns(campaigns);
        deleteCampaignRemote(id);
        renderMarketing();
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
          $('client-industry').value = client.industry || '';
          $('client-email').value = client.email || '';
          $('client-phone').value = client.phone || '';
          $('client-notes').value = client.notes || '';
          var retCb = $('client-retainer');
          if (retCb) retCb.checked = client.retainer === true;
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
          if (state.computed) renderInsights();
          deleteClientRemote(id);
        }
      });
    }

    var projTable = $('projects-table');
    if (projTable) {
      projTable.addEventListener('change', function (ev) {
        var sel = ev.target;
        if (!sel || !sel.classList || !sel.classList.contains('project-row-status')) return;
        var pid = sel.getAttribute('data-project-status-id');
        if (!pid) return;
        var proj = projects.find(function (p) { return p.id === pid; });
        if (!proj) return;
        var next = sel.value || '';
        if ((proj.status || '') === next) return;
        proj.status = next;
        saveProjects(projects);
        persistProjectToSupabase(proj);
        renderProjectKpisAndCharts();
        if (state.computed) renderInsights();
      });
      projTable.addEventListener('click', function (ev) {
        var csBtn = ev.target.closest('[data-project-casestudy]');
        if (csBtn) {
          var csId = csBtn.getAttribute('data-project-casestudy');
          if (csId) openCaseStudyViewModal(csId);
          return;
        }
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
          if ($('project-satisfaction')) $('project-satisfaction').value = typeof proj.satisfaction === 'number' ? String(proj.satisfaction) : '';
          var archived = $('project-archived');
          if (archived) archived.checked = !!proj.archived;
          fillCaseStudyForm(proj);
          var det = $('project-case-study-details');
          if (det) det.open = false;
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
          deleteProjectRemote(id);
          renderProjects();
          populateIncomeProjectOptions();
          if (state.computed) renderInsights();
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

        var viewInvBtn = ev.target.closest('[data-income-invoice-view]');
        if (viewInvBtn) {
          var viewTxId = viewInvBtn.getAttribute('data-income-invoice-view');
          if (!viewTxId) return;
          openInvoicePreviewForIncomeTx(viewTxId);
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
          var invPaid = getInvoiceByIncomeTxId(paidTxId);
          if (invPaid) persistInvoiceToSupabase(invPaid);
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
      $('client-industry').value = '';
      $('client-email').value = '';
      $('client-phone').value = '';
      $('client-notes').value = '';
      var retCb = $('client-retainer');
      if (retCb) retCb.checked = false;
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
        var retainerChecked = $('client-retainer') && $('client-retainer').checked;
        var client;
        if (existingId) {
          clients = clients.map(function (c) {
            if (c.id !== existingId) return c;
            client = {
              id: c.id,
              companyName: company,
              contactName: $('client-contact').value.trim(),
              status: $('client-status').value.trim(),
              industry: $('client-industry').value.trim(),
              email: $('client-email').value.trim(),
              phone: $('client-phone').value.trim(),
              notes: $('client-notes').value.trim(),
              totalRevenue: c.totalRevenue || 0,
              createdAt: c.createdAt || Date.now(),
              retainer: !!retainerChecked,
            };
            return client;
          });
        } else {
          client = {
            id: uuid(),
            companyName: company,
            contactName: $('client-contact').value.trim(),
            status: $('client-status').value.trim(),
            industry: $('client-industry').value.trim(),
            email: $('client-email').value.trim(),
            phone: $('client-phone').value.trim(),
            notes: $('client-notes').value.trim(),
            totalRevenue: 0,
            createdAt: Date.now(),
            retainer: !!retainerChecked,
          };
          clients.push(client);
        }
        saveClients(clients);
        renderClients();
        if (state.computed) renderInsights();
        if (client) persistClientToSupabase(client);
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
          '<button type="button" class="btn" data-status-del="' + idx + '" style="color:var(--red);">Remove</button>' +
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
      if ($('project-satisfaction')) $('project-satisfaction').value = '';
      var archived = $('project-archived');
      if (archived) archived.checked = false;
      clearCaseStudyForm();
      var det = $('project-case-study-details');
      if (det) det.open = false;
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
        var satRaw = $('project-satisfaction') ? $('project-satisfaction').value.trim() : '';
        var satNum = satRaw !== '' ? Math.min(10, Math.max(1, parseInt(satRaw, 10))) : null;
        var satisfaction = (!isNaN(satNum) && satNum !== null) ? satNum : null;
        var cs = readCaseStudyFromUi();

        var existingId = $('project-edit-id') ? $('project-edit-id').value : '';
        var savedProject = null;
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
              satisfaction: satisfaction,
              archived: !!archived,
              createdAt: p.createdAt || Date.now(),
              caseStudyPublished: cs.caseStudyPublished,
              caseStudyCategory: cs.caseStudyCategory,
              caseStudyChallenge: cs.caseStudyChallenge,
              caseStudyStrategy: cs.caseStudyStrategy,
              caseStudyResults: cs.caseStudyResults,
            };
          });
          savedProject = projects.find(function (p) { return p.id === existingId; }) || null;
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
            satisfaction: satisfaction,
            archived: !!archived,
            createdAt: Date.now(),
            caseStudyPublished: cs.caseStudyPublished,
            caseStudyCategory: cs.caseStudyCategory,
            caseStudyChallenge: cs.caseStudyChallenge,
            caseStudyStrategy: cs.caseStudyStrategy,
            caseStudyResults: cs.caseStudyResults,
          };
          projects.push(proj);
          savedProject = proj;
        }
        saveProjects(projects);
        if (savedProject) persistProjectToSupabase(savedProject);
        renderProjects();
        if (state.computed) renderInsights();
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
        persistAppSettingsToSupabase();
        statusInput.value = '';
        renderStatusList();
        populateProjectStatusOptions();
        renderProjects();
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
        persistAppSettingsToSupabase();
        renderStatusList();
        populateProjectStatusOptions();
        renderProjects();
      });
    }

    var btnStratAdd = $('btn-case-study-strategy-add');
    if (btnStratAdd) {
      btnStratAdd.addEventListener('click', function () {
        appendCaseStudyStrategyRow('', '');
      });
    }
    var stratList = $('case-study-strategy-list');
    if (stratList) {
      stratList.addEventListener('click', function (ev) {
        var rm = ev.target.closest('.case-strategy-remove');
        if (!rm) return;
        var row = rm.closest('.case-strategy-row');
        if (row && row.parentNode) row.parentNode.removeChild(row);
      });
    }
    var btnCsViewClose = $('btn-case-study-view-close');
    if (btnCsViewClose) btnCsViewClose.addEventListener('click', closeCaseStudyViewModal);
    var csViewModal = $('caseStudyViewModal');
    if (csViewModal) {
      csViewModal.addEventListener('click', function (ev) {
        if (ev.target === csViewModal) closeCaseStudyViewModal();
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

  // Serialize runs so a pre-auth no-op init cannot overlap with post-login sync.
  var initDataFromSupabaseChain = Promise.resolve();
  function initDataFromSupabase() {
    initDataFromSupabaseChain = initDataFromSupabaseChain.then(function () {
      return initDataFromSupabaseInner();
    }).catch(function (err) {
      console.error('initDataFromSupabase error', err);
    });
    return initDataFromSupabaseChain;
  }

  // Initialize dashboard data from Supabase when available, falling back to local storage.
  async function initDataFromSupabaseInner() {
    try {
      supabase = window.supabaseClient || supabase;
      currentUser = window.currentUser || currentUser;

      // Start from local cache so we can migrate/backfill if remote is empty.
      state.transactions = omitLocallyDeletedTransactions(loadTransactions());
      clients = loadClients();
      projects = loadProjects();
      invoices = loadInvoices();
      campaigns = loadCampaigns();
      projectStatuses = loadStatuses();
      normalizeLocalIdsForSupabase();

      if (supabase && currentUser) {
        var remoteTxs = await fetchTransactionsFromSupabase();
        var remoteClients = await fetchClientsFromSupabase();

        // One-time backfill: if remote is empty but local has data, upload local records.
        if (!remoteTxs.length && state.transactions.length) {
          await uploadTransactionsToSupabase(state.transactions);
          remoteTxs = await fetchTransactionsFromSupabase();
        }
        if (!remoteClients.length && clients.length) {
          await uploadClientsToSupabase(clients);
          remoteClients = await fetchClientsFromSupabase();
        }

        // Prefer remote when available; otherwise keep local fallback.
        if (remoteTxs.length) {
          state.transactions = mergeTransactionsPreserveRecurrence(state.transactions, remoteTxs);
          state.transactions = omitLocallyDeletedTransactions(state.transactions);
          pruneDeletedTxMarksAbsentFromRemote(remoteTxs);
        }

        var remoteClientIdSet = {};
        (remoteClients || []).forEach(function (c) {
          if (c && c.id) remoteClientIdSet[c.id] = true;
        });
        clients = mergeClientsPreserveRetainer(clients, remoteClients);
        var localOnlyClients = clients.filter(function (c) {
          return c && c.id && !remoteClientIdSet[c.id];
        });
        if (localOnlyClients.length) {
          await uploadClientsToSupabase(localOnlyClients);
          remoteClients = await fetchClientsFromSupabase();
          clients = mergeClientsPreserveRetainer(clients, remoteClients);
        }

        var remoteProjects = await fetchProjectsFromSupabase();
        if (!remoteProjects.length && projects.length) {
          await uploadProjectsToSupabase(projects);
          remoteProjects = await fetchProjectsFromSupabase();
        }
        if (remoteProjects.length) {
          projects = mergeRemoteWithLocalOrphans(projects, remoteProjects, function (x) { return x; });
        }

        var remoteInvoices = await fetchInvoicesFromSupabase();
        if (!remoteInvoices.length && invoices.length) {
          await uploadInvoicesToSupabase(invoices);
          remoteInvoices = await fetchInvoicesFromSupabase();
        }
        if (remoteInvoices.length) {
          invoices = mergeRemoteWithLocalOrphans(invoices, remoteInvoices, function (x) { return x; });
        }

        var remoteCampaigns = await fetchCampaignsFromSupabase();
        if (!remoteCampaigns.length && campaigns.length) {
          await uploadCampaignsToSupabase(campaigns);
          remoteCampaigns = await fetchCampaignsFromSupabase();
        }
        if (remoteCampaigns.length) {
          campaigns = mergeRemoteWithLocalOrphans(campaigns, remoteCampaigns, function (x) { return x; });
        }

        var settingsRow = await fetchAppSettingsFromSupabase();
        if (settingsRow && Array.isArray(settingsRow.project_statuses) && settingsRow.project_statuses.length) {
          projectStatuses = settingsRow.project_statuses.map(function (s) { return String(s); }).filter(Boolean);
          saveStatuses(projectStatuses);
        } else {
          await persistAppSettingsToSupabase();
        }

        // #region agent log
        debugAgentLog({ runId: 'run1', hypothesisId: 'H2', location: 'financial-core.js:initDataFromSupabase', message: 'after remote load', data: { remoteTxCount: remoteTxs.length, remoteClientCount: remoteClients.length, appliedRemoteTx: !!remoteTxs.length, appliedRemoteClients: !!remoteClients.length } });
        // #endregion

        // Cache in localStorage so existing browser keeps a copy.
        saveTransactions(state.transactions);
        saveClients(clients);
        saveProjects(projects);
        saveInvoices(invoices);
        saveCampaigns(campaigns);
      }

      expandRecurringExpenseInstances();

      // Ensure dropdowns reflect latest clients/projects.
      populateProjectClientOptions();
      populateIncomeClientOptions();
      populateProjectStatusOptions();

      state.computed = compute(state.filter);
      renderAll();
      renderProjects();
    } catch (err) {
      console.error('initDataFromSupabase error', err);
      // Fallback in case anything goes wrong.
      state.transactions = omitLocallyDeletedTransactions(loadTransactions());
      clients = loadClients();
      projects = loadProjects();
      invoices = loadInvoices();
      campaigns = loadCampaigns();
      projectStatuses = loadStatuses();
      expandRecurringExpenseInstances();
      state.computed = compute(state.filter);
      renderAll();
      renderProjects();
    }
  }

  // Expose so supabase-auth.js can trigger a reload after login.
  window.initDataFromSupabase = initDataFromSupabase;

  function init() {
    state.filter = { mode: 'all', start: null, end: null };
    wireTransactionForm();
    wireIncomeExpenseForms();
    wireDeleteHandlers();
    wireClientForm();
    wireInvoiceModal();
    wireInvoicePreviewModal();
    wireProjectsAndStatuses();
    wireFilter();
    wireSpendingReport();
    wireMarketingCampaign();

    // Simple page navigation wiring to replace the original bundle's nav().
    // Exposed globally so existing onclick="nav('dashboard', this)" continues to work.
    window.nav = function (pageId, el) {
      document.body.classList.remove('mobile-nav-open');

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

      var mobileTitle = document.getElementById('mobile-title');
      if (mobileTitle) {
        var titles = {
          dashboard: 'Business Performance',
          customers: 'Customers',
          revenue: 'Income',
          expenses: 'Expenses',
          performance: 'Projects',
          retention: 'Retention',
          insights: 'Insights',
          marketing: 'Marketing',
          settings: 'Settings',
        };
        mobileTitle.textContent = titles[pageId] || 'Dashboard';
      }
    };

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') document.body.classList.remove('mobile-nav-open');
    });

    // Load data only when session is already present (auth also calls init after login).
    if (typeof initDataFromSupabase === 'function' && window.currentUser && window.supabaseClient) {
      initDataFromSupabase();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

