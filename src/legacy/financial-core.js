// financial-core.js
// Standalone financial data layer: transactions are the single source of truth.

(function () {
  'use strict';

  // Supabase client/user (set by supabase-auth.js when available)
  var supabase = window.supabaseClient || null;
  var currentUser = window.currentUser || null;

  var __bizdashTzListCache = null;
  var __bizdashTzSearchRecords = null;
  var __bizdashTzDN = undefined;

  var STORAGE_KEY = 'transactions:v1';
  // Ids the user deleted locally; applied after remote merge so a row does not reappear in the ledger (expenses + transaction log) if the server delete lags or fails once.
  var TX_DELETED_IDS_KEY = 'tx-deleted-ids:v1';

  function storageKey(suffix) {
    var activeUser = window.currentUser || currentUser;
    var scopeUser = activeUser && activeUser.id ? String(activeUser.id) : 'guest';
    var oid = window.currentOrganizationId;
    var scopeOrg = oid && String(oid).trim() ? String(oid).trim() : 'noorg';
    return 'bizdash:' + scopeUser + ':' + scopeOrg + ':' + suffix;
  }

  function loadDeletedTxIdMap() {
    try {
      var raw = localStorage.getItem(storageKey(TX_DELETED_IDS_KEY));
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function saveDeletedTxIdMap(map) {
    try {
      localStorage.setItem(storageKey(TX_DELETED_IDS_KEY), JSON.stringify(map || {}));
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
      var raw = localStorage.getItem(storageKey(STORAGE_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveTransactions(list) {
    try {
      localStorage.setItem(storageKey(STORAGE_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ''));
  }

  /** UUID shape Postgres accepts (any version nibble); looser than isUuid(). */
  function isUuidForDb(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '').trim());
  }

  function buildClientMetadata(client) {
    var out = {};
    if (client.custTabRevenue != null && isFinite(Number(client.custTabRevenue))) {
      out.custTabRevenue = Math.max(0, Number(client.custTabRevenue));
    }
    if (client.custTabAllocatedCost != null && isFinite(Number(client.custTabAllocatedCost))) {
      out.custTabAllocatedCost = Math.max(0, Number(client.custTabAllocatedCost));
    }
    [
      'salutation',
      'firstName',
      'lastName',
      'title',
      'reportsTo',
      'description',
      'owner',
      'accountName',
      'mailingCountry',
      'mailingStreet',
      'mailingCity',
      'mailingState',
      'mailingZip',
    ].forEach(function (k) {
      var v = client && client[k] != null ? String(client[k]).trim() : '';
      if (v) out[k] = v;
    });
    if (client && client.emailOptOut === true) out.emailOptOut = true;
    return Object.keys(out).length ? out : null;
  }

  function applyClientMetadata(client, meta) {
    var out = Object.assign({}, client);
    delete out.custTabRevenue;
    delete out.custTabAllocatedCost;
    if (!meta || typeof meta !== 'object') return out;
    if (meta.custTabRevenue != null && isFinite(Number(meta.custTabRevenue))) {
      out.custTabRevenue = Math.max(0, Number(meta.custTabRevenue));
    }
    if (meta.custTabAllocatedCost != null && isFinite(Number(meta.custTabAllocatedCost))) {
      out.custTabAllocatedCost = Math.max(0, Number(meta.custTabAllocatedCost));
    }
    [
      'salutation',
      'firstName',
      'lastName',
      'title',
      'reportsTo',
      'description',
      'owner',
      'accountName',
      'mailingCountry',
      'mailingStreet',
      'mailingCity',
      'mailingState',
      'mailingZip',
    ].forEach(function (k) {
      if (meta[k] != null) out[k] = String(meta[k]);
    });
    if (meta.emailOptOut === true) out.emailOptOut = true;
    return out;
  }

  function buildClientDbPayload(client, userId) {
    // Postgres column clients.total_revenue must reflect Customers-tab revenue:
    // manual "Custom revenue" (custTabRevenue) overrides; otherwise use stored total or 0.
    var rev = Number(client.totalRevenue);
    if (!isFinite(rev)) rev = 0;
    if (client.custTabRevenue != null && isFinite(Number(client.custTabRevenue))) {
      rev = Math.max(0, Number(client.custTabRevenue));
    }
    var createdIso;
    try {
      var d = client.createdAt != null ? new Date(client.createdAt) : new Date();
      createdIso = isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    } catch (_) {
      createdIso = new Date().toISOString();
    }
    var row = {
      id: client.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      company_name: client.companyName,
      contact_name: client.contactName,
      status: client.status,
      industry: client.industry,
      email: client.email,
      phone: client.phone,
      notes: client.notes,
      birthday: client.birthday || null,
      communication_style: client.communicationStyle || null,
      preferred_channel: client.preferredChannel || null,
      last_touch_at: client.lastTouchAt || null,
      next_follow_up_at: client.nextFollowUpAt || null,
      relationship_notes: client.relationshipNotes || null,
      total_revenue: rev,
      created_at: createdIso,
      is_retainer: client.retainer === true,
      pipeline_id: client.pipelineId || null,
      pipeline_stage_id: client.pipelineStageId || null,
    };
    var cmeta = buildClientMetadata(client);
    row.metadata = cmeta || {};
    return row;
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

  /** Login “View Demo” uses this id so data is isolated from real accounts in localStorage. */
  var DEMO_DASHBOARD_USER_ID = '00000000-0000-4000-8000-000000000001';
  function isDemoDashboardUser() {
    var u = window.currentUser || currentUser;
    return !!(u && u.id === DEMO_DASHBOARD_USER_ID);
  }
  window.DEMO_DASHBOARD_USER_ID = DEMO_DASHBOARD_USER_ID;
  /** Used by React islands (e.g. Scheduling): mock/sample data must never key off anything else. */
  window.bizDashIsDemoUser = isDemoDashboardUser;

  /** Active workspace (set by supabase-auth.js from URL slug + membership). */
  function getCurrentOrgId() {
    var id = window.currentOrganizationId;
    return id && String(id).trim() ? String(id).trim() : null;
  }
  window.bizDashGetCurrentOrgId = getCurrentOrgId;

  /** When set, initDataFromSupabase skips backfill uploads (used with screenshot/mock flows). */
  var SCREENSHOT_NO_CLOUD_KEY = 'bizdash_screenshot_no_cloud';
  function setScreenshotNoCloudUpload(on) {
    try {
      if (on) sessionStorage.setItem(SCREENSHOT_NO_CLOUD_KEY, '1');
      else sessionStorage.removeItem(SCREENSHOT_NO_CLOUD_KEY);
    } catch (_) {}
  }
  function isScreenshotNoCloudUpload() {
    try {
      return sessionStorage.getItem(SCREENSHOT_NO_CLOUD_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  var state = {
    transactions: [],
    filter: { mode: 'all', start: null, end: null }, // all | month | range
    computed: null,
  };

  // ---------- Clients store ----------

  var CLIENTS_KEY = 'clients:v1';
  var CUSTOMERS_COLUMNS_PREFS_KEY = 'customers-columns:v1';
  var USER_UI_PREFS_DEBOUNCE_MS = 400;
  var userUiPrefsCache = null;
  var userUiPrefsPersistTimer = null;

  function defaultUserUiPayload() {
    return { v: 1, preferences: undefined, orgs: {}, sidebarHiddenPages: [] };
  }

  function ensureUserUiPrefsCache() {
    if (!userUiPrefsCache || typeof userUiPrefsCache !== 'object') {
      userUiPrefsCache = defaultUserUiPayload();
    }
    if (!userUiPrefsCache.orgs || typeof userUiPrefsCache.orgs !== 'object') {
      userUiPrefsCache.orgs = {};
    }
    if (userUiPrefsCache.v == null) {
      userUiPrefsCache.v = 1;
    }
    if (!Array.isArray(userUiPrefsCache.sidebarHiddenPages)) {
      userUiPrefsCache.sidebarHiddenPages = [];
    } else {
      userUiPrefsCache.sidebarHiddenPages = sanitizeSidebarHiddenPages(userUiPrefsCache.sidebarHiddenPages);
    }
    return userUiPrefsCache;
  }

  function clearUserUiPrefsCache() {
    userUiPrefsCache = null;
    try {
      if (userUiPrefsPersistTimer) {
        clearTimeout(userUiPrefsPersistTimer);
      }
    } catch (_) {}
    userUiPrefsPersistTimer = null;
  }

  function preferencesForUserUiCache() {
    try {
      if (window.__bizdashPreferences && typeof window.__bizdashPreferences === 'object') {
        return normalizePreferences(window.__bizdashPreferences);
      }
      if (document.getElementById('pref-theme')) {
        return normalizePreferences(readPreferencesFromDom());
      }
    } catch (_) {}
    return normalizePreferences(getDefaultPreferences());
  }

  function mergeRuntimeIntoUserUiCacheForOrg(oid) {
    if (!oid) return;
    var c = ensureUserUiPrefsCache();
    if (!c.orgs[oid]) {
      c.orgs[oid] = {};
    }
    c.orgs[oid].customersColumns = JSON.parse(JSON.stringify(customersColumnPrefs || defaultCustomersColumnPrefs()));
    c.orgs[oid].incomePower = {
      search: incomePowerState.search || '',
      filters: Array.isArray(incomePowerState.filters) ? incomePowerState.filters.slice(0, 20) : [],
      visible: Object.assign({}, incomePowerState.visible || {}),
    };
    c.orgs[oid].incomeTrendRange = incomeTrendRange || '90d';
  }

  function updateUserUiPrefsCacheFromRuntime() {
    var oid = getCurrentOrgId();
    if (oid) {
      mergeRuntimeIntoUserUiCacheForOrg(oid);
    }
    ensureUserUiPrefsCache().preferences = preferencesForUserUiCache();
    return ensureUserUiPrefsCache();
  }

  function schedulePersistUserUiPreferences() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) {
      return;
    }
    if (isDemoDashboardUser()) {
      return;
    }
    try {
      if (userUiPrefsPersistTimer) {
        clearTimeout(userUiPrefsPersistTimer);
      }
    } catch (_) {}
    userUiPrefsPersistTimer = setTimeout(function () {
      userUiPrefsPersistTimer = null;
      flushPersistUserUiPreferences();
    }, USER_UI_PREFS_DEBOUNCE_MS);
  }

  async function persistUserUiPreferencesFromCache() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || isDemoDashboardUser()) {
      return;
    }
    try {
      var payload = ensureUserUiPrefsCache();
      var result = await supabase.from('user_ui_preferences').upsert(
        {
          user_id: currentUser.id,
          payload: payload,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
      if (result.error) {
        console.error('user_ui_preferences upsert error', result.error);
      }
    } catch (err) {
      console.error('persistUserUiPreferencesFromCache', err);
    }
  }

  async function flushPersistUserUiPreferences() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || isDemoDashboardUser()) {
      return;
    }
    if (!getCurrentOrgId()) {
      return;
    }
    try {
      updateUserUiPrefsCacheFromRuntime();
      await persistUserUiPreferencesFromCache();
    } catch (err) {
      console.error('flushPersistUserUiPreferences', err);
    }
  }

  function persistUserUiPrefsForOrgLeaving(prevOid) {
    try {
      if (userUiPrefsPersistTimer) {
        clearTimeout(userUiPrefsPersistTimer);
      }
    } catch (_) {}
    userUiPrefsPersistTimer = null;
    prevOid = prevOid && String(prevOid).trim() ? String(prevOid).trim() : null;
    if (!prevOid) return;
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || isDemoDashboardUser()) return;
    mergeRuntimeIntoUserUiCacheForOrg(prevOid);
    ensureUserUiPrefsCache().preferences = preferencesForUserUiCache();
    void persistUserUiPreferencesFromCache();
  }

  async function fetchUserUiPreferencesPayload() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || isDemoDashboardUser()) {
      return null;
    }
    try {
      var result = await supabase
        .from('user_ui_preferences')
        .select('payload')
        .eq('user_id', currentUser.id)
        .maybeSingle();
      if (result.error) {
        console.error('user_ui_preferences select error', result.error);
        return null;
      }
      return result.data && result.data.payload != null ? result.data.payload : null;
    } catch (err) {
      console.error('fetchUserUiPreferencesPayload', err);
      return null;
    }
  }

  var SIDEBAR_NAV_PAGE_DEFS = [
    { id: 'customers', label: 'Customers' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'emails', label: 'Emails' },
    { id: 'revenue', label: 'Income' },
    { id: 'expenses', label: 'Expenses' },
    { id: 'timesheet', label: 'Timesheet' },
    { id: 'lists', label: 'Lists' },
    { id: 'chat', label: 'Advisor' },
    { id: 'performance', label: 'Performance' },
    { id: 'retention', label: 'Retention' },
    { id: 'insights', label: 'Insights' },
    { id: 'marketing', label: 'Marketing' },
    { id: 'team', label: 'Your team' },
  ];
  var SIDEBAR_PAGE_ID_SET = {};
  SIDEBAR_NAV_PAGE_DEFS.forEach(function (d) {
    SIDEBAR_PAGE_ID_SET[d.id] = true;
  });

  function sanitizeSidebarHiddenPages(arr) {
    if (!Array.isArray(arr)) return [];
    var out = [];
    arr.forEach(function (id) {
      id = String(id || '').trim();
      if (id && SIDEBAR_PAGE_ID_SET[id] && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  function normalizeUserUiPayload(raw) {
    var out = defaultUserUiPayload();
    if (!raw || typeof raw !== 'object') {
      return out;
    }
    out.v = typeof raw.v === 'number' ? raw.v : 1;
    if (raw.preferences && typeof raw.preferences === 'object') {
      out.preferences = normalizePreferences(raw.preferences);
    }
    if (raw.orgs && typeof raw.orgs === 'object') {
      out.orgs = raw.orgs;
    }
    out.sidebarHiddenPages = sanitizeSidebarHiddenPages(raw.sidebarHiddenPages);
    return out;
  }

  var CUSTOMERS_COLUMN_DEFS = [
    { id: 'company', label: 'Company', index: 1 },
    { id: 'contact', label: 'Contact', index: 2 },
    { id: 'email', label: 'Email', index: 3 },
    { id: 'phone', label: 'Phone', index: 4 },
    { id: 'preferred', label: 'Preferred', index: 5 },
    { id: 'style', label: 'Style', index: 6 },
    { id: 'status', label: 'Status', index: 7 },
    { id: 'projects', label: 'Projects', index: 8 },
    { id: 'revenue', label: 'Revenue', index: 9 },
    { id: 'allocated', label: 'Allocated cost', index: 10 },
    { id: 'profit', label: 'Profit', index: 11 },
    { id: 'margin', label: 'Margin', index: 12 },
    { id: 'roi', label: 'ROI', index: 13 },
    { id: 'actions', label: 'Actions', index: 14, locked: true },
  ];

  function defaultCustomersColumnPrefs() {
    var prefs = {};
    CUSTOMERS_COLUMN_DEFS.forEach(function (col) {
      prefs[col.id] = true;
    });
    return prefs;
  }

  function loadCustomersColumnPrefs() {
    var defaults = defaultCustomersColumnPrefs();
    try {
      var raw = localStorage.getItem(storageKey(CUSTOMERS_COLUMNS_PREFS_KEY));
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return defaults;
      CUSTOMERS_COLUMN_DEFS.forEach(function (col) {
        if (col.locked) return;
        if (Object.prototype.hasOwnProperty.call(parsed, col.id)) {
          defaults[col.id] = parsed[col.id] !== false;
        }
      });
      defaults.actions = true;
      return defaults;
    } catch (_) {
      return defaults;
    }
  }

  function saveCustomersColumnPrefs(prefs) {
    try {
      localStorage.setItem(storageKey(CUSTOMERS_COLUMNS_PREFS_KEY), JSON.stringify(prefs || defaultCustomersColumnPrefs()));
    } catch (_) {}
    ensureUserUiPrefsCache();
    schedulePersistUserUiPreferences();
  }

  function loadClients() {
    try {
      var raw = localStorage.getItem(storageKey(CLIENTS_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveClients(list) {
    try {
      localStorage.setItem(storageKey(CLIENTS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var clients = [];
  /** In-memory payload for Advisor “add to CRM” flows (set via window.bizDashSetAdvisorContactContext). */
  var advisorContactContext = null;
  var customersColumnPrefs = loadCustomersColumnPrefs();
  var crmEvents = [];
  var weeklySummaries = [];

  // Project statuses (for Manage statuses modal)
  var STATUS_KEY = 'project-statuses:v1';

  function loadStatuses() {
    try {
      var raw = localStorage.getItem(storageKey(STATUS_KEY));
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
      localStorage.setItem(storageKey(STATUS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var projectStatuses = loadStatuses();

  // Projects store
  var PROJECTS_KEY = 'projects:v1';

  function loadProjects() {
    try {
      var raw = localStorage.getItem(storageKey(PROJECTS_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveProjects(list) {
    try {
      localStorage.setItem(storageKey(PROJECTS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var projects = [];

  // Invoices store
  var INVOICES_KEY = 'invoices:v1';

  function loadInvoices() {
    try {
      var raw = localStorage.getItem(storageKey(INVOICES_KEY));
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveInvoices(list) {
    try {
      localStorage.setItem(storageKey(INVOICES_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var invoices = [];
  /** Unsaved activity lines for the full-screen invoice editor (cleared on save). */
  var invFsActivityBuffer = [];

  // Marketing campaigns (local only)
  var CAMPAIGNS_KEY = 'campaigns:v1';

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
      var raw = localStorage.getItem(storageKey(CAMPAIGNS_KEY));
      var arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.map(normalizeCampaign).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function saveCampaigns(list) {
    try {
      localStorage.setItem(storageKey(CAMPAIGNS_KEY), JSON.stringify(list));
    } catch (_) {}
  }

  var campaigns = [];

  // Timesheet entries (local)
  var TIMESHEET_KEY = 'timesheet:v1';

  function loadTimesheetEntries() {
    try {
      var raw = localStorage.getItem(storageKey(TIMESHEET_KEY));
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveTimesheetEntries(list) {
    try {
      localStorage.setItem(storageKey(TIMESHEET_KEY), JSON.stringify(Array.isArray(list) ? list : []));
    } catch (_) {}
  }

  var timesheetEntries = loadTimesheetEntries();
  /** Monday YYYY-MM-DD for timesheet week filter (ISO week starting Monday). */
  var timesheetWeekMondayYmd = null;
  /** 'week' | 'month' | 'quarter' | 'all' */
  var timesheetPeriodMode = 'week';
  /** Calendar month anchor YYYY-MM (first day of month). */
  var timesheetMonthYm = null;
  var timesheetQuarterYear = null;
  /** 1–4 */
  var timesheetQuarterQ = null;

  // ---------- Timesheet entries (Supabase) ----------
  function mapTimesheetRow(row) {
    var w = row.weekdays;
    if (typeof w === 'string') {
      try { w = JSON.parse(w); } catch (_) { w = []; }
    }
    if (!Array.isArray(w)) w = [];
    return {
      id: row.id,
      date: row.date ? String(row.date).slice(0, 10) : '',
      account: row.account || '',
      project: row.project || '',
      task: row.task || '',
      activityCode: row.activity_code || '',
      minutes: Math.max(0, Number(row.minutes) || 0),
      billable: row.billable !== false,
      notes: row.notes || '',
      externalNote: row.external_note || '',
      weekdays: w.map(function (n) { return Number(n); }).filter(function (n) { return !isNaN(n); }),
      createdAt: row.created_at || null,
    };
  }

  function timesheetRowForDb(entry, userId) {
    return {
      id: entry.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      date: entry.date || null,
      account: entry.account || '',
      project: entry.project || '',
      task: entry.task || '',
      activity_code: entry.activityCode || '',
      minutes: Math.max(0, Number(entry.minutes) || 0),
      billable: entry.billable !== false,
      notes: entry.notes || '',
      external_note: entry.externalNote || '',
      weekdays: Array.isArray(entry.weekdays) ? entry.weekdays : [],
      created_at: entry.createdAt ? new Date(entry.createdAt).toISOString() : new Date().toISOString(),
    };
  }

  async function persistTimesheetEntryToSupabase(entry) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !entry || !entry.id) return;
    try {
      var result = await supabase.from('timesheet_entries').upsert(timesheetRowForDb(entry, currentUser.id), { onConflict: 'id' });
      if (result.error) console.error('upsert timesheet entry error', result.error);
    } catch (err) {
      console.error('persistTimesheetEntryToSupabase error', err);
    }
  }

  async function deleteTimesheetEntryRemote(id) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !id) return;
    try {
      await supabase.from('timesheet_entries').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteTimesheetEntryRemote error', err);
    }
  }

  async function fetchTimesheetEntriesFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadTimesheetEntries();
    try {
      var result = await supabase.from('timesheet_entries').select('*').eq('organization_id', getCurrentOrgId()).order('date', { ascending: false });
      if (result.error) {
        console.error('load timesheet_entries error', result.error);
        return loadTimesheetEntries();
      }
      var rows = result.data || [];
      return rows.map(mapTimesheetRow);
    } catch (err) {
      console.error('fetchTimesheetEntriesFromSupabase error', err);
      return loadTimesheetEntries();
    }
  }

  async function uploadTimesheetEntriesToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    try {
      var payload = list.map(function (e) { return timesheetRowForDb(e, currentUser.id); });
      var result = await supabase.from('timesheet_entries').upsert(payload, { onConflict: 'id' });
      if (result.error) {
        console.error('bulk upsert timesheet_entries error', result.error);
        return false;
      }
      return true;
    } catch (err) {
      console.error('uploadTimesheetEntriesToSupabase error', err);
      return false;
    }
  }

  // ---------- Budgets store ----------

  var BUDGETS_KEY = 'budgets:v1';
  var BUDGET_MONTHS_KEY = 'budget_months:v1';

  function loadBudgets() {
    try {
      var raw = localStorage.getItem(storageKey(BUDGETS_KEY));
      var b = raw ? JSON.parse(raw) : {};
      return {
        lab: Math.max(0, Number(b.lab) || 0),
        sw:  Math.max(0, Number(b.sw)  || 0),
        ads: Math.max(0, Number(b.ads) || 0),
        oth: Math.max(0, Number(b.oth) || 0),
      };
    } catch (_) {
      return { lab: 0, sw: 0, ads: 0, oth: 0 };
    }
  }

  function loadBudgetMonthSnapshots() {
    try {
      var raw = localStorage.getItem(storageKey(BUDGET_MONTHS_KEY));
      var o = raw ? JSON.parse(raw) : {};
      return o && typeof o === 'object' ? o : {};
    } catch (_) {
      return {};
    }
  }

  function budgetSnapshotTotal(s) {
    if (!s || typeof s !== 'object') return 0;
    return Math.max(0, Number(s.lab) || 0) + Math.max(0, Number(s.sw) || 0) +
      Math.max(0, Number(s.ads) || 0) + Math.max(0, Number(s.oth) || 0);
  }

  function saveBudgetMonthSnapshotsToStorage(snaps) {
    try {
      localStorage.setItem(storageKey(BUDGET_MONTHS_KEY), JSON.stringify(snaps && typeof snaps === 'object' ? snaps : {}));
    } catch (_) {}
  }

  function saveBudgets(b) {
    var payload = {
      lab: Math.max(0, Number(b.lab) || 0),
      sw:  Math.max(0, Number(b.sw)  || 0),
      ads: Math.max(0, Number(b.ads) || 0),
      oth: Math.max(0, Number(b.oth) || 0),
    };
    try {
      localStorage.setItem(storageKey(BUDGETS_KEY), JSON.stringify(payload));
    } catch (_) {}
    try {
      var snaps = loadBudgetMonthSnapshots();
      var now = new Date();
      var mk = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      snaps[mk] = {
        lab: payload.lab,
        sw: payload.sw,
        ads: payload.ads,
        oth: payload.oth,
        savedAt: new Date().toISOString(),
      };
      saveBudgetMonthSnapshotsToStorage(snaps);
    } catch (_) {}
  }

  var budgets = loadBudgets();

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

  function invFsEnsureDetails(inv, tx) {
    var base = inv && inv.invoiceDetails && typeof inv.invoiceDetails === 'object' ? Object.assign({}, inv.invoiceDetails) : {};
    var amt = Number(inv && inv.amount != null ? inv.amount : (tx && tx.amount) || 0);
    var lines = Array.isArray(base.lineItems) ? base.lineItems.slice() : [];
    if (!lines.length) {
      lines = [
        {
          id: uuid(),
          description: (tx && tx.description) || 'Services',
          qty: 1,
          unitPrice: amt,
        },
      ];
    } else {
      lines = lines.map(function (li) {
        return {
          id: li && li.id ? li.id : uuid(),
          description: li && li.description != null ? String(li.description) : '',
          qty: Math.max(0.000001, Number(li && li.qty) || 1),
          unitPrice: Number(li && li.unitPrice) || 0,
        };
      });
    }
    var meta =
      base.metadata && typeof base.metadata === 'object' && !Array.isArray(base.metadata)
        ? Object.assign({}, base.metadata)
        : {};
    var notes = Array.isArray(base.activityNotes) ? base.activityNotes.slice() : [];
    var taxRate =
      Object.prototype.hasOwnProperty.call(base, 'taxRate') && typeof base.taxRate === 'number' && isFinite(base.taxRate)
        ? base.taxRate
        : 10;
    return {
      memo: base.memo != null ? String(base.memo) : '',
      billingMethod: base.billingMethod || 'send_invoice',
      currency: base.currency || 'USD',
      taxRate: taxRate,
      lineItems: lines,
      metadata: meta,
      activityNotes: notes,
    };
  }

  function openFullInvoiceEditor(txId) {
    var modal = $('invoiceEditFullModal');
    if (!modal) return;
    var tx = state.transactions.find(function (t) {
      return t.id === txId;
    });
    if (!tx) return;
    var inv = getInvoiceByIncomeTxId(txId);
    if (!inv) return;
    invFsActivityBuffer = [];
    var client = null;
    if (tx.clientId) {
      client = clients.find(function (c) {
        return c.id === tx.clientId;
      }) || null;
    }
    var hid = $('inv-fs-income-id');
    if (hid) hid.value = txId;
    var readOnly = inv.status === 'paid';
    var pill = $('inv-fs-pill');
    var numEl = $('inv-fs-num');
    if (numEl) numEl.textContent = inv.number || 'Invoice';
    if (pill) {
      pill.textContent =
        inv.status === 'paid' ? 'Paid' : inv.status === 'draft' ? 'Draft' : inv.status === 'sent' ? 'Sent' : inv.status || 'Open';
      pill.className =
        'inv-fs-pill' +
        (inv.status === 'paid' ? ' inv-fs-pill--paid' : inv.status === 'draft' ? ' inv-fs-pill--draft' : '');
    }
    var toName = client && client.companyName ? client.companyName : tx.description || 'Client';
    var lead = $('inv-fs-lead');
    if (lead) lead.textContent = 'Billed to ' + toName + ' • ' + fmtCurrency(inv.amount || 0);
    var cname = $('inv-fs-customer-name');
    if (cname) cname.textContent = toName;
    var em = $('inv-fs-customer-email');
    if (em) em.textContent = client && client.email ? client.email : '—';
    var ph = $('inv-fs-customer-phone');
    if (ph) {
      ph.textContent = client && client.phone ? client.phone : '';
      ph.style.display = client && client.phone ? '' : 'none';
    }
    var fn = $('inv-fs-field-number');
    if (fn) fn.value = inv.number || '';
    var fi = $('inv-fs-field-issue');
    if (fi) fi.value = inv.dateIssued || '';
    var fd = $('inv-fs-field-due');
    if (fd) fd.value = inv.dueDate || '';
    var det = invFsEnsureDetails(inv, tx);
    var fc = $('inv-fs-field-currency');
    if (fc) fc.value = det.currency === 'EUR' ? 'EUR' : 'USD';
    var fb = $('inv-fs-field-billing');
    if (fb) fb.value = det.billingMethod === 'charge_automatically' ? 'charge_automatically' : 'send_invoice';
    var fm = $('inv-fs-field-memo');
    if (fm) fm.value = det.memo;
    var ft = $('inv-fs-field-tax');
    if (ft) ft.value = String(det.taxRate != null ? det.taxRate : 10);
    var did = $('inv-fs-detail-id');
    if (did) did.textContent = inv.id || '';
    var cr = $('inv-fs-created');
    if (cr) cr.textContent = inv.createdAt ? new Date(inv.createdAt).toLocaleString() : '—';
    invFsRenderActivity(det.activityNotes, inv.createdAt);
    invFsRenderLines(det.lineItems);
    invFsRenderMetadata(det.metadata);
    invFsRecalcTotals();
    var ro = $('inv-fs-readonly');
    if (ro) ro.style.display = readOnly ? 'block' : 'none';
    [
      'inv-fs-field-number',
      'inv-fs-field-issue',
      'inv-fs-field-due',
      'inv-fs-field-currency',
      'inv-fs-field-billing',
      'inv-fs-field-memo',
      'inv-fs-field-tax',
      'inv-fs-add-line',
      'inv-fs-add-note',
      'inv-fs-metadata-add',
      'inv-fs-save',
    ].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = readOnly;
    });
    modal.classList.add('on');
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeFullInvoiceEditor() {
    var modal = $('invoiceEditFullModal');
    if (!modal) return;
    modal.classList.remove('on');
    modal.setAttribute('aria-hidden', 'true');
  }

  function invFsRenderActivity(notes, createdAt) {
    var box = $('inv-fs-activity');
    if (!box) return;
    var rows = [];
    if (createdAt) {
      rows.push('Invoice was created on ' + new Date(createdAt).toLocaleString() + '.');
    } else {
      rows.push('Invoice activity will appear here.');
    }
    (notes || []).forEach(function (n) {
      if (n && n.text) {
        rows.push(esc(String(n.text)) + (n.at ? ' — ' + new Date(n.at).toLocaleString() : ''));
      }
    });
    invFsActivityBuffer.forEach(function (t) {
      rows.push(esc(String(t)) + ' — just now');
    });
    box.innerHTML = rows
      .map(function (r) {
        return '<div class="inv-fs-activity-row">' + r + '</div>';
      })
      .join('');
  }

  function invFsAppendLineRow(li) {
    var tb = $('inv-fs-lines-body');
    if (!tb) return;
    var tr = document.createElement('tr');
    tr.dataset.lineId = li && li.id ? li.id : uuid();
    var desc = li && li.description != null ? String(li.description) : '';
    var qty = li && li.qty != null ? li.qty : 1;
    var price = li && li.unitPrice != null ? li.unitPrice : 0;
    tr.innerHTML =
      '<td><input class="fi inv-fs-li-desc" type="text" value="' +
      esc(desc) +
      '" /></td>' +
      '<td><input class="fi inv-fs-li-qty" type="number" min="0" step="0.01" value="' +
      esc(String(qty)) +
      '" /></td>' +
      '<td><input class="fi inv-fs-li-price" type="number" min="0" step="0.01" value="' +
      esc(String(price)) +
      '" /></td>' +
      '<td style="text-align:right" class="inv-fs-li-amt"></td>' +
      '<td><button type="button" class="inv-fs-iconbtn inv-fs-line-del" title="Remove">×</button></td>';
    tr.querySelectorAll('.fi').forEach(function (inp) {
      inp.addEventListener('input', invFsRecalcTotals);
    });
    var del = tr.querySelector('.inv-fs-line-del');
    if (del) {
      del.addEventListener('click', function () {
        if (tb.querySelectorAll('tr').length <= 1) return;
        tr.remove();
        invFsRecalcTotals();
      });
    }
    tb.appendChild(tr);
    invFsRecalcTotals();
  }

  function invFsRenderLines(lines) {
    var tb = $('inv-fs-lines-body');
    if (!tb) return;
    tb.innerHTML = '';
    (lines || []).forEach(function (li) {
      invFsAppendLineRow(li);
    });
    if (!tb.querySelector('tr')) {
      invFsAppendLineRow({ id: uuid(), description: '', qty: 1, unitPrice: 0 });
    }
  }

  function invFsCollectLines() {
    var tb = $('inv-fs-lines-body');
    if (!tb) return [];
    var out = [];
    tb.querySelectorAll('tr').forEach(function (tr) {
      var id = tr.dataset.lineId || uuid();
      var d = tr.querySelector('.inv-fs-li-desc');
      var q = tr.querySelector('.inv-fs-li-qty');
      var p = tr.querySelector('.inv-fs-li-price');
      out.push({
        id: id,
        description: d ? d.value.trim() : '',
        qty: Math.max(0, parseFloat(q && q.value ? q.value : '1') || 0),
        unitPrice: parseFloat(p && p.value ? p.value : '0') || 0,
      });
    });
    return out;
  }

  function invFsRecalcTotals() {
    var lines = invFsCollectLines();
    var sub = 0;
    lines.forEach(function (li) {
      var qty = Math.max(0, li.qty || 0);
      var unit = li.unitPrice || 0;
      sub += qty * unit;
    });
    var taxEl = $('inv-fs-field-tax');
    var taxPct = parseFloat(taxEl && taxEl.value ? taxEl.value : '0') || 0;
    var tax = sub * (taxPct / 100);
    var total = sub + tax;
    var tb = $('inv-fs-lines-body');
    if (tb) {
      tb.querySelectorAll('tr').forEach(function (tr) {
        var q = parseFloat(tr.querySelector('.inv-fs-li-qty') && tr.querySelector('.inv-fs-li-qty').value) || 0;
        var p = parseFloat(tr.querySelector('.inv-fs-li-price') && tr.querySelector('.inv-fs-li-price').value) || 0;
        var cell = tr.querySelector('.inv-fs-li-amt');
        if (cell) cell.textContent = fmtCurrency(q * p);
      });
    }
    var su = $('inv-fs-subtotal');
    var ta = $('inv-fs-taxamt');
    var to = $('inv-fs-total');
    if (su) su.textContent = fmtCurrency(sub);
    if (ta) ta.textContent = fmtCurrency(tax);
    if (to) to.textContent = fmtCurrency(total);
    var lead = $('inv-fs-lead');
    var txId = $('inv-fs-income-id') ? $('inv-fs-income-id').value : '';
    var tx = state.transactions.find(function (t) {
      return t.id === txId;
    });
    var client = tx && tx.clientId ? clients.find(function (c) { return c.id === tx.clientId; }) : null;
    var toName = client && client.companyName ? client.companyName : tx && tx.description ? tx.description : 'Client';
    if (lead) lead.textContent = 'Billed to ' + toName + ' • ' + fmtCurrency(total);
  }

  function invFsRenderMetadata(meta) {
    var wrap = $('inv-fs-metadata-rows');
    var empty = $('inv-fs-metadata-empty');
    if (!wrap || !empty) return;
    wrap.innerHTML = '';
    var keys = Object.keys(meta || {});
    empty.style.display = keys.length ? 'none' : 'block';
    keys.forEach(function (k) {
      invFsAppendMetaRow(k, meta[k]);
    });
  }

  function invFsAppendMetaRow(k, v) {
    var wrap = $('inv-fs-metadata-rows');
    var empty = $('inv-fs-metadata-empty');
    if (!wrap || !empty) return;
    empty.style.display = 'none';
    var row = document.createElement('div');
    row.className = 'inv-fs-meta-row';
    row.innerHTML =
      '<input class="fi inv-fs-meta-k" type="text" value="' +
      esc(k != null ? String(k) : '') +
      '" placeholder="Key" />' +
      '<input class="fi inv-fs-meta-v" type="text" value="' +
      esc(v != null ? String(v) : '') +
      '" placeholder="Value" />' +
      '<button type="button" class="inv-fs-iconbtn inv-fs-meta-del" title="Remove">×</button>';
    var del = row.querySelector('.inv-fs-meta-del');
    if (del) {
      del.addEventListener('click', function () {
        row.remove();
        if (!wrap.querySelector('.inv-fs-meta-row')) empty.style.display = 'block';
      });
    }
    wrap.appendChild(row);
  }

  function invFsCollectMetadata() {
    var wrap = $('inv-fs-metadata-rows');
    if (!wrap) return {};
    var o = {};
    wrap.querySelectorAll('.inv-fs-meta-row').forEach(function (row) {
      var k = row.querySelector('.inv-fs-meta-k');
      var v = row.querySelector('.inv-fs-meta-v');
      var key = k && k.value.trim();
      if (!key) return;
      o[key] = v && v.value != null ? String(v.value) : '';
    });
    return o;
  }

  function readFullInvoiceDraftForPreview(txId) {
    var inv = getInvoiceByIncomeTxId(txId);
    var tx = state.transactions.find(function (t) {
      return t.id === txId;
    });
    if (!inv || !tx) return null;
    var lines = invFsCollectLines();
    var taxR = parseFloat($('inv-fs-field-tax') && $('inv-fs-field-tax').value ? $('inv-fs-field-tax').value : '0') || 0;
    var sub = lines.reduce(function (s, li) {
      return s + Math.max(0, li.qty || 0) * (li.unitPrice || 0);
    }, 0);
    var total = Math.round(sub * (1 + taxR / 100) * 100) / 100;
    var prevNotes =
      inv.invoiceDetails && Array.isArray(inv.invoiceDetails.activityNotes) ? inv.invoiceDetails.activityNotes.slice() : [];
    var det = Object.assign({}, invFsEnsureDetails(inv, tx), {
      memo: $('inv-fs-field-memo') ? String($('inv-fs-field-memo').value) : '',
      billingMethod: $('inv-fs-field-billing') ? $('inv-fs-field-billing').value : 'send_invoice',
      currency: $('inv-fs-field-currency') ? $('inv-fs-field-currency').value : 'USD',
      taxRate: taxR,
      lineItems: lines,
      metadata: invFsCollectMetadata(),
      activityNotes: prevNotes,
    });
    return {
      id: inv.id,
      incomeTxId: inv.incomeTxId,
      number: $('inv-fs-field-number') ? $('inv-fs-field-number').value.trim() : inv.number,
      dateIssued: $('inv-fs-field-issue') ? $('inv-fs-field-issue').value : inv.dateIssued,
      dueDate: $('inv-fs-field-due') ? $('inv-fs-field-due').value : inv.dueDate,
      amount: total,
      status: inv.status,
      paidAt: inv.paidAt,
      stripeCheckoutSessionId: inv.stripeCheckoutSessionId,
      stripePaymentIntentId: inv.stripePaymentIntentId,
      stripeCustomerId: inv.stripeCustomerId,
      stripeStatus: inv.stripeStatus,
      invoiceDetails: det,
      createdAt: inv.createdAt,
    };
  }

  function saveFullInvoiceEditor() {
    var txId = $('inv-fs-income-id') ? $('inv-fs-income-id').value : '';
    if (!txId) return;
    var inv = getInvoiceByIncomeTxId(txId);
    var tx = state.transactions.find(function (t) {
      return t.id === txId;
    });
    if (!inv || !tx) return;
    if (inv.status === 'paid') return;
    var num = $('inv-fs-field-number') ? $('inv-fs-field-number').value.trim() : '';
    if (!num) {
      alert('Invoice number is required.');
      return;
    }
    var issue = $('inv-fs-field-issue') ? $('inv-fs-field-issue').value : '';
    var due = $('inv-fs-field-due') ? $('inv-fs-field-due').value : '';
    if (!issue || !due) {
      alert('Issue and due dates are required.');
      return;
    }
    var lines = invFsCollectLines().filter(function (li) {
      return (li.description && li.description.trim()) || li.unitPrice;
    });
    if (!lines.length) {
      alert('Add at least one line item.');
      return;
    }
    lines.forEach(function (li) {
      if (!li.description || !li.description.trim()) li.description = 'Line item';
      if (!li.qty) li.qty = 1;
    });
    var taxR = parseFloat($('inv-fs-field-tax') && $('inv-fs-field-tax').value ? $('inv-fs-field-tax').value : '0') || 0;
    var sub = lines.reduce(function (s, li) {
      return s + li.qty * li.unitPrice;
    }, 0);
    var total = Math.round(sub * (1 + taxR / 100) * 100) / 100;
    if (!total || total <= 0) {
      alert('Invoice total must be greater than zero.');
      return;
    }
    var prevDet = invFsEnsureDetails(inv, tx);
    var newNotes = (prevDet.activityNotes || []).slice();
    invFsActivityBuffer.forEach(function (t) {
      newNotes.push({ at: new Date().toISOString(), text: t });
    });
    invFsActivityBuffer = [];
    var nextDet = {
      memo: $('inv-fs-field-memo') ? String($('inv-fs-field-memo').value) : '',
      billingMethod: $('inv-fs-field-billing') ? $('inv-fs-field-billing').value : 'send_invoice',
      currency: $('inv-fs-field-currency') ? $('inv-fs-field-currency').value : 'USD',
      taxRate: taxR,
      lineItems: lines,
      metadata: invFsCollectMetadata(),
      activityNotes: newNotes,
    };
    invoices = invoices.map(function (x) {
      if (x.incomeTxId !== txId) return x;
      return Object.assign({}, x, {
        number: num,
        dateIssued: issue,
        dueDate: due,
        amount: total,
        invoiceDetails: nextDet,
      });
    });
    saveInvoices(invoices);
    recomputeAndRender();
    var saved = getInvoiceByIncomeTxId(txId);
    if (saved) persistInvoiceToSupabase(saved);
    closeFullInvoiceEditor();
  }

  function wireInvoiceFullEditor() {
    var modal = $('invoiceEditFullModal');
    if (!modal || modal.getAttribute('data-inv-fs-wired') === '1') return;
    if (!$('inv-fs-cancel') || !$('inv-fs-save')) return;
    modal.setAttribute('data-inv-fs-wired', '1');
    $('inv-fs-cancel').addEventListener('click', closeFullInvoiceEditor);
    var bc = $('inv-fs-bc');
    if (bc) bc.addEventListener('click', closeFullInvoiceEditor);
    modal.addEventListener('click', function (ev) {
      if (ev.target === modal) closeFullInvoiceEditor();
    });
    $('inv-fs-save').addEventListener('click', saveFullInvoiceEditor);
    var taxEl = $('inv-fs-field-tax');
    if (taxEl) taxEl.addEventListener('input', invFsRecalcTotals);
    var addLine = $('inv-fs-add-line');
    if (addLine) {
      addLine.addEventListener('click', function () {
        if ($('inv-fs-save') && $('inv-fs-save').disabled) return;
        invFsAppendLineRow({ id: uuid(), description: '', qty: 1, unitPrice: 0 });
      });
    }
    var addNote = $('inv-fs-add-note');
    if (addNote) {
      addNote.addEventListener('click', function () {
        if ($('inv-fs-save') && $('inv-fs-save').disabled) return;
        var t = window.prompt('Add a note to the activity log:');
        if (t && String(t).trim()) invFsActivityBuffer.push(String(t).trim());
        var txId0 = $('inv-fs-income-id') ? $('inv-fs-income-id').value : '';
        var inv0 = getInvoiceByIncomeTxId(txId0);
        var tx0 = state.transactions.find(function (x) {
          return x.id === txId0;
        });
        var det0 = inv0 && tx0 ? invFsEnsureDetails(inv0, tx0) : { activityNotes: [] };
        invFsRenderActivity(det0.activityNotes, inv0 && inv0.createdAt);
      });
    }
    var addMeta = $('inv-fs-metadata-add');
    if (addMeta) {
      addMeta.addEventListener('click', function () {
        if ($('inv-fs-save') && $('inv-fs-save').disabled) return;
        invFsAppendMetaRow('', '');
      });
    }
    var copyId = $('inv-fs-copy-id');
    if (copyId) {
      copyId.addEventListener('click', function () {
        var id = $('inv-fs-detail-id') ? $('inv-fs-detail-id').textContent : '';
        if (id && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(id);
      });
    }
    var prevBtn = $('inv-fs-preview');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        var txId1 = $('inv-fs-income-id') ? $('inv-fs-income-id').value : '';
        if (!txId1) return;
        var draft = readFullInvoiceDraftForPreview(txId1);
        var tx1 = state.transactions.find(function (t) {
          return t.id === txId1;
        });
        var body = $('invoice-preview-body');
        var prevM = $('invoicePreviewModal');
        if (!body || !prevM || !tx1 || !draft) return;
        body.innerHTML = buildInvoiceMarkup(tx1, draft);
        prevM.classList.add('on');
      });
    }
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
    if (tx.incomeCategoryLabel && String(tx.incomeCategoryLabel).trim()) {
      m.incomeCategoryLabel = String(tx.incomeCategoryLabel).trim();
    }
    if (tx.importBatchId && String(tx.importBatchId).trim()) m.importBatchId = String(tx.importBatchId).trim();
    if (tx.importSource && String(tx.importSource).trim()) m.importSource = String(tx.importSource).trim();
    if (tx.externalId != null && String(tx.externalId).trim()) m.externalId = String(tx.externalId).trim();
    if (tx.rawMemo != null && String(tx.rawMemo).trim()) m.rawMemo = String(tx.rawMemo).trim();
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
    if (meta.incomeCategoryLabel != null && String(meta.incomeCategoryLabel).trim()) {
      out.incomeCategoryLabel = String(meta.incomeCategoryLabel).trim();
    }
    if (meta.importBatchId != null && String(meta.importBatchId).trim()) out.importBatchId = String(meta.importBatchId).trim();
    if (meta.importSource != null && String(meta.importSource).trim()) out.importSource = String(meta.importSource).trim();
    if (meta.externalId != null && String(meta.externalId).trim()) out.externalId = String(meta.externalId).trim();
    if (meta.rawMemo != null && String(meta.rawMemo).trim()) out.rawMemo = String(meta.rawMemo).trim();
    if (meta.income_source === 'stripe') out.incomeSourceStripe = true;
    if (meta.stripe_payment_intent_id != null && String(meta.stripe_payment_intent_id).trim()) {
      out.stripePaymentIntentId = String(meta.stripe_payment_intent_id).trim();
    }
    if (meta.stripe_charge_id != null && String(meta.stripe_charge_id).trim()) {
      out.stripeChargeId = String(meta.stripe_charge_id).trim();
    }
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
      organization_id: getCurrentOrgId(),
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
    if (!getCurrentOrgId()) {
      saveTransactions(state.transactions);
      return;
    }

    var payload = transactionRowForDb(tx, currentUser.id);

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
    if (!getCurrentOrgId()) {
      saveTransactions(state.transactions);
      return;
    }
    try {
      var result = await supabase
        .from('transactions')
        .delete()
        .eq('id', id)
        .eq('organization_id', getCurrentOrgId());
      if (result.error) {
        console.error('delete transaction error', result.error);
      }
    } catch (err) {
      console.error('deleteTransactionRemote error', err);
    }
  }

  /** Last PostgREST/Supabase error from client persist (for user-facing alerts). */
  var persistClientLastError = '';

  function formatSupabaseErr(err) {
    if (!err) return '';
    var parts = [err.message, err.details, err.hint].filter(Boolean);
    return parts.join(' — ') || JSON.stringify(err);
  }

  /**
   * @param {'insert'|'update'} writeMode insert = new row only (avoids upsert RLS quirks); update = existing row
   * @returns {Promise<'skipped'|'ok'|'error'>}
   */
  async function persistClientToSupabase(client, writeMode) {
    persistClientLastError = '';
    if (isDemoDashboardUser()) return 'skipped';
    supabase = window.supabaseClient || supabase;
    if (!supabase) {
      persistClientLastError = 'Supabase client is not loaded.';
      return 'skipped';
    }

    var sessionRes;
    try {
      sessionRes = await supabase.auth.getSession();
    } catch (e) {
      console.error('getSession before client persist', e);
      persistClientLastError = String(e && e.message ? e.message : e);
      return 'skipped';
    }
    var session = sessionRes && sessionRes.data && sessionRes.data.session;
    if (!session || !session.user) {
      persistClientLastError = 'No active session. Sign in again.';
      currentUser = null;
      window.currentUser = null;
      return 'skipped';
    }
    currentUser = session.user;
    window.currentUser = session.user;

    if (!getCurrentOrgId()) {
      persistClientLastError = 'No workspace in this URL. Use your organization link (path starts with your org slug).';
      return 'skipped';
    }

    if (!client || !isUuidForDb(client.id)) {
      persistClientLastError = 'Invalid client id.';
      return 'skipped';
    }

    var payload = buildClientDbPayload(client, currentUser.id);
    var mode = writeMode === 'update' ? 'update' : 'insert';

    async function runWrite(body) {
      if (mode === 'insert') {
        return await supabase.from('clients').insert(body).select('id');
      }
      var bodyNoId = Object.assign({}, body);
      delete bodyNoId.id;
      return await supabase
        .from('clients')
        .update(bodyNoId)
        .eq('id', client.id)
        .eq('organization_id', getCurrentOrgId())
        .select('id');
    }

    try {
      var body = Object.assign({}, payload);
      var result;
      // Older DBs can be missing multiple optional client columns; allow enough retries
      // to progressively strip unsupported fields and still save core edits.
      var maxAttempts = 14;
      for (var attempt = 0; attempt < maxAttempts; attempt++) {
        result = await runWrite(body);
        if (!result.error) {
          if (mode === 'update' && (!result.data || !result.data.length)) {
            persistClientLastError = 'No row updated. Check that this client belongs to your account and RLS policies allow updates.';
            return 'error';
          }
          return 'ok';
        }
        console.error('persist client error', result.error);
        var errStr = JSON.stringify(result.error || {});
        var errLower = errStr.toLowerCase();
        var changed = false;
        var missingColMatch = errLower.match(/could not find the '([^']+)' column/);
        if (missingColMatch && missingColMatch[1]) {
          var missingCol = missingColMatch[1];
          if (Object.prototype.hasOwnProperty.call(body, missingCol)) {
            delete body[missingCol];
            changed = true;
          }
        }
        if (!changed && (/industry|schema cache|could not find.*column/i.test(errStr)) && Object.prototype.hasOwnProperty.call(body, 'industry')) {
          delete body.industry;
          changed = true;
          console.warn('bizdash: retrying client persist without industry — run ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS industry text;');
        }
        if (!changed && /is_retainer/i.test(errStr) && Object.prototype.hasOwnProperty.call(body, 'is_retainer')) {
          delete body.is_retainer;
          changed = true;
        }
        if (!changed && (/metadata|schema cache|could not find.*column/i.test(errStr)) && Object.prototype.hasOwnProperty.call(body, 'metadata')) {
          delete body.metadata;
          changed = true;
          console.warn('bizdash: retrying client persist without metadata — run ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT \'{}\'::jsonb;');
        }
        if (!changed && (/pipeline_id|pipeline_stage_id|schema|could not find.*column/i.test(errStr))) {
          if (Object.prototype.hasOwnProperty.call(body, 'pipeline_id')) {
            delete body.pipeline_id;
            changed = true;
          }
          if (!changed && Object.prototype.hasOwnProperty.call(body, 'pipeline_stage_id')) {
            delete body.pipeline_stage_id;
            changed = true;
          }
        }
        if (!changed) {
          ['birthday', 'communication_style', 'preferred_channel', 'last_touch_at', 'next_follow_up_at', 'relationship_notes'].some(function (col) {
            if (changed) return true;
            if (errLower.indexOf(col) !== -1 && Object.prototype.hasOwnProperty.call(body, col)) {
              delete body[col];
              changed = true;
              return true;
            }
            return false;
          });
        }
        if (!changed) {
          persistClientLastError = formatSupabaseErr(result.error);
          return 'error';
        }
      }
      persistClientLastError = formatSupabaseErr(result.error);
      return 'error';
    } catch (err) {
      console.error('persistClientToSupabase error', err);
      persistClientLastError = String(err && err.message ? err.message : err);
      return 'error';
    }
  }

  var ADVISOR_CTX_MAX = {
    id: 80,
    source: 120,
    companyName: 200,
    contactName: 200,
    email: 320,
    phone: 80,
    notes: 4000,
    receivedAt: 40,
  };

  function sliceField(s, max) {
    var t = String(s == null ? '' : s).trim();
    return t.length > max ? t.slice(0, max) : t;
  }

  function normalizeAdvisorContactContext(obj) {
    if (!obj || typeof obj !== 'object') return null;
    var out = {
      id: sliceField(obj.id, ADVISOR_CTX_MAX.id) || null,
      source: sliceField(obj.source, ADVISOR_CTX_MAX.source) || null,
      companyName: sliceField(obj.companyName, ADVISOR_CTX_MAX.companyName) || null,
      contactName: sliceField(obj.contactName, ADVISOR_CTX_MAX.contactName) || null,
      email: sliceField(obj.email, ADVISOR_CTX_MAX.email) || null,
      phone: sliceField(obj.phone, ADVISOR_CTX_MAX.phone) || null,
      notes: sliceField(obj.notes, ADVISOR_CTX_MAX.notes) || null,
      receivedAt: sliceField(obj.receivedAt, ADVISOR_CTX_MAX.receivedAt) || null,
    };
    var has = !!(out.id || out.source || out.companyName || out.contactName || out.email || out.phone || out.notes || out.receivedAt);
    return has ? out : null;
  }

  /**
   * Build a new in-memory client row from a CRM draft (Advisor proposal or contact context).
   * @returns {object|null} null if company name missing
   */
  function buildNewClientObjectFromDraft(draft) {
    var d = draft || {};
    var company = sliceField(d.companyName, ADVISOR_CTX_MAX.companyName);
    if (!company) return null;
    var firstName = sliceField(d.firstName, 120);
    var lastName = sliceField(d.lastName, 120);
    var contactName = sliceField(d.contactName, ADVISOR_CTX_MAX.contactName);
    if (!contactName && (firstName || lastName)) {
      contactName = [firstName, lastName].filter(Boolean).join(' ');
    }
    var client = {
      id: uuid(),
      companyName: company,
      contactName: contactName,
      status: sliceField(d.status, 120) || 'Lead',
      industry: sliceField(d.industry, 120),
      email: sliceField(d.email, ADVISOR_CTX_MAX.email),
      phone: sliceField(d.phone, ADVISOR_CTX_MAX.phone),
      notes: sliceField(d.notes, ADVISOR_CTX_MAX.notes),
      birthday: d.birthday ? String(d.birthday).slice(0, 32) : '',
      preferredChannel: sliceField(d.preferredChannel, 120),
      communicationStyle: sliceField(d.communicationStyle, 120),
      lastTouchAt: d.lastTouchAt ? String(d.lastTouchAt).slice(0, 32) : '',
      nextFollowUpAt: d.nextFollowUpAt ? String(d.nextFollowUpAt).slice(0, 32) : '',
      relationshipNotes: sliceField(d.relationshipNotes, 2000),
      salutation: sliceField(d.salutation, 80),
      firstName: firstName,
      lastName: lastName,
      title: sliceField(d.title, 160),
      reportsTo: sliceField(d.reportsTo, 160),
      description: sliceField(d.description, 4000),
      owner: sliceField(d.owner, 160),
      accountName: company,
      mailingCountry: sliceField(d.mailingCountry, 120),
      mailingStreet: sliceField(d.mailingStreet, 400),
      mailingCity: sliceField(d.mailingCity, 120),
      mailingState: sliceField(d.mailingState, 80),
      mailingZip: sliceField(d.mailingZip, 32),
      emailOptOut: d.emailOptOut === true,
      totalRevenue: 0,
      createdAt: Date.now(),
      retainer: !!d.retainer,
    };
    if (d.pipelineId && d.pipelineStageId) {
      client.pipelineId = d.pipelineId;
      client.pipelineStageId = d.pipelineStageId;
    }
    return client;
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
        .eq('organization_id', getCurrentOrgId());
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
      if (isUuidForDb(oldId)) return c;
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
      if (!isUuidForDb(oldPid)) {
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
      if (!isUuidForDb(oldTxId)) {
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
      if (!isUuidForDb(next.id)) {
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
      if (isUuidForDb(c.id)) return c;
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
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    var payload = list.map(function (tx) {
      return transactionRowForDb(tx, currentUser.id);
    });
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
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
    var validClients = list.filter(function (c) {
      return c && isUuidForDb(c.id);
    });
    if (!validClients.length) return false;
    var payload = validClients.map(function (client) {
      return buildClientDbPayload(client, currentUser.id);
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
      organization_id: getCurrentOrgId(),
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
      await supabase.from('projects').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteProjectRemote error', err);
    }
  }

  async function fetchProjectsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadProjects();
    try {
      var result = await supabase.from('projects').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: true });
      if (result.error) {
        console.error('load projects error', result.error);
        return loadProjects();
      }
      var rows = result.data || [];
      return rows.map(mapProjectRow);
    } catch (err) {
      console.error('fetchProjectsFromSupabase error', err);
      return loadProjects();
    }
  }

  async function uploadProjectsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
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
    var det = row.invoice_details;
    if (det && typeof det === 'string') {
      try {
        det = JSON.parse(det);
      } catch (_) {
        det = {};
      }
    }
    if (!det || typeof det !== 'object') det = {};
    return {
      id: row.id,
      incomeTxId: row.income_tx_id,
      number: row.number || '',
      dateIssued: row.date_issued ? String(row.date_issued).slice(0, 10) : '',
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : '',
      amount: Number(row.amount || 0),
      status: row.status || 'sent',
      paidAt: row.paid_at ? String(row.paid_at).slice(0, 10) : null,
      stripeCheckoutSessionId: row.stripe_checkout_session_id || null,
      stripePaymentIntentId: row.stripe_payment_intent_id || null,
      stripeCustomerId: row.stripe_customer_id || null,
      stripeStatus: row.stripe_status || null,
      invoiceDetails: det,
      createdAt: row.created_at ? String(row.created_at) : null,
    };
  }

  function invoiceRowForDb(inv, userId) {
    var row = {
      id: inv.id,
      user_id: userId,
      organization_id: getCurrentOrgId(),
      income_tx_id: inv.incomeTxId,
      number: inv.number,
      date_issued: inv.dateIssued,
      due_date: inv.dueDate,
      amount: inv.amount,
      status: inv.status || 'sent',
      paid_at: inv.paidAt || null,
      stripe_checkout_session_id: inv.stripeCheckoutSessionId || null,
      stripe_payment_intent_id: inv.stripePaymentIntentId || null,
      stripe_customer_id: inv.stripeCustomerId || null,
      stripe_status: inv.stripeStatus || null,
    };
    if (inv.invoiceDetails && typeof inv.invoiceDetails === 'object') {
      row.invoice_details = inv.invoiceDetails;
    }
    return row;
  }

  async function startStripeCheckoutForInvoice(inv) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !inv || !inv.id) {
      alert('Sign in first to start Stripe Checkout.');
      return;
    }
    var base =
      typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
    var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey.trim() : '';
    try {
      var sessRes = await supabase.auth.getSession();
      var tok = sessRes && sessRes.data && sessRes.data.session ? sessRes.data.session.access_token : '';
      if (!tok) {
        alert('Sign in again to start Stripe Checkout.');
        return;
      }
      if (!base || !anon) {
        alert('Supabase URL or anon key is not configured.');
        return;
      }
      var res = await fetch(base + '/functions/v1/create-stripe-checkout-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + tok,
          apikey: anon,
        },
        body: JSON.stringify({
          invoiceId: inv.id,
          organizationId: getCurrentOrgId(),
          successUrl: window.location.origin + window.location.pathname + '?payment=success',
          cancelUrl: window.location.origin + window.location.pathname + '?payment=cancel',
        }),
      });
      var payload = {};
      try {
        payload = await res.json();
      } catch (_) {}
      if (!res.ok) {
        try {
          console.error(
            '[bizdash]',
            JSON.stringify({
              kind: 'edge_fetch',
              correlationId: window.__bizdashCorrelationId || '',
              fnName: 'create-stripe-checkout-session',
              httpStatus: res.status,
              message: String((payload && payload.error) || res.statusText || ''),
            }),
          );
        } catch (_) {}
        if (payload && payload.code === 'STRIPE_CONNECT_REQUIRED') {
          alert(
            (payload.error || 'Stripe is not ready for this workspace.') +
              '\n\nAn owner or admin can complete setup under Settings → Connections (Stripe).',
          );
          if (typeof window.nav === 'function') {
            window.nav('settings', document.querySelector('.ni[data-nav="settings"]'));
            var st = document.getElementById('settings-nav-connections');
            if (st) st.click();
            window.setTimeout(function () {
              bizdashOpenConnDetailSubmodal('stripe');
            }, 80);
          }
          return;
        }
        alert('Stripe checkout failed: ' + (payload.error || res.statusText || 'Unknown error'));
        return;
      }
      if (!payload.url) {
        alert('Stripe checkout failed: no redirect URL returned.');
        return;
      }
      window.location.href = String(payload.url);
    } catch (err) {
      try {
        console.error(
          '[bizdash]',
          JSON.stringify({
            kind: 'edge_fetch',
            correlationId: window.__bizdashCorrelationId || '',
            fnName: 'create-stripe-checkout-session',
            message: err && err.message ? String(err.message) : String(err),
          }),
        );
      } catch (_) {}
      console.error('startStripeCheckoutForInvoice error', err);
      alert('Stripe checkout failed. Check console and edge function logs.');
    }
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
      await supabase.from('invoices').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteInvoiceRemote error', err);
    }
  }

  async function fetchInvoicesFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadInvoices();
    try {
      var result = await supabase.from('invoices').select('*').eq('organization_id', getCurrentOrgId()).order('date_issued', { ascending: false });
      if (result.error) {
        console.error('load invoices error', result.error);
        return loadInvoices();
      }
      var rows = result.data || [];
      return rows.map(mapInvoiceRow);
    } catch (err) {
      console.error('fetchInvoicesFromSupabase error', err);
      return loadInvoices();
    }
  }

  async function uploadInvoicesToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
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
      organization_id: getCurrentOrgId(),
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
      await supabase.from('campaigns').delete().eq('id', id).eq('organization_id', getCurrentOrgId());
    } catch (err) {
      console.error('deleteCampaignRemote error', err);
    }
  }

  async function fetchCampaignsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return loadCampaigns();
    try {
      var result = await supabase.from('campaigns').select('*').eq('organization_id', getCurrentOrgId()).order('start_date', { ascending: false });
      if (result.error) {
        console.error('load campaigns error', result.error);
        return loadCampaigns();
      }
      var rows = result.data || [];
      return rows.map(mapCampaignRow);
    } catch (err) {
      console.error('fetchCampaignsFromSupabase error', err);
      return loadCampaigns();
    }
  }

  async function uploadCampaignsToSupabase(list) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || !Array.isArray(list) || !list.length) return false;
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

  // ---------- Workspace preferences (theme, locale, calendar; dashboard_settings.preferences) ----------
  var __bizdashThemeMediaCleanup = null;

  function getDefaultPreferences() {
    return {
      theme: 'system',
      language: 'en-US',
      numberFormat: 'default',
      weekStartsMonday: false,
      dateMentionFormat: 'relative',
      timezoneAuto: true,
      timezone: 'America/Chicago',
    };
  }

  function isValidTimeZone(z) {
    if (!z || typeof z !== 'string') return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: z }).format(new Date());
      return true;
    } catch (e) {
      return false;
    }
  }

  function normalizePreferences(inP) {
    var d = getDefaultPreferences();
    var p = inP && typeof inP === 'object' ? inP : {};
    var theme = String(p.theme || '').toLowerCase();
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') theme = d.theme;
    var language = String(p.language || d.language).trim() || d.language;
    var numberFormat = String(p.numberFormat != null ? p.numberFormat : d.numberFormat).trim() || d.numberFormat;
    if (numberFormat !== 'default' && numberFormat.length < 2) numberFormat = d.numberFormat;
    var weekStartsMonday = !!p.weekStartsMonday;
    var df = String(p.dateMentionFormat || '').toLowerCase();
    if (df !== 'absolute') df = 'relative';
    var timezoneAuto = d.timezoneAuto;
    if (p.timezoneAuto === false || p.timezoneAuto === 0 || String(p.timezoneAuto).toLowerCase() === 'false') {
      timezoneAuto = false;
    } else if (p.timezoneAuto === true || p.timezoneAuto === 1 || String(p.timezoneAuto).toLowerCase() === 'true') {
      timezoneAuto = true;
    }
    var timezone = String(p.timezone || d.timezone).trim() || d.timezone;
    if (!isValidTimeZone(timezone)) timezone = d.timezone;
    return {
      theme: theme,
      language: language,
      numberFormat: numberFormat,
      weekStartsMonday: weekStartsMonday,
      dateMentionFormat: df,
      timezoneAuto: timezoneAuto,
      timezone: timezone,
    };
  }

  function readPreferencesFromDom() {
    function gid(id) {
      return document.getElementById(id);
    }
    function val(id, def) {
      var el = gid(id);
      if (!el) return def;
      var s = String(el.value || '').trim();
      return s || def;
    }
    function chk(id) {
      var el = gid(id);
      return !!(el && el.checked);
    }
    return normalizePreferences({
      theme: val('pref-theme', 'system'),
      language: val('pref-language', 'en-US'),
      numberFormat: val('pref-number-format', 'default'),
      weekStartsMonday: chk('pref-week-starts-mon'),
      dateMentionFormat: val('pref-date-mention-format', 'relative'),
      timezoneAuto: chk('pref-timezone-auto'),
      timezone: val('pref-timezone', getDefaultPreferences().timezone),
    });
  }

  function applyPreferencesToForm(prefs) {
    prefs = normalizePreferences(prefs);
    function gid(id) {
      return document.getElementById(id);
    }
    function setv(id, value) {
      var el = gid(id);
      if (!el) return;
      el.value = String(value);
    }
    ensurePreferenceTimezoneOptionsBuilt();
    setv('pref-theme', prefs.theme);
    setv('pref-language', prefs.language);
    setv('pref-number-format', prefs.numberFormat);
    setv('pref-date-mention-format', prefs.dateMentionFormat);
    var wk = gid('pref-week-starts-mon');
    if (wk) wk.checked = !!prefs.weekStartsMonday;
    var auto = gid('pref-timezone-auto');
    if (auto) auto.checked = !!prefs.timezoneAuto;
    var tz = gid('pref-timezone');
    if (tz) {
      setTimezoneComboboxFromHiddenId('pref-timezone', prefs.timezone);
      setPrefTimezoneComboboxInteractive(!prefs.timezoneAuto);
    }
    syncProfileWeekSelectFromMainCheckbox();
  }

  /** Keep Profile "Start week on" aligned with General → Calendar toggle (same settings modal). */
  function syncProfileWeekSelectFromMainCheckbox() {
    var chk = document.getElementById('pref-week-starts-mon');
    var sel = document.getElementById('profile-pref-week-start');
    if (!chk || !sel) return;
    sel.value = chk.checked ? 'monday' : 'sunday';
  }

  function applyPreferencesRuntime(prefs) {
    prefs = normalizePreferences(prefs);
    window.__bizdashPreferences = prefs;
    var root = document.documentElement;
    if (__bizdashThemeMediaCleanup) {
      try {
        __bizdashThemeMediaCleanup();
      } catch (_) {}
      __bizdashThemeMediaCleanup = null;
    }
    root.dataset.theme = prefs.theme;
    function setEffective(isDark) {
      root.dataset.colorScheme = isDark ? 'dark' : 'light';
    }
    if (prefs.theme === 'dark') {
      setEffective(true);
    } else if (prefs.theme === 'light') {
      setEffective(false);
    } else {
      var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.matches != null) {
        var fn = function () {
          setEffective(!!mq.matches);
        };
        fn();
        if (mq.addEventListener) {
          mq.addEventListener('change', fn);
          __bizdashThemeMediaCleanup = function () {
            mq.removeEventListener('change', fn);
          };
        } else if (mq.addListener) {
          mq.addListener(fn);
          __bizdashThemeMediaCleanup = function () {
            mq.removeListener(fn);
          };
        }
      } else {
        setEffective(false);
      }
    }
    if (prefs.language) {
      root.lang = prefs.language;
    }
    setPrefTimezoneComboboxInteractive(!prefs.timezoneAuto);
  }

  function getFallbackTimeZones() {
    return [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Toronto',
      'America/Vancouver',
      'America/Sao_Paulo',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Madrid',
      'Europe/Amsterdam',
      'Europe/Warsaw',
      'Asia/Tokyo',
      'Asia/Shanghai',
      'Asia/Hong_Kong',
      'Asia/Singapore',
      'Asia/Kolkata',
      'Australia/Sydney',
      'Pacific/Auckland',
    ];
  }

  function getTzDisplayNamesCached() {
    if (__bizdashTzDN !== undefined) return __bizdashTzDN === false ? null : __bizdashTzDN;
    __bizdashTzDN = false;
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
        __bizdashTzDN = new Intl.DisplayNames(navigator.language || 'en-US', { type: 'timeZone' });
      }
    } catch (_) {}
    return __bizdashTzDN === false ? null : __bizdashTzDN;
  }

  function tzHaystackForId(id, dn) {
    var disp = '';
    if (dn && typeof dn.of === 'function') {
      try {
        disp = String(dn.of(id) || '');
      } catch (_) {}
    }
    return (id + ' ' + disp).toLowerCase().replace(/\//g, ' ').replace(/_/g, ' ');
  }

  function tzSubtitleFor(id) {
    var dn = getTzDisplayNamesCached();
    if (!dn || typeof dn.of !== 'function') return '';
    try {
      var s = String(dn.of(id) || '').trim();
      return s && s !== id ? s : '';
    } catch (_) {
      return '';
    }
  }

  function getPreferenceTimeZoneList() {
    if (__bizdashTzListCache && __bizdashTzListCache.length) return __bizdashTzListCache;
    var list = [];
    try {
      if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
        list = Intl.supportedValuesOf('timeZone');
      }
    } catch (_) {}
    if (!list || !list.length) list = getFallbackTimeZones();
    __bizdashTzListCache = list;
    var dn = getTzDisplayNamesCached();
    __bizdashTzSearchRecords = list.map(function (id) {
      return { id: id, haystack: tzHaystackForId(id, dn) };
    });
    return __bizdashTzListCache;
  }

  function ensureTimeZoneInList(iana) {
    if (!iana || typeof iana !== 'string') return;
    var z = String(iana).trim();
    if (!z) return;
    getPreferenceTimeZoneList();
    for (var i = 0; i < __bizdashTzListCache.length; i++) {
      if (__bizdashTzListCache[i] === z) return;
    }
    __bizdashTzListCache.push(z);
    __bizdashTzSearchRecords.push({ id: z, haystack: tzHaystackForId(z, getTzDisplayNamesCached()) });
  }

  function setTimezoneComboboxFromHiddenId(hiddenId, iana) {
    ensureTimeZoneInList(iana);
    var hid = document.getElementById(hiddenId);
    if (!hid) return;
    hid.value = String(iana || '').trim();
    var wrap = hid.closest ? hid.closest('.tz-combobox') : null;
    var inp = wrap ? wrap.querySelector('.tz-combobox-input') : null;
    if (inp) inp.value = hid.value;
  }

  function setPrefTimezoneComboboxInteractive(enabled) {
    var hid = document.getElementById('pref-timezone');
    var inp = document.getElementById('pref-timezone-input');
    if (hid) hid.disabled = !enabled;
    if (inp) inp.disabled = !enabled;
  }

  function recordsMatchingTzQuery(rawQuery, maxResults) {
    getPreferenceTimeZoneList();
    var MAX = typeof maxResults === 'number' ? maxResults : 80;
    var query = String(rawQuery || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!query) return __bizdashTzSearchRecords.slice(0, MAX);
    var out = [];
    for (var i = 0; i < __bizdashTzSearchRecords.length && out.length < MAX; i++) {
      var r = __bizdashTzSearchRecords[i];
      if (r.haystack.indexOf(query) !== -1) out.push(r);
    }
    return out;
  }

  function initTimezoneComboboxIfNeeded(wrap) {
    if (!wrap || wrap.getAttribute('data-tz-combo-wired') === '1') return;
    wrap.setAttribute('data-tz-combo-wired', '1');
    var hidden = wrap.querySelector('input[type="hidden"]');
    var input = wrap.querySelector('.tz-combobox-input');
    var list = wrap.querySelector('.tz-combobox-list');
    if (!hidden || !input || !list) return;

    var filtered = [];
    var activeIdx = -1;

    function renderOptions() {
      list.innerHTML = '';
      filtered.forEach(function (rec, idx) {
        var li = document.createElement('li');
        li.className = 'tz-combobox-option' + (idx === activeIdx ? ' is-active' : '');
        li.setAttribute('role', 'option');
        li.id = list.id + '-opt-' + idx;
        li.setAttribute('aria-selected', idx === activeIdx ? 'true' : 'false');
        li.setAttribute('data-iana', rec.id);
        li.appendChild(document.createTextNode(rec.id));
        var sub = tzSubtitleFor(rec.id);
        if (sub) {
          var span = document.createElement('span');
          span.className = 'tz-combobox-meta';
          span.textContent = sub;
          li.appendChild(span);
        }
        li.addEventListener('mousedown', function (e) {
          e.preventDefault();
          commit(rec.id);
        });
        list.appendChild(li);
      });
      var optsAll = list.querySelectorAll('.tz-combobox-option');
      if (activeIdx >= 0 && optsAll[activeIdx]) {
        input.setAttribute('aria-activedescendant', optsAll[activeIdx].id);
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function openList() {
      list.classList.add('on');
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function closeList() {
      activeIdx = -1;
      list.classList.remove('on');
      list.hidden = true;
      list.innerHTML = '';
      filtered = [];
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function commit(iana) {
      if (!iana || !isValidTimeZone(iana)) return;
      ensureTimeZoneInList(iana);
      hidden.value = iana;
      input.value = iana;
      closeList();
      try {
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (_) {}
    }

    function refreshFilterFromInput() {
      filtered = recordsMatchingTzQuery(input.value);
      activeIdx = filtered.length ? 0 : -1;
      renderOptions();
      openList();
    }

    function showInitialList() {
      filtered = recordsMatchingTzQuery('');
      activeIdx = filtered.length ? 0 : -1;
      renderOptions();
      openList();
    }

    input.addEventListener('focus', function () {
      try {
        input.select();
      } catch (_) {}
      showInitialList();
    });

    input.addEventListener('input', function () {
      refreshFilterFromInput();
    });

    input.addEventListener('keydown', function (e) {
      if (input.disabled) return;
      var k = e.key;
      if (k === 'Escape') {
        if (!list.hidden && list.classList.contains('on')) {
          e.preventDefault();
          closeList();
          input.value = hidden.value || '';
        }
        return;
      }
      if (k === 'ArrowDown') {
        e.preventDefault();
        if (list.hidden || !list.classList.contains('on')) {
          refreshFilterFromInput();
        } else if (filtered.length) {
          activeIdx = Math.min(activeIdx + 1, filtered.length - 1);
          renderOptions();
          var el = list.querySelector('.tz-combobox-option.is-active');
          if (el) el.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (k === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden || !list.classList.contains('on')) {
          refreshFilterFromInput();
        } else if (filtered.length) {
          activeIdx = Math.max(activeIdx - 1, 0);
          renderOptions();
          var elUp = list.querySelector('.tz-combobox-option.is-active');
          if (elUp) elUp.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      if (k === 'Enter') {
        if (!list.hidden && list.classList.contains('on')) {
          if (activeIdx >= 0 && filtered[activeIdx]) {
            e.preventDefault();
            commit(filtered[activeIdx].id);
          } else if (filtered.length === 1) {
            e.preventDefault();
            commit(filtered[0].id);
          }
        }
        return;
      }
      if (k === 'Tab') {
        closeList();
      }
    });

    input.addEventListener('blur', function () {
      window.setTimeout(function () {
        if (wrap.contains(document.activeElement)) return;
        closeList();
        var v = String(input.value || '').trim();
        if (v && isValidTimeZone(v)) {
          if (v !== hidden.value) commit(v);
          else input.value = hidden.value;
        } else {
          input.value = hidden.value || '';
        }
      }, 200);
    });

    document.addEventListener('mousedown', function onDoc(e) {
      if (!wrap.contains(e.target)) closeList();
    });

    if (hidden.value) {
      input.value = hidden.value;
    }
  }

  function initAllTimezoneComboboxes() {
    var a = document.getElementById('pref-timezone-wrap');
    var b = document.getElementById('profile-pref-timezone-wrap');
    if (a) initTimezoneComboboxIfNeeded(a);
    if (b) initTimezoneComboboxIfNeeded(b);
  }

  function ensurePreferenceTimezoneOptionsBuilt() {
    getPreferenceTimeZoneList();
    initAllTimezoneComboboxes();
  }

  // ---------- App settings (custom project status labels) ----------
  async function fetchAppSettingsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return null;
    try {
      var result = await supabase.from('app_settings').select('*').eq('organization_id', getCurrentOrgId()).maybeSingle();
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

  function collectDashboardSettingsForCloud() {
    function gid(id) {
      return document.getElementById(id);
    }
    function val(id) {
      var el = gid(id);
      return el ? String(el.value || '').trim() : '';
    }
    function numEl(id, def) {
      var el = gid(id);
      var n = el ? parseFloat(el.value) : NaN;
      return isNaN(n) ? def : n;
    }
    var curEl = gid('setting-currency');
    var fiscalEl = gid('setting-fiscal');
    var brandImg = gid('sb-brand-img');
    return {
      business: {
        name: val('setting-name'),
        owner: val('setting-owner'),
        email: val('setting-email'),
        phone: val('setting-phone'),
        address: val('setting-address'),
        period: val('setting-period'),
        accent: parseAccentHexOrNull(val('setting-accent-hex')) || normalizeHexColor(val('setting-accent'), '#e8501a'),
        terms: Math.max(0, Math.round(numEl('setting-terms', 30))),
        tax: Math.max(0, numEl('setting-tax', 0)),
        currency: curEl && curEl.value ? curEl.value : 'USD',
        fiscal: fiscalEl && fiscalEl.value ? fiscalEl.value : 'January',
        logo_light_url: brandImg && brandImg.getAttribute('data-logo-light') ? String(brandImg.getAttribute('data-logo-light')) : '',
        logo_dark_url: brandImg && brandImg.getAttribute('data-logo-dark') ? String(brandImg.getAttribute('data-logo-dark')) : '',
        tagline: val('setting-tagline'),
        ownerRole: val('setting-owner-role'),
      },
      budgets: {
        lab: Math.max(0, Number(budgets.lab) || 0),
        sw: Math.max(0, Number(budgets.sw) || 0),
        ads: Math.max(0, Number(budgets.ads) || 0),
        oth: Math.max(0, Number(budgets.oth) || 0),
      },
      budgetMonths: loadBudgetMonthSnapshots(),
      workspace: readWorkspacePrefsFromDom(),
    };
  }

  function defaultWorkspacePrefs() {
    return {
      allowedEmailDomains: '',
      pageViewAnalytics: true,
      peopleDirectory: true,
      peopleRecentActivity: true,
      peopleHoverCards: true,
      workspaceIconEmoji: '',
      workspaceIconUrl: '',
      workspaceIconIconify: '',
    };
  }

  function mergeWorkspacePrefs(prev, next) {
    var d = defaultWorkspacePrefs();
    var p = prev && typeof prev === 'object' ? prev : {};
    var n = next && typeof next === 'object' ? next : {};
    var out = Object.assign({}, d, p);
    Object.keys(n).forEach(function (k) {
      if (n[k] !== undefined) out[k] = n[k];
    });
    return out;
  }

  function readWorkspacePrefsFromDom() {
    if (!document.getElementById('setting-ws-toggle-analytics')) return defaultWorkspacePrefs();
    function hid(id) {
      var el = document.getElementById(id);
      return el ? String(el.value || '').trim() : '';
    }
    function chk(id) {
      var el = document.getElementById(id);
      return el ? !!el.checked : false;
    }
    return {
      allowedEmailDomains: (function () {
        var el = document.getElementById('setting-ws-domains');
        return el ? String(el.value || '').trim() : '';
      })(),
      pageViewAnalytics: chk('setting-ws-toggle-analytics'),
      peopleDirectory: chk('setting-ws-toggle-people-dir'),
      peopleRecentActivity: chk('setting-ws-toggle-people-activity'),
      peopleHoverCards: chk('setting-ws-toggle-hover-cards'),
      workspaceIconEmoji: hid('setting-ws-icon-emoji-value'),
      workspaceIconUrl: hid('setting-ws-icon-url-value'),
      workspaceIconIconify: parseWorkspaceIconIconify(hid('setting-ws-icon-iconify-value')),
    };
  }

  function syncWorkspacePrefsCacheFromDom() {
    try {
      window.bizdashWorkspacePrefs = mergeWorkspacePrefs(
        window.bizdashWorkspacePrefs || defaultWorkspacePrefs(),
        readWorkspacePrefsFromDom()
      );
    } catch (_) {}
  }

  function applyWorkspacePrefsToDom(ws) {
    ws = mergeWorkspacePrefs({}, ws || {});
    window.bizdashWorkspacePrefs = ws;
    function setChk(id, v) {
      var el = document.getElementById(id);
      if (el) el.checked = !!v;
    }
    var dom = document.getElementById('setting-ws-domains');
    if (dom) dom.value = ws.allowedEmailDomains != null ? String(ws.allowedEmailDomains) : '';
    setChk('setting-ws-toggle-analytics', ws.pageViewAnalytics);
    setChk('setting-ws-toggle-people-dir', ws.peopleDirectory);
    setChk('setting-ws-toggle-people-activity', ws.peopleRecentActivity);
    setChk('setting-ws-toggle-hover-cards', ws.peopleHoverCards);
    var em = document.getElementById('setting-ws-icon-emoji-value');
    var ur = document.getElementById('setting-ws-icon-url-value');
    var ic = document.getElementById('setting-ws-icon-iconify-value');
    if (em) em.value = ws.workspaceIconEmoji != null ? String(ws.workspaceIconEmoji) : '';
    if (ur) ur.value = ws.workspaceIconUrl != null ? String(ws.workspaceIconUrl) : '';
    if (ic) ic.value = parseWorkspaceIconIconify(ws.workspaceIconIconify != null ? String(ws.workspaceIconIconify) : '');
    renderWorkspaceIconPreview();
  }

  function parseWorkspaceIconIconify(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var idx = s.indexOf(':');
    if (idx < 1) return '';
    var pre = s.slice(0, idx).toLowerCase();
    var name = s.slice(idx + 1).trim().toLowerCase();
    if (pre !== 'lucide' || !name) return '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return '';
    return 'lucide:' + name;
  }

  function lucideIconifySvgImgSrc(iconName) {
    var n = String(iconName || '').trim().toLowerCase();
    if (!n) return '';
    return 'https://api.iconify.design/lucide/' + encodeURIComponent(n) + '.svg';
  }

  async function renderWorkspaceIconPreview() {
    var emojiH = document.getElementById('setting-ws-icon-emoji-value');
    var urlH = document.getElementById('setting-ws-icon-url-value');
    var iconifyH = document.getElementById('setting-ws-icon-iconify-value');
    var prev = document.getElementById('setting-ws-icon-preview');
    if (!prev) return;
    var url = urlH ? String(urlH.value || '').trim() : '';
    var iconify = iconifyH ? parseWorkspaceIconIconify(iconifyH.value) : '';
    var emo = emojiH ? String(emojiH.value || '').trim() : '';
    prev.innerHTML = '';
    if (url) {
      var resolved = await resolveBrandLogoStorageUrl(url);
      var img = document.createElement('img');
      img.alt = '';
      img.src = resolved || url;
      prev.appendChild(img);
    } else if (iconify) {
      var nm = iconify.slice('lucide:'.length);
      var imgI = document.createElement('img');
      imgI.alt = '';
      imgI.loading = 'lazy';
      imgI.src = lucideIconifySvgImgSrc(nm);
      imgI.width = 22;
      imgI.height = 22;
      prev.appendChild(imgI);
    } else     if (emo) {
      prev.textContent = emo.slice(0, 10);
    } else {
      prev.textContent = '🏢';
    }
    syncWorkspacePrefsCacheFromDom();
    void refreshWorkspaceSidebarMonogramFromPrefs();
  }

  async function hydrateWorkspaceSettingsFields() {
    var oidEl = document.getElementById('setting-ws-org-id');
    var oid = getCurrentOrgId();
    if (oidEl) oidEl.textContent = oid ? String(oid) : '—';
    var nameEl = document.getElementById('setting-ws-name');
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (supabase && oid && currentUser && !isDemoDashboardUser()) {
      try {
        var r = await supabase.from('organizations').select('name').eq('id', oid).maybeSingle();
        if (r.data && r.data.name != null && nameEl) nameEl.value = String(r.data.name);
        if (r.data && r.data.name) window.currentOrganizationDisplayName = String(r.data.name);
      } catch (_) {}
    }
    var exportDesc = document.getElementById('setting-ws-export-content-desc');
    if (exportDesc) {
      var nm =
        nameEl && nameEl.value.trim()
          ? nameEl.value.trim()
          : window.currentOrganizationDisplayName || '';
      exportDesc.textContent =
        'Export clients, transactions, projects, invoices, campaigns, and timesheet entries for ' +
        (nm || 'this workspace') +
        ' as JSON.';
    }
    updateWorkspaceIconAdminUi();
    if (typeof window.refreshSidebarWorkspaceChrome === 'function') window.refreshSidebarWorkspaceChrome();
  }

  function updateWorkspaceIconAdminUi() {
    var role = window.currentOrganizationRole || '';
    var can = role === 'owner' || role === 'admin';
    ['setting-ws-icon-hit', 'setting-ws-icon-emoji-btn', 'setting-ws-icon-clear'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.disabled = !can;
      el.setAttribute('aria-disabled', can ? 'false' : 'true');
    });
    var fi = document.getElementById('setting-ws-icon-file');
    if (fi) fi.disabled = !can;
    var hint = document.getElementById('setting-ws-icon-role-hint');
    if (hint) hint.hidden = !!can;
  }
  window.bizdashUpdateWorkspaceIconAdminUi = updateWorkspaceIconAdminUi;

  async function persistWorkspaceOrganizationName() {
    var el = document.getElementById('setting-ws-name');
    var nm = el ? String(el.value || '').trim() : '';
    if (!nm || nm.length > 65) return;
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    var oid = getCurrentOrgId();
    if (!supabase || !currentUser || !oid || isDemoDashboardUser()) return;
    var role = window.currentOrganizationRole || '';
    if (role !== 'owner' && role !== 'admin') return;
    try {
      var res = await supabase
        .from('organizations')
        .update({ name: nm, updated_at: new Date().toISOString() })
        .eq('id', oid);
      if (res.error) console.error('update organization name', res.error);
      else window.currentOrganizationDisplayName = nm;
      if (typeof window.refreshSidebarWorkspaceChrome === 'function') window.refreshSidebarWorkspaceChrome();
    } catch (err) {
      console.error('persistWorkspaceOrganizationName', err);
    }
  }

  function refreshSettingsBudgetInputsFromState() {
    ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
      var el = document.getElementById('budget-input-' + k);
      if (el) el.value = budgets[k] > 0 ? String(budgets[k]) : '';
    });
  }

  function mergeDashboardSettingsForPersist(prevDash, nextDash) {
    if (!prevDash || typeof prevDash !== 'object') return nextDash;
    var pb = prevDash.business && typeof prevDash.business === 'object' ? prevDash.business : {};
    var nb = nextDash.business && typeof nextDash.business === 'object' ? nextDash.business : {};
    var mergedBusiness = Object.assign({}, pb);
    ['name', 'owner', 'ownerRole', 'email', 'phone', 'address', 'period', 'accent', 'currency', 'fiscal', 'logo_light_url', 'logo_dark_url', 'tagline'].forEach(function (k) {
      var nv = nb[k];
      if (nv != null && String(nv).trim()) mergedBusiness[k] = nv;
    });
    mergedBusiness.terms = nb.terms != null ? nb.terms : pb.terms != null ? pb.terms : 30;
    mergedBusiness.tax = nb.tax != null ? nb.tax : pb.tax != null ? pb.tax : 0;
    var pw = prevDash.workspace && typeof prevDash.workspace === 'object' ? prevDash.workspace : {};
    var nw = nextDash.workspace && typeof nextDash.workspace === 'object' ? nextDash.workspace : {};
    var mergedWorkspace = mergeWorkspacePrefs(pw, nw);
    var out = {
      business: mergedBusiness,
      budgets: nextDash.budgets && typeof nextDash.budgets === 'object' ? nextDash.budgets : { lab: 0, sw: 0, ads: 0, oth: 0 },
      budgetMonths: Object.assign({}, prevDash.budgetMonths || {}, nextDash.budgetMonths || {}),
      workspace: mergedWorkspace,
    };
    if (Array.isArray(nextDash.email_templates)) {
      out.email_templates = nextDash.email_templates;
    } else if (Array.isArray(prevDash.email_templates)) {
      out.email_templates = prevDash.email_templates;
    }
    return out;
  }

  async function applyDashboardSettingsFromCloud(raw) {
    if (raw == null || typeof raw !== 'object') return;
    if (!raw.business && !raw.budgets && !raw.budgetMonths && !raw.workspace) return;
    var biz = raw.business;
    if (biz && typeof biz === 'object') {
      function gid(id) {
        return document.getElementById(id);
      }
      function setv(id, v) {
        var el = gid(id);
        if (!el || v == null) return;
        el.value = v;
      }
      if (biz.name != null) setv('setting-name', biz.name);
      if (biz.owner != null) setv('setting-owner', biz.owner);
      if (biz.email != null) setv('setting-email', biz.email);
      if (biz.phone != null) setv('setting-phone', biz.phone);
      if (biz.address != null) setv('setting-address', biz.address);
      if (biz.period != null) setv('setting-period', biz.period);
      if (biz.accent) {
        var accentNorm = normalizeHexColor(biz.accent, '#e8501a');
        setv('setting-accent', accentNorm);
        setv('setting-accent-hex', accentNorm);
        syncAccentPresetSwatches(accentNorm);
      }
      if (biz.terms != null) setv('setting-terms', String(biz.terms));
      if (biz.tax != null) setv('setting-tax', String(biz.tax));
      var cur = gid('setting-currency');
      if (cur && biz.currency) cur.value = biz.currency;
      var fis = gid('setting-fiscal');
      if (fis && biz.fiscal) fis.value = biz.fiscal;
      if (biz.accent) applyAccentBranding(normalizeHexColor(biz.accent, '#e8501a'));
      var lightSigned = await resolveBrandLogoStorageUrl(biz.logo_light_url || '');
      var darkSigned = await resolveBrandLogoStorageUrl(biz.logo_dark_url || '');
      applyBrandLogo(lightSigned, darkSigned);
      if (biz.ownerRole != null) setv('setting-owner-role', String(biz.ownerRole));
      if (biz.tagline != null) setv('setting-tagline', String(biz.tagline));
      var tagEl = gid('dash-brand-tagline');
      if (tagEl) {
        var tgs = biz.tagline != null ? String(biz.tagline).trim() : '';
        if (tgs) {
          tagEl.textContent = tgs;
          tagEl.style.display = 'block';
        } else {
          tagEl.textContent = '';
          tagEl.style.display = 'none';
        }
      }
    }
    if (raw.budgets && typeof raw.budgets === 'object') {
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        if (raw.budgets[k] == null) return;
        budgets[k] = Math.max(0, Number(raw.budgets[k]) || 0);
      });
      try {
        localStorage.setItem(
          storageKey(BUDGETS_KEY),
          JSON.stringify({
            lab: budgets.lab,
            sw: budgets.sw,
            ads: budgets.ads,
            oth: budgets.oth,
          })
        );
      } catch (_) {}
    }
    if (raw.budgetMonths && typeof raw.budgetMonths === 'object') {
      saveBudgetMonthSnapshotsToStorage(raw.budgetMonths);
    }
    if (raw.workspace && typeof raw.workspace === 'object') {
      applyWorkspacePrefsToDom(raw.workspace);
    }
    refreshSettingsBudgetInputsFromState();
    await hydrateWorkspaceSettingsFields();
  }

  function normalizeHexColor(hex, fallback) {
    var s = String(hex || '').trim();
    if (!s) return fallback;
    if (s[0] !== '#') s = '#' + s;
    var m3 = s.match(/^#([0-9a-fA-F]{3})$/);
    if (m3) {
      var h = m3[1];
      return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    var m6 = s.match(/^#([0-9a-fA-F]{6})$/);
    if (m6) return '#' + m6[1].toLowerCase();
    return fallback;
  }

  /** Valid #rgb / #rrggbb only; otherwise null (use when empty string must not fall back to a default). */
  function parseAccentHexOrNull(raw) {
    var n = normalizeHexColor(raw, '');
    return n && n.length === 7 ? n : null;
  }

  /** Sync Settings preset swatch selection to a normalized hex (exact match only). */
  function syncAccentPresetSwatches(hex) {
    var wrap = document.getElementById('setting-accent-presets');
    if (!wrap) return;
    var h = normalizeHexColor(hex, '#e8501a').toLowerCase();
    wrap.querySelectorAll('[data-accent-preset]').forEach(function (btn) {
      var ph = normalizeHexColor(btn.getAttribute('data-accent-preset') || '', '').toLowerCase();
      var on = Boolean(ph && ph === h);
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function hexToRgb(hex) {
    var n = normalizeHexColor(hex, '');
    if (!n || n.length !== 7) return null;
    return {
      r: parseInt(n.slice(1, 3), 16),
      g: parseInt(n.slice(3, 5), 16),
      b: parseInt(n.slice(5, 7), 16),
    };
  }

  function darkenHex(hex, factor) {
    var rgb = hexToRgb(hex);
    if (!rgb) return hex;
    var f = Math.max(0, Math.min(1, Number(factor) || 0));
    var r = Math.max(0, Math.min(255, Math.round(rgb.r * (1 - f))));
    var g = Math.max(0, Math.min(255, Math.round(rgb.g * (1 - f))));
    var b = Math.max(0, Math.min(255, Math.round(rgb.b * (1 - f))));
    return '#' + [r, g, b].map(function (v) { return v.toString(16).padStart(2, '0'); }).join('');
  }

  function applyBrandLogo(lightUrl, darkUrl) {
    var img = document.getElementById('sb-brand-img');
    if (!img) return;
    var light = String(lightUrl || '').trim();
    var dark = String(darkUrl || '').trim();
    var nextSrc = light || dark;
    if (nextSrc) img.src = nextSrc;
    if (light) img.setAttribute('data-logo-light', light);
    if (dark) img.setAttribute('data-logo-dark', dark);
  }

  window.bizdashApplyBrandLogoToShell = applyBrandLogo;

  /** Signed URL lifetime for private brand-assets bucket (see supabase/brand_assets_org_rls.sql). */
  var BRAND_LOGO_SIGNED_URL_TTL_SEC = 60 * 60 * 24 * 7;

  function brandAssetPathFromStoredUrl(url) {
    var s = String(url || '').trim();
    if (!s) return null;
    var markers = ['/storage/v1/object/public/brand-assets/', '/storage/v1/object/sign/brand-assets/'];
    for (var mi = 0; mi < markers.length; mi++) {
      var idx = s.indexOf(markers[mi]);
      if (idx === -1) continue;
      var rest = s.slice(idx + markers[mi].length);
      var qIdx = rest.indexOf('?');
      if (qIdx !== -1) rest = rest.slice(0, qIdx);
      try {
        return decodeURIComponent(rest);
      } catch (e) {
        return rest;
      }
    }
    return null;
  }

  async function resolveBrandLogoStorageUrl(url) {
    var raw = String(url || '').trim();
    if (!raw) return '';
    supabase = window.supabaseClient || supabase;
    if (!supabase) return raw;
    var path = brandAssetPathFromStoredUrl(raw);
    if (!path) return raw;
    try {
      var signed = await supabase.storage.from('brand-assets').createSignedUrl(path, BRAND_LOGO_SIGNED_URL_TTL_SEC);
      if (signed.error || !signed.data || !signed.data.signedUrl) return raw;
      return signed.data.signedUrl;
    } catch (err) {
      return raw;
    }
  }

  /** Re-skin live charts when branding changes (without waiting for a full rerender). */
  function syncBrandingAcrossCharts() {
    function expenseColorForLabel(label) {
      if (label === 'Labor') return CHART_EXPENSE_LABOR;
      if (label === 'Software') return CHART_EXPENSE_SOFTWARE;
      if (label === 'Advertising') return CHART_EXPENSE_ADVERTISING;
      if (label === 'Other') return CHART_EXPENSE_GRAY;
      return CHART_PALETTE_REST[0];
    }
    /** Full update (not 'none') so Chart.js reapplies dataset colors; rev/exp chart uses animation:false. */
    function chartUpdateBranding(ch) {
      if (!ch || typeof ch.update !== 'function') return;
      try {
        ch.update();
      } catch (e) {
        try {
          ch.update('none');
        } catch (_) {}
      }
    }
    if (revExpChart && revExpChart.data && revExpChart.data.datasets) {
      if (revExpChart.data.datasets[0]) syncBrandedRevenueBarDataset(revExpChart.data.datasets[0]);
      if (revExpChart.data.datasets[1]) syncMutedExpenseBarDataset(revExpChart.data.datasets[1]);
      chartUpdateBranding(revExpChart);
    }
    if (expenseChart && expenseChart.data && expenseChart.data.datasets && expenseChart.data.datasets[0]) {
      var expLabels = expenseChart.data.labels || [];
      if (expLabels.length === 1 && expLabels[0] === 'No expense data') {
        expenseChart.data.datasets[0].backgroundColor = [CHART_EMPTY];
      } else {
        expenseChart.data.datasets[0].backgroundColor = expLabels.map(expenseColorForLabel);
      }
      chartUpdateBranding(expenseChart);
    }
    if (revTrendChart && revTrendChart.data && revTrendChart.data.datasets && revTrendChart.data.datasets[0]) {
      syncBrandedRevenueLineDataset(revTrendChart.data.datasets[0]);
      chartUpdateBranding(revTrendChart);
    }
    if (insTrendChart && insTrendChart.data && insTrendChart.data.datasets && insTrendChart.data.datasets[0]) {
      syncBrandedRevenueLineDataset(insTrendChart.data.datasets[0]);
      chartUpdateBranding(insTrendChart);
    }
    if (retTrendChart && retTrendChart.data && retTrendChart.data.datasets && retTrendChart.data.datasets[0]) {
      syncBrandedRevenueLineDataset(retTrendChart.data.datasets[0]);
      chartUpdateBranding(retTrendChart);
    }
    if (projMonthlyChart && projMonthlyChart.data && projMonthlyChart.data.datasets && projMonthlyChart.data.datasets[0]) {
      projMonthlyChart.data.datasets[0].backgroundColor = CHART_ORANGE;
      chartUpdateBranding(projMonthlyChart);
    }
    if (verticalChart && verticalChart.data && verticalChart.data.datasets && verticalChart.data.datasets[0]) {
      var vLabels = verticalChart.data.labels || [];
      verticalChart.data.datasets[0].backgroundColor = vLabels.length && vLabels[0] !== 'No data' ? chartMultiColors(vLabels.length) : [CHART_EMPTY];
      chartUpdateBranding(verticalChart);
    }
    if (leadSourceChart && leadSourceChart.data && leadSourceChart.data.datasets && leadSourceChart.data.datasets[0]) {
      var lLabels = leadSourceChart.data.labels || [];
      leadSourceChart.data.datasets[0].backgroundColor = lLabels.length ? chartMultiColors(lLabels.length) : [CHART_EMPTY];
      chartUpdateBranding(leadSourceChart);
    }
  }

  function applyAccentBranding(accentHex) {
    var accent = normalizeHexColor(accentHex, '#e8501a');
    var rgb = hexToRgb(accent);
    if (!rgb) return;
    var root = document.documentElement;
    if (!root || !root.style) return;
    root.style.setProperty('--coral', accent);
    root.style.setProperty('--coral2', darkenHex(accent, 0.1));
    root.style.setProperty('--coral-bg', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.08)');
    root.style.setProperty('--coral-border-soft', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.14)');
    root.style.setProperty('--coral-border-mid', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.18)');
    root.style.setProperty('--coral-border-strong', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.2)');
    root.style.setProperty('--coral-border-focus', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.35)');

    // Chart "branding kit" derived from accent (revenue line, bars, doughnut slices, spend borders).
    CHART_ORANGE = accent;
    CHART_ORANGE_FILL = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.1)';
    CHART_ORANGE_FILL_BAR = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.32)';
    CHART_ORANGE_BORDER_BAR = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.45)';
    CHART_EXPENSE_LABOR = accent;
    CHART_EXPENSE_SOFTWARE = darkenHex(accent, 0.08);
    // Keep one non-accent category color for stronger visual separation in 2-slice doughnuts.
    CHART_EXPENSE_ADVERTISING = '#475569';
    CHART_VENDOR_PAL = [CHART_ORANGE, '#71717a', '#64748b', '#a1a1aa', '#94a3b8', '#78716c', '#d4d4d8', '#cbd5e1'];
    syncBrandingAcrossCharts();
  }

  async function persistAppSettingsToSupabase(opts) {
    opts = opts || {};
    var includeDashboard = opts.includeDashboard !== false;
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return;
    if (isDemoDashboardUser()) return;
    try {
      var dash = includeDashboard ? collectDashboardSettingsForCloud() : null;
      var existingSettings = null;
      try {
        existingSettings = await fetchAppSettingsFromSupabase();
        if (includeDashboard && existingSettings && existingSettings.dashboard_settings) {
          dash = mergeDashboardSettingsForPersist(existingSettings.dashboard_settings, dash);
        }
      } catch (_) {}
      if (!includeDashboard) {
        dash = existingSettings && existingSettings.dashboard_settings ? existingSettings.dashboard_settings : {};
      }
      if (dash && typeof dash === 'object' && Object.prototype.hasOwnProperty.call(dash, 'preferences')) {
        dash = Object.assign({}, dash);
        delete dash.preferences;
      }
      var orgRole = window.currentOrganizationRole || '';
      var canSetWorkspaceIcon = orgRole === 'owner' || orgRole === 'admin';
      if (
        includeDashboard &&
        dash &&
        dash.workspace &&
        !canSetWorkspaceIcon &&
        existingSettings &&
        existingSettings.dashboard_settings &&
        existingSettings.dashboard_settings.workspace &&
        typeof existingSettings.dashboard_settings.workspace === 'object'
      ) {
        var ew = existingSettings.dashboard_settings.workspace;
        dash = Object.assign({}, dash);
        dash.workspace = Object.assign({}, dash.workspace, {
          workspaceIconUrl: ew.workspaceIconUrl != null ? String(ew.workspaceIconUrl) : '',
          workspaceIconEmoji: ew.workspaceIconEmoji != null ? String(ew.workspaceIconEmoji) : '',
          workspaceIconIconify: ew.workspaceIconIconify != null ? String(ew.workspaceIconIconify) : '',
        });
      }
      var result = await supabase.from('app_settings').upsert(
        {
          organization_id: getCurrentOrgId(),
          project_statuses: projectStatuses,
          dashboard_settings: dash,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id' }
      );
      if (result.error) {
        console.error('upsert app_settings error', result.error);
        var errStr = JSON.stringify(result.error || {});
        if (/dashboard_settings|schema|column|42703/i.test(errStr)) {
          console.warn(
            'bizdash: add column dashboard_settings to app_settings — run supabase/add_app_settings_dashboard_settings.sql in the Supabase SQL editor.'
          );
        }
      }
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

  async function fetchTransactionsFromSupabase() {
    // If Supabase or user is not ready, fall back to local cache.
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) {
      return loadTransactions();
    }

    try {
      var result = await supabase
        .from('transactions')
        .select('*')
        .eq('organization_id', getCurrentOrgId())
        .order('date', { ascending: false });

      if (result.error) {
        console.error('load transactions error', result.error);
        return loadTransactions();
      }

      var rows = result.data || [];

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
    var metaRaw = row.metadata;
    var meta = typeof metaRaw === 'string'
      ? (function () {
        try {
          return JSON.parse(metaRaw);
        } catch (_) {
          return null;
        }
      })()
      : metaRaw;
    var base = {
      id: row.id,
      companyName: row.company_name || '',
      contactName: row.contact_name || '',
      status: st,
      industry: row.industry || '',
      email: row.email || '',
      phone: row.phone || '',
      notes: row.notes || '',
      birthday: row.birthday ? String(row.birthday).slice(0, 10) : '',
      communicationStyle: row.communication_style || '',
      preferredChannel: row.preferred_channel || '',
      lastTouchAt: row.last_touch_at ? String(row.last_touch_at).slice(0, 10) : '',
      nextFollowUpAt: row.next_follow_up_at ? String(row.next_follow_up_at).slice(0, 10) : '',
      relationshipNotes: row.relationship_notes || '',
      totalRevenue: Number(row.total_revenue || 0),
      createdAt: row.created_at || null,
      retainer: retainer,
      pipelineId: row.pipeline_id || null,
      pipelineStageId: row.pipeline_stage_id || null,
    };
    return applyClientMetadata(base, meta);
  }

  function mapCrmEventRow(row) {
    return {
      id: row.id,
      clientId: row.client_id || null,
      kind: row.kind || 'note',
      title: row.title || '',
      details: row.details && typeof row.details === 'object' ? row.details : {},
      eventAt: row.event_at || row.created_at || new Date().toISOString(),
    };
  }

  async function fetchCrmEventsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || crmEventsTableUnavailable) return [];
    try {
      var res = await supabase.from('crm_events').select('*').eq('organization_id', getCurrentOrgId()).order('event_at', { ascending: false }).limit(50);
      if (res.error) {
        if (res.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(res.error.message || ''))) {
          crmEventsTableUnavailable = true;
        }
        return [];
      }
      return (res.data || []).map(mapCrmEventRow);
    } catch (_) {
      return [];
    }
  }

  async function fetchWeeklySummariesFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || weeklySummariesTableUnavailable) return [];
    try {
      var res = await supabase.from('weekly_summaries').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: false }).limit(12);
      if (res.error) {
        if (res.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(res.error.message || ''))) {
          weeklySummariesTableUnavailable = true;
        }
        return [];
      }
      return res.data || [];
    } catch (_) {
      return [];
    }
  }

  async function addCrmEvent(kind, title, details, clientId, idempotencyKey) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) return;
    var payloadDetails = details && typeof details === 'object' ? Object.assign({}, details) : {};
    if (idempotencyKey) {
      var exists = crmEvents.some(function (ev) { return ev && ev.details && ev.details.idempotencyKey === idempotencyKey; });
      if (exists) return;
      payloadDetails.idempotencyKey = idempotencyKey;
    }
    var payload = {
      id: uuid(),
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      client_id: clientId || null,
      kind: kind || 'note',
      title: title || 'Activity',
      details: payloadDetails,
      event_at: new Date().toISOString(),
    };
    try {
      var res = await supabase.from('crm_events').insert(payload);
      if (!res.error) crmEvents.unshift(mapCrmEventRow(payload));
      else if (res.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(res.error.message || ''))) crmEventsTableUnavailable = true;
    } catch (_) {}
  }

  // ---------- Workflow automation (schema v1; see supabase/workflow_automation.sql) ----------
  // trigger: { v:1, type: 'client.stage_entered'|'client.status_changed'|'activity.created'|'campaign.status_changed', ... }
  // actions: [{ type: 'set_client_stage'|'set_client_field'|'create_task'|'add_crm_event'|'notify_external', ... }]
  var wfPipelines = [];
  var wfStages = [];
  var wfRules = [];
  var wfTasks = [];
  /** Cached workspace members for Tasks tab assignee picker (from organization-team list). */
  var tasksTabMembers = [];
  var wfSchemaUnavailable = false;
  var crmEventsTableUnavailable = false;
  var weeklySummariesTableUnavailable = false;
  var wfDispatchDepth = 0;
  var WF_MAX_ACTIONS = 8;
  var WF_TRIGGER_TYPES = {
    CLIENT_STAGE_ENTERED: 'client.stage_entered',
    CLIENT_STATUS_CHANGED: 'client.status_changed',
    ACTIVITY_CREATED: 'activity.created',
    CAMPAIGN_STATUS_CHANGED: 'campaign.status_changed',
  };

  function wfStageSlugById(stageId) {
    if (!stageId) return '';
    var s = wfStages.find(function (x) { return x.id === stageId; });
    return s ? String(s.slug || '') : '';
  }

  function wfDefaultClientPipelineId() {
    var def = wfPipelines.find(function (p) { return p.entity === 'client' && p.is_default; });
    if (def) return def.id;
    var any = wfPipelines.find(function (p) { return p.entity === 'client'; });
    return any ? any.id : null;
  }

  function wfStagesForPipeline(pid) {
    if (!pid) return [];
    return wfStages.filter(function (s) { return s.pipelineId === pid; }).sort(function (a, b) {
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  }

  function wfFillClientPipelineSelect(selEl, client) {
    if (!selEl) return;
    function escOpt(t) {
      return String(t || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
    }
    var pid = (client && client.pipelineId) || wfDefaultClientPipelineId();
    var stages = wfStagesForPipeline(pid);
    selEl.innerHTML = '<option value="">— None —</option>' +
      stages.map(function (s) {
        return '<option value="' + String(s.id).replace(/"/g, '&quot;') + '">' + escOpt(s.label) + '</option>';
      }).join('');
    if (client && client.pipelineStageId) selEl.value = client.pipelineStageId;
    else selEl.value = '';
  }

  function mapWorkspaceTaskRow(row) {
    return {
      id: row.id,
      title: row.title || '',
      body: row.body || '',
      status: row.status || 'open',
      dueAt: row.due_at || null,
      clientId: row.client_id || null,
      campaignId: row.campaign_id || null,
      createdBy: row.created_by || 'user',
      workflowRunId: row.workflow_run_id || null,
      userId: row.user_id || row.userId || null,
      assignedToEmail: row.assigned_to_email || row.assignedToEmail || null,
      organizationId: row.organization_id || row.organizationId || null,
    };
  }

  async function wfRefreshFromSupabase() {
    wfPipelines = [];
    wfStages = [];
    wfRules = [];
    wfTasks = [];
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || isDemoDashboardUser() || wfSchemaUnavailable) return;
    try {
      var pr = await supabase.from('pipelines').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: true });
      if (pr && pr.error && (pr.error.status === 404 || /could not find the table|relation .* does not exist/i.test(String(pr.error.message || '')))) {
        wfSchemaUnavailable = true;
        return;
      }
      wfPipelines = pr.error ? [] : (pr.data || []).map(function (r) {
        return { id: r.id, name: r.name, entity: r.entity, isDefault: !!r.is_default };
      });
      var sr = await supabase.from('pipeline_stages').select('*').eq('organization_id', getCurrentOrgId()).order('sort_order', { ascending: true });
      wfStages = sr.error ? [] : (sr.data || []).map(function (r) {
        return { id: r.id, pipelineId: r.pipeline_id, label: r.label, slug: r.slug, sortOrder: r.sort_order || 0, color: r.color || '' };
      });
      var rr = await supabase.from('workflow_rules').select('*').eq('organization_id', getCurrentOrgId()).order('created_at', { ascending: true });
      wfRules = rr.error ? [] : (rr.data || []).map(function (r) {
        return {
          id: r.id,
          name: r.name,
          enabled: r.enabled !== false,
          pipelineId: r.pipeline_id || null,
          trigger: typeof r.trigger === 'object' && r.trigger ? r.trigger : {},
          actions: Array.isArray(r.actions) ? r.actions : [],
        };
      });
      var tr = await supabase.from('workspace_tasks').select('*').eq('organization_id', getCurrentOrgId()).order('due_at', { ascending: true }).limit(200);
      wfTasks = tr.error ? [] : (tr.data || []).map(mapWorkspaceTaskRow);
    } catch (e) {
      console.warn('wfRefreshFromSupabase', e);
    }
  }

  function wfValidateRule(rule) {
    var errs = [];
    if (!rule || typeof rule !== 'object') return { ok: false, errors: ['invalid rule'] };
    var tr = rule.trigger || {};
    if (tr.v !== 1) errs.push('trigger.v must be 1');
    var tt = tr.type;
    var okT = [
      WF_TRIGGER_TYPES.CLIENT_STAGE_ENTERED,
      WF_TRIGGER_TYPES.CLIENT_STATUS_CHANGED,
      WF_TRIGGER_TYPES.ACTIVITY_CREATED,
      WF_TRIGGER_TYPES.CAMPAIGN_STATUS_CHANGED,
    ];
    if (!tt || okT.indexOf(tt) === -1) errs.push('trigger.type must be a supported v1 type');
    var acts = rule.actions;
    if (!Array.isArray(acts)) errs.push('actions must be an array');
    else if (acts.length > WF_MAX_ACTIONS) errs.push('at most ' + WF_MAX_ACTIONS + ' actions');
    else {
      var okActs = {
        set_client_stage: 1,
        set_client_field: 1,
        create_task: 1,
        add_crm_event: 1,
        notify_external: 1,
      };
      acts.forEach(function (a, i) {
        if (!a || typeof a !== 'object' || !a.type) errs.push('action ' + i + ' needs type');
        else if (!okActs[a.type]) errs.push('action ' + i + ' unknown type ' + a.type);
      });
    }
    return { ok: !errs.length, errors: errs };
  }

  function wfMatchTrigger(rule, evt) {
    var t = rule.trigger || {};
    if (t.v !== 1) return false;
    if (evt.kind === 'client_updated' && t.type === WF_TRIGGER_TYPES.CLIENT_STAGE_ENTERED) {
      if (!evt.after) return false;
      var prev = evt.before ? evt.before.pipelineStageId : null;
      var next = evt.after.pipelineStageId || null;
      if (prev === next) return false;
      if (t.stage_slug && wfStageSlugById(next) !== t.stage_slug) return false;
      if (t.from_slug && wfStageSlugById(prev) !== t.from_slug) return false;
      if (rule.pipelineId && evt.after.pipelineId && rule.pipelineId !== evt.after.pipelineId) return false;
      return true;
    }
    if (evt.kind === 'client_updated' && t.type === WF_TRIGGER_TYPES.CLIENT_STATUS_CHANGED) {
      if (!evt.after) return false;
      var bs = (evt.before && evt.before.status) || '';
      var as = evt.after.status || '';
      if (bs === as) return false;
      if (t.status_contains && as.toLowerCase().indexOf(String(t.status_contains).toLowerCase()) === -1) return false;
      return true;
    }
    if (evt.kind === 'activity_created' && t.type === WF_TRIGGER_TYPES.ACTIVITY_CREATED) {
      if (!evt.activity) return false;
      if (t.activity_type && evt.activity.activity_type !== t.activity_type) return false;
      return true;
    }
    if (evt.kind === 'campaign_updated' && t.type === WF_TRIGGER_TYPES.CAMPAIGN_STATUS_CHANGED) {
      if (!evt.after) return false;
      var bs2 = evt.before && evt.before.status;
      var as2 = evt.after.status;
      if (bs2 === as2) return false;
      if (t.status && evt.after.status !== t.status) return false;
      return true;
    }
    return false;
  }

  function wfIdempotencyKey(rule, evt) {
    var day = new Date().toISOString().slice(0, 10);
    if (evt.kind === 'client_updated') {
      return rule.id + ':client:' + (evt.after && evt.after.id) + ':' + String(evt.after && evt.after.pipelineStageId || '') + ':' + day;
    }
    if (evt.kind === 'activity_created' && evt.activity && evt.activity.id) {
      return rule.id + ':activity:' + evt.activity.id;
    }
    if (evt.kind === 'campaign_updated') {
      return rule.id + ':campaign:' + (evt.after && evt.after.id) + ':' + String(evt.after && evt.after.status || '') + ':' + day;
    }
    return rule.id + ':misc:' + day + ':' + String(Math.random()).slice(2, 10);
  }

  function wfCloneClientForWorkflow(c) {
    if (!c) return null;
    try {
      return JSON.parse(JSON.stringify(c));
    } catch (_) {
      return null;
    }
  }

  function wfCloneCampaign(c) {
    if (!c) return null;
    try {
      return JSON.parse(JSON.stringify(c));
    } catch (_) {
      return null;
    }
  }

  async function wfTryInsertWorkflowRun(ruleId, idempotencyKey, triggerPayload) {
    var rid = uuid();
    var row = {
      id: rid,
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      rule_id: ruleId,
      idempotency_key: idempotencyKey,
      trigger_payload: triggerPayload,
      status: 'running',
    };
    try {
      var res = await supabase.from('workflow_runs').insert(row);
      if (res.error) {
        var es = JSON.stringify(res.error || {});
        if (/duplicate|23505|unique/i.test(es)) return null;
        console.error('workflow_runs insert', res.error);
        return null;
      }
      return rid;
    } catch (e) {
      console.error('workflow_runs insert', e);
      return null;
    }
  }

  async function wfUpdateWorkflowRun(runId, status, errMsg) {
    if (!runId) return;
    try {
      await supabase.from('workflow_runs').update({ status: status, error: errMsg || null }).eq('id', runId).eq('organization_id', getCurrentOrgId());
    } catch (_) {}
  }

  async function wfInsertOutboxStub(channel, payload) {
    try {
      await supabase.from('workflow_outbox').insert({
        id: uuid(),
        user_id: currentUser.id,
        organization_id: getCurrentOrgId(),
        channel: channel || 'stub',
        payload: payload || {},
      });
    } catch (_) {}
  }

  function wfFindStageBySlug(pipelineId, slug) {
    return wfStages.find(function (s) {
      return s.pipelineId === pipelineId && s.slug === slug;
    });
  }

  async function wfExecuteActions(rule, evt, runId) {
    var acts = Array.isArray(rule.actions) ? rule.actions : [];
    var err = '';
    try {
      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        if (!a || !a.type) continue;
        if (a.type === 'set_client_stage') {
          var client = evt.kind === 'client_updated' && evt.after ? evt.after : evt.client;
          if (!client || !client.id) continue;
          var pid = rule.pipelineId || client.pipelineId || wfDefaultClientPipelineId();
          if (!pid || !a.stage_slug) continue;
          var st = wfFindStageBySlug(pid, a.stage_slug);
          if (!st) continue;
          clients = clients.map(function (c) {
            if (c.id !== client.id) return c;
            var n = Object.assign({}, c, { pipelineId: pid, pipelineStageId: st.id, status: st.label });
            return n;
          });
          var updated = clients.find(function (c) { return c.id === client.id; });
          saveClients(clients);
          if (updated) await persistClientToSupabase(updated, 'update');
        } else if (a.type === 'set_client_field') {
          var fld = String(a.field || '').trim();
          var allowed = { status: 1, notes: 1, nextFollowUpAt: 1 };
          if (!allowed[fld]) continue;
          var cid = (evt.after && evt.after.id) || (evt.client && evt.client.id);
          if (!cid) continue;
          var val = a.value != null ? String(a.value) : '';
          clients = clients.map(function (c) {
            if (c.id !== cid) return c;
            var n = Object.assign({}, c);
            if (fld === 'notes' && a.append) {
              n.notes = (n.notes || '') + (n.notes ? '\n' : '') + val;
            } else {
              n[fld] = val;
            }
            return n;
          });
          var u2 = clients.find(function (c) { return c.id === cid; });
          saveClients(clients);
          if (u2) await persistClientToSupabase(u2, 'update');
        } else if (a.type === 'create_task') {
          var title = String(a.title || 'Follow up').slice(0, 500);
          var dueDays = Math.max(0, Math.min(365, parseInt(a.due_days, 10) || 0));
          var due = new Date();
          due.setDate(due.getDate() + dueDays);
          var cliId = (evt.after && evt.after.id) || (evt.client && evt.client.id) || null;
          var taskRow = {
            id: uuid(),
            user_id: currentUser.id,
            organization_id: getCurrentOrgId(),
            title: title,
            body: String(a.body || ''),
            status: 'open',
            due_at: due.toISOString(),
            client_id: cliId,
            campaign_id: evt.after && evt.kind === 'campaign_updated' ? evt.after.id : null,
            created_by: 'workflow',
            workflow_run_id: runId,
          };
          var ins = await supabase.from('workspace_tasks').insert(taskRow);
          if (!ins.error) wfTasks.push(mapWorkspaceTaskRow(taskRow));
        } else if (a.type === 'add_crm_event') {
          var k = String(a.kind || 'workflow').slice(0, 40);
          var ttl = String(a.title || rule.name || 'Workflow').slice(0, 200);
          await addCrmEvent(k, ttl, { ruleId: rule.id, runId: runId }, evt.after && evt.after.id || evt.client && evt.client.id || null, 'wf:' + runId + ':' + i);
        } else if (a.type === 'notify_external') {
          await wfInsertOutboxStub(a.channel || 'stub', { ruleId: rule.id, runId: runId, message: a.message || '' });
          await addCrmEvent('workflow', 'External notify (stub): ' + String(a.message || 'queued').slice(0, 120), { channel: a.channel }, evt.after && evt.after.id || null, 'wf-out:' + runId + ':' + i);
        }
      }
      await wfUpdateWorkflowRun(runId, 'success', null);
    } catch (e) {
      err = String(e && e.message ? e.message : e);
      await wfUpdateWorkflowRun(runId, 'error', err);
    }
  }

  async function runWorkflowDispatch(evt) {
    if (!evt || !evt.kind) return;
    if (wfDispatchDepth > 0) return;
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId() || isDemoDashboardUser()) return;
    await wfRefreshFromSupabase();
    if (!wfRules.length) return;
    wfDispatchDepth++;
    try {
      for (var ri = 0; ri < wfRules.length; ri++) {
        var rule = wfRules[ri];
        if (!rule || !rule.enabled) continue;
        var v = wfValidateRule(rule);
        if (!v.ok) continue;
        if (!wfMatchTrigger(rule, evt)) continue;
        var idem = wfIdempotencyKey(rule, evt);
        var runId = await wfTryInsertWorkflowRun(rule.id, idem, evt);
        if (!runId) continue;
        await wfExecuteActions(rule, evt, runId);
      }
    } finally {
      wfDispatchDepth--;
    }
  }

  async function wfCreateDefaultClientPipeline() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return { ok: false, error: 'Sign in required' };
    await wfRefreshFromSupabase();
    if (wfPipelines.some(function (p) { return p.entity === 'client'; })) {
      return { ok: false, error: 'You already have a client pipeline. Delete stages in Supabase or reuse it.' };
    }
    var pid = uuid();
    var insP = await supabase.from('pipelines').insert({
      id: pid,
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      name: 'Sales',
      entity: 'client',
      is_default: true,
    });
    if (insP.error) return { ok: false, error: formatSupabaseErr(insP.error) };
    var stages = [
      { label: 'Lead', slug: 'lead', sort: 0 },
      { label: 'Qualified', slug: 'qualified', sort: 1 },
      { label: 'Customer', slug: 'customer', sort: 2 },
    ];
    for (var i = 0; i < stages.length; i++) {
      var st = stages[i];
      await supabase.from('pipeline_stages').insert({
        id: uuid(),
        pipeline_id: pid,
        user_id: currentUser.id,
        organization_id: getCurrentOrgId(),
        label: st.label,
        slug: st.slug,
        sort_order: st.sort,
      });
    }
    await wfRefreshFromSupabase();
    return { ok: true };
  }

  async function wfInsertActivity(clientId, activityType, notes, occurredAt) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !clientId || !getCurrentOrgId()) return null;
    var row = {
      id: uuid(),
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      client_id: clientId,
      activity_type: activityType || 'meeting',
      notes: notes || '',
      occurred_at: occurredAt || new Date().toISOString(),
    };
    try {
      var res = await supabase.from('crm_activities').insert(row).select('id');
      if (res.error || !res.data || !res.data.length) {
        if (res.error) console.error('crm_activities insert', res.error);
        return null;
      }
      return Object.assign({}, row, { id: res.data[0].id, activity_type: row.activity_type });
    } catch (e) {
      console.error('crm_activities insert', e);
      return null;
    }
  }

  async function wfUpsertRuleToSupabase(rule) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) return { ok: false, error: 'Sign in required' };
    var v = wfValidateRule(rule);
    if (!v.ok) return { ok: false, error: v.errors.join('; ') };
    var row = {
      id: rule.id || uuid(),
      user_id: currentUser.id,
      organization_id: getCurrentOrgId(),
      name: rule.name || 'Rule',
      enabled: rule.enabled !== false,
      pipeline_id: rule.pipelineId || null,
      trigger: rule.trigger,
      actions: rule.actions,
      updated_at: new Date().toISOString(),
    };
    try {
      var res = await supabase.from('workflow_rules').upsert(row, { onConflict: 'id' });
      if (res.error) return { ok: false, error: formatSupabaseErr(res.error) };
      await wfRefreshFromSupabase();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  async function wfDeleteRuleById(ruleId) {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !ruleId) return;
    try {
      await supabase.from('workflow_rules').delete().eq('id', ruleId).eq('organization_id', getCurrentOrgId());
      await wfRefreshFromSupabase();
    } catch (_) {}
  }

  async function wfSeedExampleMeetingRule() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      alert('Sign in to create automation rules.');
      return;
    }
    await wfRefreshFromSupabase();
    var pid = wfDefaultClientPipelineId();
    if (!pid) {
      alert('Create a default client pipeline first (button above).');
      return;
    }
    if (!wfFindStageBySlug(pid, 'qualified')) {
      alert('Default pipeline must include a stage with slug \"qualified\" (included in the default template).');
      return;
    }
    var r = {
      id: uuid(),
      name: 'Meeting logged → Qualified + follow-up task',
      enabled: true,
      pipelineId: pid,
      trigger: { v: 1, type: WF_TRIGGER_TYPES.ACTIVITY_CREATED, activity_type: 'meeting' },
      actions: [
        { type: 'set_client_stage', stage_slug: 'qualified' },
        { type: 'create_task', title: 'Follow up after meeting', due_days: 2, body: 'Created by workflow automation' },
        { type: 'add_crm_event', kind: 'workflow', title: 'Post-meeting automation ran' },
      ],
    };
    var out = await wfUpsertRuleToSupabase(r);
    if (!out.ok) alert(out.error || 'Could not save rule');
    else renderAutomationSettings();
  }

  function renderAutomationSettings() {
    var host = $('wf-automation-dynamic');
    if (!host) return;
    var pline = wfPipelines.filter(function (p) { return p.entity === 'client'; }).map(function (p) {
      return '<li style="margin:4px 0;">' + esc(p.name) + ' · ' + wfStages.filter(function (s) { return s.pipelineId === p.id; }).length + ' stages</li>';
    }).join('');
    var rules = wfRules.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:10px;">' +
        '<div style="min-width:0;"><div style="font-weight:600;font-size:13px;">' + esc(r.name) + '</div>' +
        '<div style="font-size:11px;color:var(--text3);">' + (r.enabled ? 'On' : 'Off') + ' · ' + esc((r.trigger && r.trigger.type) || '') + '</div></div>' +
        '<button type="button" class="btn" data-wf-del-rule="' + esc(r.id) + '" style="color:var(--red);">Delete</button></div>';
    }).join('');
    host.innerHTML =
      '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Client pipelines</div>' +
      (pline ? '<ul style="margin:0 0 14px 18px;padding:0;">' + pline + '</ul>' : '<p style="font-size:12px;color:var(--text3);">No client pipeline yet.</p>') +
      '<div style="font-size:12px;color:var(--text2);margin-bottom:8px;">Rules (' + wfRules.length + ')</div>' +
      (rules || '<p style="font-size:12px;color:var(--text3);">No rules yet.</p>');
  }

  function tasksTabStartOfLocalDay(d) {
    var x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  }

  function tasksTabDueMeta(task) {
    var st = task.status || 'open';
    if (!task.dueAt) {
      return { key: 'nodue', label: '—', cls: 'tasks-due-muted', sort: 4 };
    }
    var due = new Date(task.dueAt);
    if (isNaN(due.getTime())) {
      return { key: 'nodue', label: '—', cls: 'tasks-due-muted', sort: 4 };
    }
    var startToday = tasksTabStartOfLocalDay(new Date());
    var endToday = startToday + 86400000;
    var tDue = tasksTabStartOfLocalDay(due);
    if (tDue < startToday && st === 'open') {
      return { key: 'overdue', label: 'Overdue', cls: 'tasks-due-overdue', sort: 0 };
    }
    if (tDue >= startToday && tDue < endToday) {
      return { key: 'today', label: st === 'done' ? 'Today' : 'Due today', cls: 'tasks-due-today', sort: 1 };
    }
    if (tDue >= endToday) {
      return {
        key: 'upcoming',
        label: due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
        cls: 'tasks-due-muted',
        sort: 2,
      };
    }
    return { key: 'earlier', label: fmtDateDisplay(task.dueAt), cls: 'tasks-due-muted', sort: 3 };
  }

  function tasksTabAssigneeDisplay(task) {
    var email = '';
    var m = tasksTabMembers.find(function (x) { return x.user_id === task.userId; });
    if (m && m.email) email = String(m.email);
    if (!email && task.assignedToEmail) email = String(task.assignedToEmail);
    if (!email && task.userId && window.currentUser && task.userId === window.currentUser.id) {
      email = (window.currentUser.email || 'You').trim();
    }
    if (!email) email = task.userId ? String(task.userId).slice(0, 8) + '…' : '—';
    var parts = email.split('@')[0].split(/[.\s_]+/).filter(Boolean);
    var ini =
      parts.length >= 2
        ? (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase()
        : (email.charAt(0) || '?').toUpperCase();
    return { email: email, initials: ini.slice(0, 2) };
  }

  async function tasksTabBearerForEdge(supabase) {
    try {
      var ref = await supabase.auth.refreshSession();
      if (ref && ref.error) return null;
      var s = ref && ref.data && ref.data.session;
      if (s && s.access_token) return s.access_token;
      var g = await supabase.auth.getSession();
      s = g && g.data && g.data.session;
      return s && s.access_token ? s.access_token : null;
    } catch (_) {
      return null;
    }
  }

  async function tasksTabInvokeOrganizationTeamRaw(supabase, orgId, body, accessToken) {
    var base = (
      (supabase && supabase.supabaseUrl ? String(supabase.supabaseUrl) : '') ||
      (typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl : '')
    ).replace(/\/$/, '');
    var anon =
      (supabase && supabase.supabaseKey ? String(supabase.supabaseKey) : '') ||
      (typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey : '');
    if (!base || !anon) return { ok: false, status: 0, data: null };
    var url = base + '/functions/v1/organization-team';
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + accessToken,
        apikey: anon,
      },
      body: JSON.stringify(Object.assign({ organizationId: orgId }, body)),
    });
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = { error: text || 'Invalid JSON' };
    }
    return { ok: res.ok, status: res.status, data: data };
  }

  async function tasksTabRefreshMembers() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    var orgId = typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
    tasksTabMembers = [];
    if (!supabase || !currentUser || !orgId || isDemoDashboardUser()) return;
    try {
      var token = await tasksTabBearerForEdge(supabase);
      if (!token) return;
      var raw = await tasksTabInvokeOrganizationTeamRaw(supabase, orgId, { action: 'list' }, token);
      if (!raw.ok && raw.status === 401) {
        token = await tasksTabBearerForEdge(supabase);
        if (token) raw = await tasksTabInvokeOrganizationTeamRaw(supabase, orgId, { action: 'list' }, token);
      }
      if (raw.ok && raw.data && Array.isArray(raw.data.members)) {
        tasksTabMembers = raw.data.members;
      }
    } catch (e) {
      console.warn('tasksTabRefreshMembers', e);
    }
  }

  function tasksTabFillAssigneeSelect(sel) {
    if (!sel) return;
    var uid = window.currentUser && window.currentUser.id ? window.currentUser.id : '';
    var opts = [];
    if (tasksTabMembers.length) {
      tasksTabMembers.forEach(function (m) {
        var em = (m.email || m.user_id || '').trim();
        if (!em) return;
        opts.push({
          id: m.user_id,
          label: em,
          selected: uid && m.user_id === uid,
        });
      });
    } else if (uid) {
      opts.push({ id: uid, label: (window.currentUser.email || 'Me').trim(), selected: true });
    }
    if (!opts.length) {
      sel.innerHTML = '<option value="">No teammates loaded</option>';
      return;
    }
    sel.innerHTML = opts
      .map(function (o) {
        return (
          '<option value="' +
          esc(o.id) +
          '"' +
          (o.selected ? ' selected' : '') +
          '>' +
          esc(o.label) +
          '</option>'
        );
      })
      .join('');
  }

  function tasksTabFillClientSelect(sel) {
    if (!sel) return;
    var cur = sel.value;
    var rows = '<option value="">— None —</option>' +
      (clients || [])
        .filter(function (c) { return c && c.id; })
        .map(function (c) {
          return '<option value="' + esc(c.id) + '">' + esc(c.companyName || c.contactName || 'Client') + '</option>';
        })
        .join('');
    sel.innerHTML = rows;
    if (cur) {
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === cur) {
          sel.value = cur;
          break;
        }
      }
    }
  }

  function renderTasksPage() {
    var page = document.getElementById('page-tasks');
    var empty = document.getElementById('tasks-tab-empty');
    var main = document.getElementById('tasks-tab-main');
    var demoHint = document.getElementById('tasks-tab-demo');
    if (!page || !empty || !main) return;

    var demo = isDemoDashboardUser();
    if (demoHint) {
      demoHint.style.display = demo ? 'block' : 'none';
      demoHint.textContent = demo
        ? 'Preview mode: sign in to create and assign tasks that sync to your workspace.'
        : '';
    }

    var filterEl = document.getElementById('tasks-filter');
    var filter = filterEl && filterEl.value ? filterEl.value : 'open';

    var list = (wfTasks || []).slice();
    if (filter === 'open') list = list.filter(function (t) { return (t.status || 'open') === 'open'; });
    else if (filter === 'done') list = list.filter(function (t) { return t.status === 'done'; });

    list.sort(function (a, b) {
      var ma = tasksTabDueMeta(a);
      var mb = tasksTabDueMeta(b);
      if (ma.sort !== mb.sort) return ma.sort - mb.sort;
      var da = a.dueAt ? new Date(a.dueAt).getTime() : 9e15;
      var db = b.dueAt ? new Date(b.dueAt).getTime() : 9e15;
      if (da !== db) return da - db;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

    if (!list.length) {
      empty.classList.add('on');
      main.classList.remove('on');
      main.innerHTML = '';
      return;
    }

    empty.classList.remove('on');
    main.classList.add('on');

    var groups = ['overdue', 'today', 'upcoming', 'nodue', 'donegroup'];
    var groupLabels = {
      overdue: 'Overdue',
      today: 'Today',
      upcoming: 'Upcoming',
      nodue: 'No due date',
      donegroup: 'Done',
    };
    var byGroup = {};
    groups.forEach(function (g) {
      byGroup[g] = [];
    });
    list.forEach(function (t) {
      var meta = tasksTabDueMeta(t);
      var gkey = meta.key;
      if (filter === 'done' || t.status === 'done') {
        byGroup.donegroup.push(t);
      } else if (gkey === 'overdue') byGroup.overdue.push(t);
      else if (gkey === 'today') byGroup.today.push(t);
      else if (gkey === 'upcoming') byGroup.upcoming.push(t);
      else byGroup.nodue.push(t);
    });

    function rowHtml(t) {
      var cl = t.clientId ? (clients.find(function (c) { return c.id === t.clientId; }) || {}) : {};
      var cn = cl.companyName || cl.contactName || '—';
      var meta = tasksTabDueMeta(t);
      var ad = tasksTabAssigneeDisplay(t);
      var done = t.status === 'done';
      return (
        '<tr data-task-id="' +
        esc(t.id) +
        '">' +
        '<td class="tasks-col-task"><div class="tasks-row-title">' +
        '<input type="checkbox" data-task-toggle="' +
        esc(t.id) +
        '" ' +
        (done ? 'checked' : '') +
        (demo ? ' disabled' : '') +
        ' title="Mark done" />' +
        '<span' +
        (done ? ' style="text-decoration:line-through;color:var(--text3);"' : '') +
        '>' +
        esc(t.title || '') +
        '</span></div></td>' +
        '<td><span class="' +
        esc(meta.cls) +
        '">' +
        esc(meta.label) +
        '</span></td>' +
        '<td style="font-size:13px;color:var(--text2);">' +
        esc(cn) +
        '</td>' +
        '<td><span class="tasks-assignee"><span class="tasks-assignee-av">' +
        esc(ad.initials) +
        '</span><span class="tasks-assignee-em">' +
        esc(ad.email) +
        '</span></span></td>' +
        '<td style="text-align:right;width:48px;">' +
        (demo
          ? ''
          : '<button type="button" class="tasks-row-menu" data-task-menu="' +
            esc(t.id) +
            '" title="Delete">⋯</button>') +
        '</td></tr>'
      );
    }

    var html = '';
    groups.forEach(function (gk) {
      var rows = byGroup[gk];
      if (!rows.length) return;
      html +=
        '<div class="tasks-group-hdr">' +
        esc(groupLabels[gk] || gk) +
        ' <span class="tasks-group-count">' +
        String(rows.length) +
        '</span></div>' +
        '<table class="tasks-table"><thead><tr>' +
        '<th>Task</th><th>Due date</th><th>Record</th><th>Assigned to</th><th></th>' +
        '</tr></thead><tbody>' +
        rows.map(rowHtml).join('') +
        '</tbody></table>';
    });

    main.innerHTML = html || '<p style="font-size:13px;color:var(--text3);padding:12px;">No tasks match this filter.</p>';
    if (html) {
      stagePageMotion(main);
    }
  }

  function wireTasksTab() {
    var root = document.getElementById('page-tasks');
    if (!root || root.getAttribute('data-tasks-wired') === '1') return;
    root.setAttribute('data-tasks-wired', '1');

    var main = document.getElementById('tasks-tab-main');
    var overlay = document.getElementById('tasks-modal-overlay');
    var help = document.getElementById('tasks-link-help');
    var ask = document.getElementById('tasks-link-ask');
    if (help) {
      help.addEventListener('click', function (e) {
        e.preventDefault();
        if (typeof window.nav === 'function') window.nav('chat');
      });
    }
    if (ask) {
      ask.addEventListener('click', function (e) {
        e.preventDefault();
        if (typeof window.nav === 'function') window.nav('chat');
      });
    }

    function openModal() {
      var titleIn = document.getElementById('tasks-modal-title');
      var dueIn = document.getElementById('tasks-modal-due');
      var asg = document.getElementById('tasks-modal-assignee');
      var err = document.getElementById('tasks-modal-error');
      if (err) {
        err.style.display = 'none';
        err.textContent = '';
      }
      if (titleIn) titleIn.value = '';
      if (dueIn) dueIn.value = '';
      tasksTabFillClientSelect(document.getElementById('tasks-modal-client'));
      tasksTabRefreshMembers().then(function () {
        tasksTabFillAssigneeSelect(asg);
      });
      if (overlay) {
        overlay.classList.add('on');
        overlay.setAttribute('aria-hidden', 'false');
      }
    }

    function closeModal() {
      if (overlay) {
        overlay.classList.remove('on');
        overlay.setAttribute('aria-hidden', 'true');
      }
    }

    var btnNew = document.getElementById('btn-tasks-new');
    var btnNewE = document.getElementById('btn-tasks-new-empty');
    if (btnNew) btnNew.addEventListener('click', function () { openModal(); });
    if (btnNewE) btnNewE.addEventListener('click', function () { openModal(); });

    var cancel = document.getElementById('tasks-modal-cancel');
    if (cancel) cancel.addEventListener('click', closeModal);
    if (overlay) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeModal();
      });
    }

    var save = document.getElementById('tasks-modal-save');
    if (save) {
      save.addEventListener('click', async function () {
        var errEl = document.getElementById('tasks-modal-error');
        var titleIn = document.getElementById('tasks-modal-title');
        var dueIn = document.getElementById('tasks-modal-due');
        var asg = document.getElementById('tasks-modal-assignee');
        var cli = document.getElementById('tasks-modal-client');
        if (errEl) {
          errEl.style.display = 'none';
          errEl.textContent = '';
        }
        if (isDemoDashboardUser()) {
          if (errEl) {
            errEl.textContent = 'Sign in to create tasks.';
            errEl.style.display = 'block';
          }
          return;
        }
        supabase = window.supabaseClient || supabase;
        currentUser = window.currentUser || currentUser;
        var orgId = typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
        var title = titleIn && titleIn.value ? String(titleIn.value).trim() : '';
        if (!title) {
          if (errEl) {
            errEl.textContent = 'Title is required.';
            errEl.style.display = 'block';
          }
          return;
        }
        var assigneeId = asg && asg.value ? String(asg.value).trim() : '';
        if (!assigneeId) {
          if (errEl) {
            errEl.textContent = 'Choose an assignee.';
            errEl.style.display = 'block';
          }
          return;
        }
        var assigneeEmail = '';
        if (asg && asg.selectedOptions && asg.selectedOptions[0]) {
          assigneeEmail = String(asg.selectedOptions[0].textContent || '').trim();
        }
        var dueAt = null;
        if (dueIn && dueIn.value) {
          var d = new Date(dueIn.value + 'T12:00:00');
          dueAt = isNaN(d.getTime()) ? null : d.toISOString();
        }
        var clientId = cli && cli.value ? String(cli.value).trim() : null;
        if (!supabase || !currentUser || !orgId) {
          if (errEl) {
            errEl.textContent = 'Sign in and open a workspace to save tasks.';
            errEl.style.display = 'block';
          }
          return;
        }
        var row = {
          id: uuid(),
          user_id: assigneeId,
          organization_id: orgId,
          title: title,
          body: '',
          status: 'open',
          due_at: dueAt,
          client_id: clientId || null,
          campaign_id: null,
          created_by: 'user',
          workflow_run_id: null,
          assigned_to_email: assigneeEmail || null,
        };
        var ins = await supabase.from('workspace_tasks').insert(row);
        if (ins.error) {
          if (errEl) {
            errEl.textContent = String(ins.error.message || ins.error);
            errEl.style.display = 'block';
          }
          return;
        }
        closeModal();
        await wfRefreshFromSupabase();
        renderTasksPage();
      });
    }

    var filt = document.getElementById('tasks-filter');
    if (filt) {
      filt.addEventListener('change', function () {
        renderTasksPage();
      });
    }

    if (main) {
      main.addEventListener('click', async function (ev) {
        var menuBtn = ev.target.closest('[data-task-menu]');
        if (menuBtn && !isDemoDashboardUser()) {
          var tid = menuBtn.getAttribute('data-task-menu');
          if (tid && confirm('Delete this task?')) {
            supabase = window.supabaseClient || supabase;
            if (supabase && getCurrentOrgId()) {
              await supabase.from('workspace_tasks').delete().eq('id', tid).eq('organization_id', getCurrentOrgId());
              await wfRefreshFromSupabase();
              renderTasksPage();
            }
          }
          return;
        }
        var cb = ev.target.closest('[data-task-toggle]');
        if (!cb || isDemoDashboardUser()) return;
        var id = cb.getAttribute('data-task-toggle');
        if (!id) return;
        var nowDone = !!cb.checked;
        supabase = window.supabaseClient || supabase;
        if (!supabase || !getCurrentOrgId()) return;
        await supabase
          .from('workspace_tasks')
          .update({ status: nowDone ? 'done' : 'open', updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('organization_id', getCurrentOrgId());
        await wfRefreshFromSupabase();
        renderTasksPage();
      });
    }
  }

  function wireEmailsPage() {
    var root = document.getElementById('page-emails');
    if (!root || root.getAttribute('data-emails-wired') === '1') return;
    root.setAttribute('data-emails-wired', '1');

    var modal = document.getElementById('eml-compose-modal');
    var inpTo = document.getElementById('eml-compose-to');
    var inpSub = document.getElementById('eml-compose-subject');
    var inpBody = document.getElementById('eml-compose-body');
    var errEl = document.getElementById('eml-compose-err');
    var btnSend = document.getElementById('eml-compose-send');
    var btnCancel = document.getElementById('eml-compose-cancel');
    var btnSaveTpl = document.getElementById('eml-compose-save-template');
    var selTpl = document.getElementById('eml-compose-template');
    var composeTemplateById = {};

    function showComposeErr(msg) {
      if (!errEl) return;
      if (msg) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      } else {
        errEl.textContent = '';
        errEl.style.display = 'none';
      }
    }

    function closeComposeModal() {
      if (modal) modal.classList.remove('on');
      showComposeErr('');
    }
    window.__bizdashCloseEmlComposeModal = closeComposeModal;

    async function refreshComposeTemplateSelect() {
      composeTemplateById = {};
      if (!selTpl) return;
      selTpl.innerHTML = '';
      var opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '— Load template —';
      selTpl.appendChild(opt0);
      supabase = window.supabaseClient || supabase;
      if (!supabase || !getCurrentOrgId() || isDemoDashboardUser()) return;
      try {
        var row = await fetchAppSettingsFromSupabase();
        var list =
          row &&
          row.dashboard_settings &&
          Array.isArray(row.dashboard_settings.email_templates)
            ? row.dashboard_settings.email_templates
            : [];
        list.forEach(function (t) {
          if (!t || !t.id) return;
          composeTemplateById[t.id] = t;
          var o = document.createElement('option');
          o.value = String(t.id);
          o.textContent = String(t.name || t.subject || 'Template').slice(0, 120);
          selTpl.appendChild(o);
        });
      } catch (_) {}
      selTpl.value = '';
    }

    function openComposeModal() {
      if (!modal) return;
      if (inpTo) inpTo.value = '';
      if (inpSub) inpSub.value = '';
      if (inpBody) inpBody.value = '';
      showComposeErr('');
      if (btnSend) {
        btnSend.disabled = false;
        btnSend.textContent = 'Send';
      }
      modal.classList.add('on');
      void refreshComposeTemplateSelect();
      if (inpTo) inpTo.focus();
    }

    if (selTpl && selTpl.getAttribute('data-eml-template-wired') !== '1') {
      selTpl.setAttribute('data-eml-template-wired', '1');
      selTpl.addEventListener('change', function () {
        var id = String(selTpl.value || '').trim();
        var t = composeTemplateById[id];
        if (!t) return;
        if (inpTo) inpTo.value = t.to != null ? String(t.to) : '';
        if (inpSub) inpSub.value = t.subject != null ? String(t.subject) : '';
        if (inpBody) inpBody.value = t.body != null ? String(t.body) : '';
      });
    }

    root.querySelectorAll('[data-eml-compose]').forEach(function (btn) {
      btn.addEventListener('click', openComposeModal);
    });

    if (btnCancel) {
      btnCancel.addEventListener('click', closeComposeModal);
    }

    if (btnSaveTpl && btnSaveTpl.getAttribute('data-eml-save-template-wired') !== '1') {
      btnSaveTpl.setAttribute('data-eml-save-template-wired', '1');
      btnSaveTpl.addEventListener('click', async function () {
        var supa = window.supabaseClient;
        var sessRes = supa ? await supa.auth.getSession() : null;
        var sess = sessRes && sessRes.data ? sessRes.data.session : null;
        if (!sess || !sess.access_token) {
          alert('Sign in first.');
          return;
        }
        if (!getCurrentOrgId() || isDemoDashboardUser()) {
          alert('Open a workspace first.');
          return;
        }
        var subject = inpSub ? String(inpSub.value || '').trim() : '';
        var body = inpBody ? String(inpBody.value || '').trim() : '';
        if (!subject && !body) {
          showComposeErr('Add a subject or message before saving as a template.');
          return;
        }
        showComposeErr('');
        var defaultName = subject ? subject.slice(0, 80) : 'Template';
        var name = window.prompt('Template name', defaultName);
        if (name == null) return;
        name = String(name).trim();
        if (!name) {
          alert('Name is required.');
          return;
        }
        var toVal = inpTo ? String(inpTo.value || '').trim() : '';
        supabase = window.supabaseClient || supabase;
        try {
          var row = await fetchAppSettingsFromSupabase();
          var dash =
            row && row.dashboard_settings && typeof row.dashboard_settings === 'object'
              ? JSON.parse(JSON.stringify(row.dashboard_settings))
              : {};
          var list = Array.isArray(dash.email_templates) ? dash.email_templates.slice() : [];
          var id = 'et_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
          list.push({
            id: id,
            name: name,
            subject: subject,
            body: body,
            to: toVal,
            updated_at: new Date().toISOString(),
          });
          while (list.length > 50) list.shift();
          dash.email_templates = list;
          var ps = row && row.project_statuses != null ? row.project_statuses : projectStatuses;
          var up = await supabase.from('app_settings').upsert(
            {
              organization_id: getCurrentOrgId(),
              project_statuses: ps,
              dashboard_settings: dash,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'organization_id' }
          );
          if (up.error) {
            console.error('save email template', up.error);
            alert('Could not save template. Try again.');
            return;
          }
          await refreshComposeTemplateSelect();
          if (selTpl) selTpl.value = id;
          composeTemplateById[id] = list[list.length - 1];
          var bar = document.getElementById('app-invite-flash');
          if (bar) {
            bar.textContent = 'Template saved for this workspace.';
            bar.style.display = 'block';
            window.setTimeout(function () {
              bar.style.display = 'none';
              bar.textContent = '';
            }, 5000);
          }
        } catch (e) {
          console.warn('save email template', e);
          alert('Could not save template.');
        }
      });
    }

    if (btnSend && btnSend.getAttribute('data-eml-compose-send-wired') !== '1') {
      btnSend.setAttribute('data-eml-compose-send-wired', '1');
      btnSend.addEventListener('click', async function () {
        var supa = window.supabaseClient;
        var sessRes = supa ? await supa.auth.getSession() : null;
        var sess = sessRes && sessRes.data ? sessRes.data.session : null;
        if (!sess || !sess.access_token) {
          alert('Sign in first.');
          return;
        }
        var base = typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
        var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey.trim() : '';
        if (!base || !anon) {
          alert('Supabase URL or anon key is not configured in this app.');
          return;
        }
        var orgId = getCurrentOrgId();
        if (!orgId || !String(orgId).trim()) {
          alert('Open a workspace first.');
          return;
        }
        var to = inpTo ? String(inpTo.value || '').trim() : '';
        var subject = inpSub ? String(inpSub.value || '').trim() : '';
        var body = inpBody ? String(inpBody.value || '').trim() : '';
        if (!to || !subject || !body) {
          showComposeErr('Fill in To, Subject, and Message.');
          return;
        }
        showComposeErr('');
        btnSend.disabled = true;
        var origLabel = btnSend.textContent;
        btnSend.textContent = 'Sending…';
        try {
          var res = await fetch(base + '/functions/v1/gmail-send', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer ' + sess.access_token,
              apikey: anon,
            },
            body: JSON.stringify({
              organization_id: orgId,
              to: to,
              subject: subject,
              body: body,
            }),
          });
          var j = {};
          try {
            j = await res.json();
          } catch (_) {}
          if (!res.ok) {
            var err = j.error ? String(j.error) : 'send_failed';
            var det = j.detail ? String(j.detail) : '';
            if (err === 'not_connected') {
              showComposeErr('Connect Gmail first: open Settings → Connections, then use Get started.');
            } else {
              showComposeErr(det || err || 'Could not send. Try again or reconnect Google.');
            }
            btnSend.disabled = false;
            btnSend.textContent = origLabel;
            return;
          }
          var tid = j.threadId ? String(j.threadId) : '';
          var gurl = tid
            ? 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(tid)
            : 'https://mail.google.com/mail/u/0/#sent';
          closeComposeModal();
          var bar = document.getElementById('app-invite-flash');
          if (bar) {
            bar.innerHTML =
              'Message sent. <a href="' +
              gurl +
              '" target="_blank" rel="noopener noreferrer" style="color:inherit;font-weight:600;text-decoration:underline;">Open in Gmail</a>';
            bar.style.display = 'block';
            window.setTimeout(function () {
              bar.style.display = 'none';
              bar.textContent = '';
            }, 14000);
          } else {
            alert('Message sent.');
          }
        } catch (e) {
          console.warn('gmail-send', e);
          showComposeErr('Network error. Check your connection and try again.');
        }
        btnSend.disabled = false;
        btnSend.textContent = origLabel;
      });
    }

    root.querySelectorAll('[data-eml-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        var id = tab.getAttribute('data-eml-tab');
        if (!id) return;
        root.querySelectorAll('[data-eml-tab]').forEach(function (x) {
          var on = x.getAttribute('data-eml-tab') === id;
          x.classList.toggle('on', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        root.querySelectorAll('[data-eml-panel]').forEach(function (p) {
          var on = p.getAttribute('data-eml-panel') === id;
          p.classList.toggle('on', on);
          p.setAttribute('aria-hidden', on ? 'false' : 'true');
        });
        var activePanel = root.querySelector('.eml-panel.on');
        if (activePanel) {
          window.requestAnimationFrame(function () {
            stagePageMotion(activePanel);
          });
        }
      });
    });

    root.querySelectorAll('[data-eml-panel]').forEach(function (p) {
      var on = p.classList.contains('on');
      p.setAttribute('aria-hidden', on ? 'false' : 'true');
    });

    var help = root.querySelector('[data-eml-help]');
    if (help) {
      help.addEventListener('click', function (ev) {
        ev.preventDefault();
        var learn = root.querySelector('.eml-learn');
        if (learn) learn.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  function wireWorkflowAutomation() {
    var dyn = $('wf-automation-dynamic');
    if (dyn && dyn.getAttribute('data-wf-wired') !== '1') {
      dyn.setAttribute('data-wf-wired', '1');
      dyn.addEventListener('click', async function (ev) {
        var del = ev.target.closest('[data-wf-del-rule]');
        if (del) {
          var rid = del.getAttribute('data-wf-del-rule');
          if (rid && confirm('Delete this rule?')) {
            await wfDeleteRuleById(rid);
            renderAutomationSettings();
          }
        }
      });
    }
    var btnP = $('btn-wf-create-pipeline');
    if (btnP && btnP.getAttribute('data-wf-wired') !== '1') {
      btnP.setAttribute('data-wf-wired', '1');
      btnP.addEventListener('click', async function () {
        var r = await wfCreateDefaultClientPipeline();
        if (!r.ok) alert(r.error || 'Could not create pipeline');
        await wfRefreshFromSupabase();
        renderAutomationSettings();
      });
    }
    var btnS = $('btn-wf-seed-rule');
    if (btnS && btnS.getAttribute('data-wf-wired') !== '1') {
      btnS.setAttribute('data-wf-wired', '1');
      btnS.addEventListener('click', function () {
        wfSeedExampleMeetingRule();
      });
    }
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

  function remoteHasExpenseRecurrenceMeta(t) {
    if (!t) return false;
    if (t.recurrenceSeriesId) return true;
    if (t.expenseRecurringLead === true || t.expenseRecurrenceInstance === true) return true;
    if (t.recurrence && typeof t.recurrence === 'object' && Object.keys(t.recurrence).length) return true;
    if (t.recurring === true) return true;
    return false;
  }

  function mergeTransactionsPreserveRecurrence(prevList, remoteList) {
    var prevById = {};
    (prevList || []).forEach(function (t) {
      if (t && t.id) prevById[t.id] = t;
    });
    function textMissing(v) {
      return v == null || !String(v).trim();
    }
    return (remoteList || []).map(function (t) {
      var p = prevById[t.id];
      if (!p) return t;
      var next = Object.assign({}, t);
      if (textMissing(next.title) && !textMissing(p.title)) next.title = p.title;
      if (textMissing(next.vendor) && !textMissing(p.vendor)) next.vendor = p.vendor;
      if (textMissing(next.notes) && !textMissing(p.notes)) next.notes = p.notes;
      if (textMissing(next.source) && !textMissing(p.source)) next.source = p.source;
      if (textMissing(next.incomeCategoryLabel) && !textMissing(p.incomeCategoryLabel)) {
        next.incomeCategoryLabel = p.incomeCategoryLabel;
      }
      // Prefer cloud copy for recurring metadata so a stale local row cannot wipe synced fields.
      if (!remoteHasExpenseRecurrenceMeta(t)) {
        TX_RECURRENCE_KEYS.forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(p, k)) next[k] = p[k];
        });
      }
      return next;
    });
  }

  async function fetchClientsFromSupabase() {
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) {
      return loadClients();
    }

    try {
      var result = await supabase
        .from('clients')
        .select('*')
        .eq('organization_id', getCurrentOrgId())
        .order('created_at', { ascending: true });

      if (result.error) {
        console.error('load clients error', result.error);
        return loadClients();
      }

      var rows = result.data || [];

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
    var incOpts = ['<option value="">— None —</option>'];
    var expOpts = ['<option value="">— None (unallocated) —</option>'];
    clients.forEach(function (c) {
      var o = '<option value="' + (c.id || '') + '">' + (c.companyName || 'Untitled client') + '</option>';
      incOpts.push(o);
      expOpts.push(o);
    });
    var inc = $('income-client');
    if (inc) inc.innerHTML = incOpts.join('');
    var exp = $('expense-client');
    if (exp) exp.innerHTML = expOpts.join('');
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

  /** True for series lead, generated instances, or legacy recurring flag (metadata round-trips). */
  function isFixedRecurringExpense(tx) {
    return !!(tx && (tx.expenseRecurringLead === true || tx.expenseRecurrenceInstance === true || tx.recurring === true));
  }

  function compute(filter) {
    var txs = state.transactions.slice().filter(function (tx) {
      return isWithinRange(tx.date, filter);
    });

    var revenueByCat = { svc: 0, ret: 0 };
    var expenseByCat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    var expenseFixedTotal = 0;
    var expenseVariableTotal = 0;

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
          if (isFixedRecurringExpense(tx)) expenseFixedTotal += amt;
          else expenseVariableTotal += amt;
          break;
        case 'own':
          // Owner equity injection: tracked in ledger but excluded from revenue / expense / net.
          break;
      }
    });

    var revenueTotal = revenueByCat.svc + revenueByCat.ret;
    var expenseTotal = expenseByCat.lab + expenseByCat.sw + expenseByCat.ads + expenseByCat.oth;
    var net = revenueTotal - expenseTotal;
    // Gross profit / gross margin use labor (delivery) only as COGS; netProfit is after all expense buckets—do not conflate.
    var cogsTotal = expenseByCat.lab;
    var grossProfit = revenueTotal - cogsTotal;
    var grossMarginPct = revenueTotal > 0.01 ? (grossProfit / revenueTotal) * 100 : null;

    return {
      filter: filter,
      txs: txs.sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      }),
      revenueByCat: revenueByCat,
      expenseByCat: expenseByCat,
      revenueTotal: revenueTotal,
      expenseTotal: expenseTotal,
      expenseFixedTotal: expenseFixedTotal,
      expenseVariableTotal: expenseVariableTotal,
      cogsTotal: cogsTotal,
      grossProfit: grossProfit,
      grossMarginPct: grossMarginPct,
      netProfit: net,
    };
  }

  /** YYYY-MM-DD bounds for the dashboard period selector (month = full calendar month). */
  function dashboardCurrentYmdBounds(filter) {
    if (!filter || filter.mode === 'all') return null;
    if (filter.mode === 'month') {
      var now = new Date();
      var y = now.getFullYear();
      var m = now.getMonth();
      var s = new Date(y, m, 1, 12, 0, 0, 0);
      var e = new Date(y, m + 1, 0, 12, 0, 0, 0);
      return { start: dateYMD(s), end: dateYMD(e) };
    }
    if (filter.mode === 'range' && filter.start && filter.end) {
      return { start: filter.start, end: filter.end };
    }
    return null;
  }

  /** Prior period for MoM / PoP: previous calendar month, or equal-length window before custom range. */
  function dashboardPriorYmdBounds(filter) {
    if (!filter || filter.mode === 'all') return null;
    if (filter.mode === 'month') {
      var now = new Date();
      var firstThis = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0);
      var lastPrev = new Date(firstThis.getTime());
      lastPrev.setDate(0);
      var firstPrev = new Date(lastPrev.getFullYear(), lastPrev.getMonth(), 1, 12, 0, 0, 0);
      return { start: dateYMD(firstPrev), end: dateYMD(lastPrev) };
    }
    if (filter.mode === 'range' && filter.start && filter.end) {
      return spendPriorRange(filter.start, filter.end);
    }
    return null;
  }

  function computeForYmdRange(start, end) {
    return compute({ mode: 'range', start: start, end: end });
  }

  // ---------- DOM helpers ----------

  function $(id) {
    return document.getElementById(id);
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function setText(id, value) {
    var el = $(id);
    if (el) el.textContent = value;
  }

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  function animateRollout(panel, show, immediate) {
    if (!panel) return;
    if (prefersReducedMotion() || immediate) {
      panel.classList.toggle('on', !!show);
      panel.style.display = show ? 'block' : 'none';
      panel.style.height = show ? 'auto' : '0px';
      return;
    }
    panel.style.display = 'block';
    panel.style.overflow = 'hidden';
    var startH = panel.getBoundingClientRect().height;
    var endH = show ? panel.scrollHeight : 0;
    panel.style.height = String(startH) + 'px';
    panel.getBoundingClientRect();
    panel.classList.toggle('on', !!show);
    panel.style.height = String(endH) + 'px';
    var onDone = function () {
      panel.removeEventListener('transitionend', onDone);
      if (show) panel.style.height = 'auto';
      else panel.style.display = 'none';
    };
    panel.addEventListener('transitionend', onDone);
  }

  function stagePageMotion(container) {
    if (!container || prefersReducedMotion()) return;
    /** Advisor: stagger header → transcript → composer (same motion tokens as other pages). */
    if (container.id === 'page-chat') {
      var chatParts = container.querySelectorAll(
        '.chat-shell-header, .chat-transcript, .chat-composer-stack'
      );
      for (var c = 0; c < chatParts.length; c += 1) {
        var ch = chatParts[c];
        ch.classList.remove('motion-in');
        ch.classList.add('motion-item');
        ch.style.setProperty('--motion-delay', String(Math.min(c * 42, 220)) + 'ms');
        void ch.offsetWidth;
        ch.classList.add('motion-in');
      }
      return;
    }
    var selectors =
      '.ph, .kg .kc, .card, .ts-kpi, .bva-row, .dt tbody tr, ' +
      '.tasks-attio-hdr, .tasks-attio-toolbar, .tasks-learn, #tasks-tab-empty.on, ' +
      '.tasks-group-hdr, .tasks-table tbody tr, ' +
      '.eml-topbar, .eml-panel.on, .eml-learn';
    var nodes = container.querySelectorAll(selectors);
    var cap = Math.min(nodes.length, 22);
    for (var i = 0; i < cap; i += 1) {
      var node = nodes[i];
      node.classList.remove('motion-in');
      node.classList.add('motion-item');
      node.style.setProperty('--motion-delay', String(Math.min(i * 28, 280)) + 'ms');
      void node.offsetWidth;
      node.classList.add('motion-in');
    }
  }

  function setKpiBadge(id, text, tone) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    var t = tone === 'up' ? 'bu' : tone === 'down' ? 'bd' : 'bn';
    el.className = 'kb ' + t;
  }

  /** tone: 'up' | 'down' | 'neutral' for badge coloring. */
  function formatDashboardKpiDelta(currentVal, priorVal, metric) {
    var cur = +currentVal || 0;
    var pri = +priorVal || 0;
    var eps = 0.005;
    if (Math.abs(pri) < eps && Math.abs(cur) < eps) {
      return { text: '—', tone: 'neutral' };
    }
    if (Math.abs(pri) < eps) {
      if (metric === 'revenue' || metric === 'profit') {
        return { text: 'New', tone: 'up' };
      }
      if (metric === 'expense') {
        return { text: 'New', tone: 'down' };
      }
      return { text: 'New', tone: 'neutral' };
    }
    var delta = cur - pri;
    var pct = (delta / pri) * 100;
    var arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
    var absPct = Math.abs(pct);
    var pctStr = absPct >= 100 ? String(Math.round(pct)) : String(Math.round(pct * 10) / 10);
    if (pctStr.indexOf('.') !== -1) {
      pctStr = pctStr.replace(/\.0$/, '');
    }
    var text = arrow + ' ' + pctStr + '%';
    var up = cur > pri;
    var down = cur < pri;
    if (!up && !down) return { text: text, tone: 'neutral' };
    if (metric === 'expense') {
      return { text: text, tone: up ? 'down' : 'up' };
    }
    return { text: text, tone: up ? 'up' : 'down' };
  }

  /** Compare gross margin % vs prior period; delta in percentage points (higher margin = up). */
  function formatGrossMarginDeltaPctPoints(currentPct, priorPct) {
    var cur = currentPct;
    var pri = priorPct;
    if (cur == null || isNaN(cur)) {
      return { text: '—', tone: 'neutral' };
    }
    if (pri == null || isNaN(pri)) {
      return { text: '—', tone: 'neutral' };
    }
    var delta = cur - pri;
    var eps = 0.05;
    if (Math.abs(delta) < eps) {
      return { text: '→ 0 pts', tone: 'neutral' };
    }
    var arrow = delta > 0 ? '↑' : '↓';
    var pts = Math.abs(delta);
    var ptsStr = String(Math.round(pts * 10) / 10);
    if (ptsStr.indexOf('.') !== -1) ptsStr = ptsStr.replace(/\.0$/, '');
    return {
      text: arrow + ' ' + ptsStr + ' pts',
      tone: delta > 0 ? 'up' : 'down',
    };
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
  costType: 'all',
};
var INCOME_POWER_PREFS_KEY = 'income-power-prefs:v1';
var INCOME_TREND_RANGE_KEY = 'income-trend-range:v1';
var incomeTrendRange = '90d';
var incomePowerColumns = [
  { id: 'date', label: 'Date', type: 'date' },
  { id: 'source', label: 'Source', type: 'text' },
  { id: 'client', label: 'Client', type: 'text' },
  { id: 'project', label: 'Project', type: 'text' },
  { id: 'category', label: 'Category', type: 'enum' },
  { id: 'amount', label: 'Amount', type: 'number' },
  { id: 'invoice', label: 'Invoice', type: 'enum' },
  { id: 'recording', label: 'Recording', type: 'enum' },
];
var incomePowerState = {
  search: '',
  filters: [],
  visible: {
    date: true,
    source: true,
    client: true,
    project: true,
    category: true,
    amount: true,
    invoice: true,
    recording: true,
  },
  selected: {},
};

  function loadIncomePowerPrefs() {
    try {
      var raw = localStorage.getItem(storageKey(INCOME_POWER_PREFS_KEY));
      var parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object') return;
      if (typeof parsed.search === 'string') incomePowerState.search = parsed.search;
      if (Array.isArray(parsed.filters)) incomePowerState.filters = parsed.filters.slice(0, 6);
      if (parsed.visible && typeof parsed.visible === 'object') {
        incomePowerColumns.forEach(function (col) {
          if (Object.prototype.hasOwnProperty.call(parsed.visible, col.id)) {
            incomePowerState.visible[col.id] = parsed.visible[col.id] !== false;
          }
        });
      }
    } catch (_) {}
  }

  function loadIncomeTrendRange() {
    try {
      var raw = localStorage.getItem(storageKey(INCOME_TREND_RANGE_KEY));
      if (raw === '30d' || raw === '90d' || raw === 'ytd' || raw === 'all') incomeTrendRange = raw;
    } catch (_) {}
  }

  function saveIncomeTrendRange() {
    try {
      localStorage.setItem(storageKey(INCOME_TREND_RANGE_KEY), incomeTrendRange);
    } catch (_) {}
    ensureUserUiPrefsCache();
    schedulePersistUserUiPreferences();
  }

  function saveIncomePowerPrefs() {
    try {
      localStorage.setItem(storageKey(INCOME_POWER_PREFS_KEY), JSON.stringify({
        search: incomePowerState.search || '',
        filters: incomePowerState.filters || [],
        visible: incomePowerState.visible || {},
      }));
    } catch (_) {}
    ensureUserUiPrefsCache();
    schedulePersistUserUiPreferences();
  }

  function applyUserUiOrgSliceToRuntime(orgId, slice) {
    if (!orgId) return;
    slice = slice && typeof slice === 'object' ? slice : {};
    if (slice.customersColumns && typeof slice.customersColumns === 'object') {
      var d = defaultCustomersColumnPrefs();
      CUSTOMERS_COLUMN_DEFS.forEach(function (col) {
        if (col.locked) return;
        if (Object.prototype.hasOwnProperty.call(slice.customersColumns, col.id)) {
          d[col.id] = slice.customersColumns[col.id] !== false;
        }
      });
      customersColumnPrefs = d;
      try {
        localStorage.setItem(storageKey(CUSTOMERS_COLUMNS_PREFS_KEY), JSON.stringify(customersColumnPrefs));
      } catch (_) {}
    }
    if (slice.incomePower && typeof slice.incomePower === 'object') {
      if (typeof slice.incomePower.search === 'string') incomePowerState.search = slice.incomePower.search;
      if (Array.isArray(slice.incomePower.filters)) {
        incomePowerState.filters = slice.incomePower.filters.slice(0, 20);
      }
      if (slice.incomePower.visible && typeof slice.incomePower.visible === 'object') {
        incomePowerColumns.forEach(function (col) {
          if (Object.prototype.hasOwnProperty.call(slice.incomePower.visible, col.id)) {
            incomePowerState.visible[col.id] = slice.incomePower.visible[col.id] !== false;
          }
        });
      }
    }
    if (slice.incomeTrendRange === '30d' || slice.incomeTrendRange === '90d' || slice.incomeTrendRange === 'ytd' || slice.incomeTrendRange === 'all') {
      incomeTrendRange = slice.incomeTrendRange;
    }
    try {
      localStorage.setItem(storageKey(INCOME_POWER_PREFS_KEY), JSON.stringify({
        search: incomePowerState.search || '',
        filters: incomePowerState.filters || [],
        visible: incomePowerState.visible || {},
      }));
      localStorage.setItem(storageKey(INCOME_TREND_RANGE_KEY), incomeTrendRange);
    } catch (_) {}
    if (typeof renderCustomersColumnsPanel === 'function') renderCustomersColumnsPanel();
    if (typeof applyCustomersColumnVisibility === 'function') applyCustomersColumnVisibility();
    var trendEl = document.getElementById('rev-trend-range');
    if (trendEl) trendEl.value = incomeTrendRange;
    if (typeof renderIncomePowerColumnChooser === 'function') renderIncomePowerColumnChooser();
    if (typeof renderIncomePowerFilterRows === 'function') renderIncomePowerFilterRows();
    if (state.computed && typeof renderIncomeSection === 'function') renderIncomeSection(state.computed);
  }

  function getSidebarHiddenPageSet() {
    var set = {};
    sanitizeSidebarHiddenPages(ensureUserUiPrefsCache().sidebarHiddenPages).forEach(function (id) {
      set[id] = true;
    });
    return set;
  }

  function setSbNavDisplay(el, hidden) {
    if (!el) return;
    el.style.display = hidden ? 'none' : '';
  }

  function applySidebarNavVisibility() {
    var hidden = getSidebarHiddenPageSet();
    var sb = document.querySelector('.sb-nav');
    if (!sb) return;
    function isH(id) {
      return !!hidden[id];
    }
    SIDEBAR_NAV_PAGE_DEFS.forEach(function (def) {
      var id = def.id;
      var h = isH(id);
      if (id === 'lists') {
        setSbNavDisplay(document.getElementById('nav-lbl-lists'), h);
        setSbNavDisplay(document.getElementById('lists-sb-wrap'), h);
        setSbNavDisplay(sb.querySelector('.ni[data-nav="lists"]'), h);
      } else if (id === 'chat') {
        setSbNavDisplay(document.getElementById('nav-lbl-chats'), h);
        setSbNavDisplay(document.getElementById('chats-sb-wrap'), h);
        setSbNavDisplay(sb.querySelector('.ni[data-nav="chat"]'), h);
      } else {
        setSbNavDisplay(sb.querySelector('.ni[data-nav="' + id + '"]'), h);
      }
    });
    var showAnalyticsLabel =
      !isH('performance') || !isH('retention') || !isH('insights') || !isH('marketing');
    setSbNavDisplay(document.getElementById('nav-lbl-analytics'), !showAnalyticsLabel);
  }

  function setSidebarPageHidden(navId, hidden) {
    if (!SIDEBAR_PAGE_ID_SET[navId]) return;
    var c = ensureUserUiPrefsCache();
    var arr = sanitizeSidebarHiddenPages(c.sidebarHiddenPages);
    var ix = arr.indexOf(navId);
    if (hidden && ix < 0) arr.push(navId);
    if (!hidden && ix >= 0) arr.splice(ix, 1);
    c.sidebarHiddenPages = arr;
    applySidebarNavVisibility();
    if (getCurrentOrgId()) {
      schedulePersistUserUiPreferences();
    } else {
      supabase = window.supabaseClient || supabase;
      currentUser = window.currentUser || currentUser;
      if (supabase && currentUser && !isDemoDashboardUser()) {
        void persistUserUiPreferencesFromCache();
      }
    }
    renderSettingsPagesPanel();
  }

  /** SVG markup for each sidebar page (matches `.sb .ni[data-nav]` in index.html). */
  function getSidebarNavPageIconSvg(navId) {
    try {
      var id = String(navId || '').trim();
      if (!id) return '';
      var ni = document.querySelector('#app-shell .sb .ni[data-nav="' + id + '"]');
      if (!ni) return '';
      var first = ni.firstElementChild;
      var svg =
        first && first.tagName && String(first.tagName).toLowerCase() === 'svg'
          ? first
          : ni.querySelector('svg');
      return svg ? svg.outerHTML : '';
    } catch (_) {
      return '';
    }
  }

  function renderSettingsPagesPanel() {
    var listEl = document.getElementById('settings-pages-visible-list');
    var sel = document.getElementById('settings-pages-add-select');
    var emptyHint = document.getElementById('settings-pages-add-empty');
    if (!listEl || !sel) return;
    var hidden = getSidebarHiddenPageSet();
    var visibleRows = [];
    SIDEBAR_NAV_PAGE_DEFS.forEach(function (def) {
      if (!hidden[def.id]) visibleRows.push(def);
    });
    listEl.innerHTML = visibleRows.length
      ? visibleRows
          .map(function (def) {
            var ic = getSidebarNavPageIconSvg(def.id);
            return (
              '<div class="settings-pages-row">' +
              '<span class="settings-pages-row-label settings-pages-row-label-with-ico">' +
              (ic ? '<span class="settings-pages-row-ico" aria-hidden="true">' + ic + '</span>' : '') +
              '<span class="settings-pages-row-txt">' +
              def.label +
              '</span>' +
              '</span>' +
              '<button type="button" class="btn" data-settings-page-remove="' +
              def.id +
              '">Remove</button>' +
              '</div>'
            );
          })
          .join('')
      : '<p class="settings-ws-hint">No optional pages in the sidebar. Use Add below to restore a page.</p>';
    while (sel.options.length > 1) {
      sel.remove(1);
    }
    var hiddenAny = false;
    SIDEBAR_NAV_PAGE_DEFS.forEach(function (def) {
      if (hidden[def.id]) {
        hiddenAny = true;
        var op = document.createElement('option');
        op.value = def.id;
        op.textContent = def.label;
        sel.appendChild(op);
      }
    });
    if (emptyHint) emptyHint.style.display = hiddenAny ? 'none' : '';
    sel.value = '';
  }

  function wireSettingsPagesPanel() {
    var panel = document.getElementById('settings-panel-pages');
    if (!panel || panel.getAttribute('data-pages-wired') === '1') return;
    panel.setAttribute('data-pages-wired', '1');
    panel.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var rm = t.getAttribute('data-settings-page-remove');
      if (rm) {
        ev.preventDefault();
        setSidebarPageHidden(rm, true);
      }
    });
    var addBtn = document.getElementById('settings-pages-add-btn');
    if (addBtn && addBtn.getAttribute('data-pages-add-wired') !== '1') {
      addBtn.setAttribute('data-pages-add-wired', '1');
      addBtn.addEventListener('click', function () {
        var s = document.getElementById('settings-pages-add-select');
        var v = s && s.value ? String(s.value).trim() : '';
        if (!v) return;
        setSidebarPageHidden(v, false);
      });
    }
  }

  // Light UI chart theme: primary series follow Settings accent; muted grays for secondary series.
  var CHART_ORANGE = '#e8501a';
  var CHART_ORANGE_FILL = 'rgba(232, 80, 26, 0.1)';
  var CHART_ORANGE_FILL_BAR = 'rgba(232, 80, 26, 0.32)';
  var CHART_ORANGE_BORDER_BAR = 'rgba(232, 80, 26, 0.45)';
  var CHART_EMPTY = '#e4e4e7';
  var CHART_TICK = '#71717a';
  var CHART_GRID = 'rgba(0, 0, 0, 0.04)';
  var CHART_EXPENSE_GRAY = '#d4d4d8';
  /** Expense doughnut / budget bars: accent + stepped shades (updated in applyAccentBranding). */
  var CHART_EXPENSE_LABOR = CHART_ORANGE;
  var CHART_EXPENSE_SOFTWARE = darkenHex(CHART_ORANGE, 0.08);
  var CHART_EXPENSE_ADVERTISING = '#475569';
  var CHART_PALETTE_REST = ['#71717a', '#a1a1aa', '#d4d4d8', '#e4e4e7', '#52525b', '#94a3b8'];
  var CHART_VENDOR_PAL = [CHART_ORANGE, '#71717a', '#64748b', '#a1a1aa', '#94a3b8', '#78716c', '#d4d4d8', '#cbd5e1'];

  function chartMultiColors(count) {
    var c = [];
    for (var i = 0; i < count; i++) {
      c.push(i === 0 ? CHART_ORANGE : CHART_PALETTE_REST[(i - 1) % CHART_PALETTE_REST.length]);
    }
    return c;
  }

  /** Re-apply current branding kit to a revenue-style line dataset (Chart.js caches colors on first create). */
  function syncBrandedRevenueLineDataset(ds) {
    if (!ds) return;
    ds.borderColor = CHART_ORANGE;
    ds.backgroundColor = CHART_ORANGE_FILL;
    ds.pointBackgroundColor = CHART_ORANGE;
    ds.pointHoverBackgroundColor = CHART_ORANGE;
  }

  /** Keep branded bar fills in sync after live accent changes as well as on initial render. */
  function syncBrandedRevenueBarDataset(ds) {
    if (!ds) return;
    ds.backgroundColor = CHART_ORANGE;
    ds.hoverBackgroundColor = CHART_ORANGE;
  }

  function syncMutedExpenseBarDataset(ds) {
    if (!ds) return;
    ds.backgroundColor = CHART_EXPENSE_GRAY;
    ds.hoverBackgroundColor = CHART_EXPENSE_GRAY;
  }

  function renderExpenseChart(c) {
    var canvas = document.getElementById('cExp');
    if (!canvas || !window.Chart) return;

    var labels = [];
    var data = [];

    var map = [
      ['Labor', c.expenseByCat.lab],
      ['Software', c.expenseByCat.sw],
      ['Advertising', c.expenseByCat.ads],
      ['Other', c.expenseByCat.oth],
    ].filter(function (x) { return x[1] > 0.01; });

    function expenseBreakdownSliceColor(label) {
      switch (label) {
        case 'Labor': return CHART_EXPENSE_LABOR;
        case 'Software': return CHART_EXPENSE_SOFTWARE;
        case 'Advertising': return CHART_EXPENSE_ADVERTISING;
        case 'Other': return CHART_EXPENSE_GRAY;
        default: return CHART_PALETTE_REST[0];
      }
    }

    var colors = [];
    if (map.length === 0) {
      labels = ['No expense data'];
      data = [1];
    } else {
      map.forEach(function (pair) {
        labels.push(pair[0]);
        data.push(pair[1]);
        colors.push(expenseBreakdownSliceColor(pair[0]));
      });
    }

    if (!expenseChart) {
      expenseChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: map.length === 0 ? [CHART_EMPTY] : colors,
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
      expenseChart.data.datasets[0].backgroundColor = map.length === 0 ? [CHART_EMPTY] : colors;
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
      var color = colors[idx];
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
        try {
          revExpChart.update();
        } catch (e) {
          try {
            revExpChart.update('none');
          } catch (_) {}
        }
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
              backgroundColor: CHART_ORANGE,
              hoverBackgroundColor: CHART_ORANGE,
              borderRadius: 4,
            },
            {
              label: 'Expenses',
              data: expData,
              backgroundColor: CHART_EXPENSE_GRAY,
              hoverBackgroundColor: CHART_EXPENSE_GRAY,
              borderRadius: 4,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            colors: { enabled: false },
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
                color: CHART_TICK,
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
      syncBrandedRevenueBarDataset(revExpChart.data.datasets[0]);
      syncMutedExpenseBarDataset(revExpChart.data.datasets[1]);
      try {
        revExpChart.update();
      } catch (e) {
        try {
          revExpChart.update('none');
        } catch (_) {}
      }
    }
  }

  // ---------- Render ----------

  function renderKPIs(c) {
    setText('kpi-rev', fmtCurrency(c.revenueTotal));
    setText('kpi-exp', fmtCurrency(c.expenseTotal));
    setText('kpi-pft', fmtCurrency(c.netProfit));

    function monthlyizedRetainerRevenueForWindow(startYmd, endYmd) {
      var txs = state.transactions || [];
      var retTxs = txs.filter(function (tx) {
        if (tx.category !== 'ret' || !tx.date) return false;
        var d = parseYMD(tx.date);
        if (isNaN(d.getTime())) return false;
        if (startYmd && tx.date < startYmd) return false;
        if (endYmd && tx.date > endYmd) return false;
        return true;
      });
      if (!retTxs.length) return 0;
      var total = retTxs.reduce(function (sum, tx) { return sum + (+tx.amount || 0); }, 0);
      var months = {};
      retTxs.forEach(function (tx) {
        months[String(tx.date).slice(0, 7)] = true;
      });
      var monthCount = Object.keys(months).length || 1;
      return total / monthCount;
    }

    var curBounds = dashboardCurrentYmdBounds(c.filter || state.filter);
    var mrr = monthlyizedRetainerRevenueForWindow(
      curBounds ? curBounds.start : null,
      curBounds ? curBounds.end : null
    );
    setText('kpi-gm', fmtCurrency(mrr));
    var gmEl = $('kpi-gm');
    if (gmEl) gmEl.style.color = '';

    var expSplit = $('kpi-exp-split');
    if (expSplit) {
      var fx = Number(c.expenseFixedTotal || 0);
      var vr = Number(c.expenseVariableTotal || 0);
      if (fx < 0.01 && vr < 0.01) {
        expSplit.textContent = '';
      } else {
        expSplit.textContent = 'Fixed ' + fmtCurrencyPrecise(fx) + ' · One-time ' + fmtCurrencyPrecise(vr);
      }
    }

    var pftEl = $('kpi-pft');
    if (pftEl) {
      pftEl.style.color = c.netProfit < 0 ? 'var(--red)' : '';
    }

    var sub = $('dash-subtitle');
    var filt = c.filter || state.filter;
    var priorB = dashboardPriorYmdBounds(filt);
    if (!priorB) {
      setKpiBadge('kpi-rev-badge', '—', 'neutral');
      setKpiBadge('kpi-exp-badge', '—', 'neutral');
      setKpiBadge('kpi-pft-badge', '—', 'neutral');
      setKpiBadge('kpi-gm-badge', '—', 'neutral');
      if (sub) sub.textContent = filt && filt.mode === 'all' ? 'All-time — no prior period to compare' : '—';
      return;
    }

    var curB = dashboardCurrentYmdBounds(filt);
    var priorC = computeForYmdRange(priorB.start, priorB.end);
    var dRev = formatDashboardKpiDelta(c.revenueTotal, priorC.revenueTotal, 'revenue');
    var dExp = formatDashboardKpiDelta(c.expenseTotal, priorC.expenseTotal, 'expense');
    var dPft = formatDashboardKpiDelta(c.netProfit, priorC.netProfit, 'profit');
    var curMrr = monthlyizedRetainerRevenueForWindow(curB ? curB.start : null, curB ? curB.end : null);
    var priorMrr = monthlyizedRetainerRevenueForWindow(priorB.start, priorB.end);
    var dGm = formatDashboardKpiDelta(curMrr, priorMrr, 'revenue');
    setKpiBadge('kpi-rev-badge', dRev.text, dRev.tone);
    setKpiBadge('kpi-exp-badge', dExp.text, dExp.tone);
    setKpiBadge('kpi-pft-badge', dPft.text, dPft.tone);
    setKpiBadge('kpi-gm-badge', dGm.text, dGm.tone);

    if (sub) {
      if (filt.mode === 'month') {
        var pm = parseYMD(priorB.start);
        sub.textContent = isNaN(pm.getTime())
          ? 'Compared to prior month'
          : 'vs ' + pm.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      } else {
        sub.textContent = 'vs ' + fmtDateDisplay(priorB.start) + ' – ' + fmtDateDisplay(priorB.end);
      }
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
        ['Software & Tools', c.expenseByCat.sw],
        ['Advertising', c.expenseByCat.ads],
        ['Other', c.expenseByCat.oth],
      ].filter(function (x) { return x[1] > 0.01; });
      expLines.innerHTML = expMap.length ? expMap.map(function (pair) {
        return '<div class="fr"><span class="lbl">' + pair[0] + '</span><span class="val neg">−' + fmtCurrency(pair[1]) + '</span></div>';
      }).join('') : '<div class="fr"><span class="lbl">(none)</span><span class="val neg">−$0</span></div>';
    }

    setText('f-gro', fmtCurrency(c.revenueTotal));
    var fcogs = $('f-cogs-lab');
    if (fcogs) {
      fcogs.textContent = '−' + fmtCurrency(c.cogsTotal || 0);
    }
    var fgp = $('f-gp');
    if (fgp) {
      fgp.textContent = fmtCurrency(c.grossProfit);
      fgp.className = 'val ' + (c.grossProfit >= 0 ? 'pos' : 'neg');
    }
    var fgmp = $('f-gmpct');
    if (fgmp) {
      if (c.grossMarginPct != null && !isNaN(c.grossMarginPct)) {
        fgmp.textContent =
          (Math.round(c.grossMarginPct * 10) / 10).toLocaleString('en-US', {
            maximumFractionDigits: 1,
            minimumFractionDigits: 0,
          }) + '%';
        fgmp.className = 'val ' + (c.grossMarginPct >= 0 ? 'pos' : 'neg');
      } else {
        fgmp.textContent = '—';
        fgmp.className = 'val';
      }
    }
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
      var catLabel;
      if (tx.category === 'svc' || tx.category === 'ret') {
        catLabel = displayIncomeCategory(tx);
      } else {
        catLabel = {
          own: 'Owner investment',
          lab: 'Labor',
          sw: 'Software',
          ads: 'Ads',
          oth: 'Other',
        }[tx.category] || tx.category || '—';
      }
      var isInflow = tx.category === 'svc' || tx.category === 'ret' || tx.category === 'own';
      var isOutflow = tx.category === 'lab' || tx.category === 'sw' || tx.category === 'ads' || tx.category === 'oth';
      var amountNumber = Math.abs(Number(tx.amount || 0));
      var amountSign = (isOutflow || (!isInflow && Number(tx.amount || 0) < 0)) ? '-' : '+';
      var amountColor = amountSign === '-' ? 'var(--red)' : 'var(--green)';
      return '<tr>' +
        '<td>' + d + '</td>' +
        '<td>' + catLabel + '</td>' +
        '<td class="tdp" style="color:' + amountColor + ' !important;">' + amountSign + fmtCurrency(amountNumber) + '</td>' +
        '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (tx.description || '') + '">' + (tx.description || '—') + '</td>' +
        '<td style="white-space:nowrap;"><button type="button" class="btn" data-tx-del="' + tx.id + '" style="color:var(--red);">Delete</button></td>' +
        '</tr>';
    }).join('');
  }

  /** Client-side sort for #expenses-table (headers use data-exp-sort in index.html). */
  var expensesTableSort = { key: 'date', dir: 'desc' };

  function expenseCategorySortLabel(cat) {
    return {
      lab: 'Labor',
      sw: 'Software',
      ads: 'Advertising',
      oth: 'Other',
    }[cat] || cat || '';
  }

  /** Defaults when switching columns: date/amount/recurring → desc; text columns → asc (A–Z). */
  function defaultExpensesSortDir(key) {
    if (key === 'date' || key === 'amount' || key === 'recurring') return 'desc';
    return 'asc';
  }

  function expenseDateSortMs(tx) {
    var d = parseYMD(tx.date);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  function recurringExpenseSortRank(tx) {
    if (tx.expenseRecurringLead) return 2;
    if (tx.expenseRecurrenceInstance) return 1;
    return 0;
  }

  function compareExpenseTxStable(a, b) {
    return String(a.id || '').localeCompare(String(b.id || ''));
  }

  function sortExpenseTransactions(txs, sort) {
    var key = sort.key;
    var dir = sort.dir;
    var dirSign = dir === 'asc' ? 1 : -1;
    var out = txs.slice();
    out.sort(function (a, b) {
      var cmp = 0;
      if (key === 'date') {
        var ma = expenseDateSortMs(a);
        var mb = expenseDateSortMs(b);
        if (ma === null && mb === null) cmp = 0;
        else if (ma === null) cmp = 1;
        else if (mb === null) cmp = -1;
        else cmp = ma - mb;
        if (cmp !== 0) return dirSign * cmp > 0 ? 1 : -1;
        return compareExpenseTxStable(a, b);
      }
      if (key === 'amount') {
        var na = Math.abs(Number(a.amount != null ? a.amount : 0));
        var nb = Math.abs(Number(b.amount != null ? b.amount : 0));
        cmp = na - nb;
        if (cmp !== 0) return dirSign * cmp > 0 ? 1 : -1;
        return compareExpenseTxStable(a, b);
      }
      if (key === 'recurring') {
        cmp = recurringExpenseSortRank(a) - recurringExpenseSortRank(b);
        if (cmp !== 0) return dirSign * cmp > 0 ? 1 : -1;
        return compareExpenseTxStable(a, b);
      }
      var sa;
      var sb;
      if (key === 'title') {
        sa = ((a.title || a.description || '')).trim();
        sb = ((b.title || b.description || '')).trim();
      } else if (key === 'category') {
        sa = expenseCategorySortLabel(a.category);
        sb = expenseCategorySortLabel(b.category);
      } else if (key === 'vendor') {
        sa = String(a.vendor || '').trim();
        sb = String(b.vendor || '').trim();
      } else if (key === 'client') {
        sa = (clientCompanyNameById(a.clientId) || '').trim();
        sb = (clientCompanyNameById(b.clientId) || '').trim();
      } else {
        return compareExpenseTxStable(a, b);
      }
      cmp = sa.localeCompare(sb, undefined, { sensitivity: 'base' });
      if (cmp !== 0) return dirSign * cmp > 0 ? 1 : -1;
      return compareExpenseTxStable(a, b);
    });
    return out;
  }

  function updateExpensesTableSortHeaders() {
    var table = $('expenses-table');
    if (!table) return;
    var thead = table.querySelector('thead');
    if (!thead) return;
    var headers = thead.querySelectorAll('th[data-exp-sort]');
    for (var i = 0; i < headers.length; i++) {
      var th = headers[i];
      var k = th.getAttribute('data-exp-sort');
      var ind = th.querySelector('.exp-th-sort-ind');
      if (k === expensesTableSort.key) {
        th.setAttribute('aria-sort', expensesTableSort.dir === 'asc' ? 'ascending' : 'descending');
        if (ind) ind.textContent = expensesTableSort.dir === 'asc' ? '↑' : '↓';
      } else {
        th.removeAttribute('aria-sort');
        if (ind) ind.textContent = '';
      }
    }
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
      updateExpensesTableSortHeaders();
      return;
    }
    if (empty) empty.style.display = 'none';
    if (table) table.style.display = 'table';

    expenseTxs = sortExpenseTransactions(expenseTxs, expensesTableSort);

    tbody.innerHTML = expenseTxs.map(function (tx) {
      var label = {
        lab: 'Labor',
        sw: 'Software',
        ads: 'Advertising',
        oth: 'Other',
      }[tx.category] || tx.category || 'Expense';
      var titleText = (tx.title && String(tx.title).trim()) || (tx.description && String(tx.description).trim()) || '—';
      var vendorText = (tx.vendor && String(tx.vendor).trim()) || '—';
      var clientCell = clientCompanyNameById(tx.clientId) || '—';
      return '<tr>' +
        '<td>' + (tx.date || '—') + '</td>' +
        '<td class="tdp">' + titleText + '</td>' +
        '<td>' + label + '</td>' +
        '<td>' + fmtCurrency(tx.amount) + '</td>' +
        '<td>' + vendorText + '</td>' +
        '<td>' + esc(clientCell) + '</td>' +
        '<td>' + (tx.expenseRecurringLead ? '<span class="pl pg-c">Series</span>' : tx.expenseRecurrenceInstance ? '<span class="pl pg-c">Yes</span>' : 'No') + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button type="button" class="btn" data-exp-edit="' + tx.id + '" style="margin-right:6px;">Edit</button>' +
          '<button type="button" class="btn" data-exp-del="' + tx.id + '" style="color:var(--red);">Delete</button>' +
        '</td>' +
        '</tr>';
    }).join('');
    updateExpensesTableSortHeaders();
  }

  function renderBudgetVsActual() {
    var container = document.getElementById('budget-vs-actual');
    if (!container) return;

    var now = new Date();
    var monthLabelEl = document.getElementById('bva-month-label');
    if (monthLabelEl) {
      monthLabelEl.textContent = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    var thisMonthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    var allTxs = state.transactions || [];
    var actualByCat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    allTxs.forEach(function (tx) {
      if (!tx.date) return;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return;
      var monthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (monthKey !== thisMonthKey) return;
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (actualByCat.hasOwnProperty(tx.category)) actualByCat[tx.category] += amt;
    });

    var catLabels = { lab: 'Labor', sw: 'Software & Tools', ads: 'Advertising', oth: 'Other' };
    var catColors = {
      lab: CHART_EXPENSE_LABOR,
      sw: CHART_EXPENSE_SOFTWARE,
      ads: CHART_EXPENSE_ADVERTISING,
      oth: CHART_EXPENSE_GRAY,
    };

    var hasAnyBudget = (budgets.lab + budgets.sw + budgets.ads + budgets.oth) > 0;
    var totalBudget = budgets.lab + budgets.sw + budgets.ads + budgets.oth;
    var totalActual = actualByCat.lab + actualByCat.sw + actualByCat.ads + actualByCat.oth;

    var monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    if (!hasAnyBudget) {
      container.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
          '<div>' +
            '<div style="font-size:13px;color:var(--text2);line-height:1.5;">' +
              'No monthly budgets set yet. ' +
              '<a href="#" onclick="window.nav(\'settings\');return false;" style="color:var(--coral);text-decoration:none;font-weight:500;">Set budgets in Settings →</a>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--text3);">' + monthLabel + ' · ' + fmtCurrency(totalActual) + ' spent</div>' +
        '</div>';
      return;
    }

    var rows = ['lab', 'sw', 'ads', 'oth'].map(function (k) {
      var budget = budgets[k];
      var actual = actualByCat[k];
      if (budget < 0.01 && actual < 0.01) return '';

      var pct = budget > 0 ? Math.min(actual / budget * 100, 100) : 0;
      var overPct = budget > 0 ? actual / budget * 100 : 0;
      var remaining = budget - actual;

      var barColor = overPct >= 100 ? 'var(--red)' : overPct >= 80 ? 'var(--amber)' : catColors[k];
      var remainingColor = remaining < 0 ? 'var(--red)' : remaining < budget * 0.2 ? 'var(--amber)' : 'var(--green)';
      var remainingLabel = remaining >= 0 ? fmtCurrencyPrecise(remaining) + ' left' : fmtCurrencyPrecise(Math.abs(remaining)) + ' over';

      var statusBadge = '';
      if (budget > 0) {
        if (overPct >= 100) {
          statusBadge = '<span class="pl pg-r" style="font-size:10px;">Over</span>';
        } else if (overPct >= 80) {
          statusBadge = '<span class="pl pg-a" style="font-size:10px;">' + Math.round(overPct) + '%</span>';
        }
      }

      return '<div class="bva-row">' +
        '<div class="bva-label">' +
          '<span class="bva-dot" style="background:' + catColors[k] + ';"></span>' +
          '<span>' + catLabels[k] + '</span>' +
          statusBadge +
        '</div>' +
        '<div class="bva-nums">' +
          '<span class="bva-actual">' + fmtCurrency(actual) + '</span>' +
          '<span class="bva-sep">of</span>' +
          '<span class="bva-budget">' + fmtCurrency(budget) + '</span>' +
        '</div>' +
        '<div class="bva-bar-wrap">' +
          '<div class="pb" style="height:6px;flex:1;">' +
            '<div class="pf" style="width:' + pct.toFixed(1) + '%;background:' + barColor + ';height:100%;"></div>' +
          '</div>' +
          '<span class="bva-remaining" style="color:' + remainingColor + ';">' + remainingLabel + '</span>' +
        '</div>' +
      '</div>';
    }).filter(Boolean).join('');

    var totalPct = totalBudget > 0 ? Math.min(totalActual / totalBudget * 100, 100) : 0;
    var totalRemaining = totalBudget - totalActual;
    var totalBarColor = totalPct >= 100 ? 'var(--red)' : totalPct >= 80 ? 'var(--amber)' : 'var(--green)';
    var totalRemainingColor = totalRemaining < 0 ? 'var(--red)' : totalRemaining < totalBudget * 0.2 ? 'var(--amber)' : 'var(--green)';
    var totalRemainingLabel = totalRemaining >= 0 ? fmtCurrencyPrecise(totalRemaining) + ' left' : fmtCurrencyPrecise(Math.abs(totalRemaining)) + ' over';

    var totalRow = '<div class="bva-row bva-total">' +
      '<div class="bva-label"><span>Total</span></div>' +
      '<div class="bva-nums">' +
        '<span class="bva-actual">' + fmtCurrency(totalActual) + '</span>' +
        '<span class="bva-sep">of</span>' +
        '<span class="bva-budget">' + fmtCurrency(totalBudget) + '</span>' +
      '</div>' +
      '<div class="bva-bar-wrap">' +
        '<div class="pb" style="height:6px;flex:1;">' +
          '<div class="pf" style="width:' + totalPct.toFixed(1) + '%;background:' + totalBarColor + ';height:100%;"></div>' +
        '</div>' +
        '<span class="bva-remaining" style="color:' + totalRemainingColor + ';">' + totalRemainingLabel + '</span>' +
      '</div>' +
    '</div>';

    container.innerHTML = rows + totalRow;
  }

  var SPEND_EXP_CATS = ['lab', 'sw', 'ads', 'oth'];

  function spendCategoryPillMeta(catKey) {
    var m = {
      lab: { label: 'Labor', color: CHART_EXPENSE_LABOR },
      sw: { label: 'Software', color: CHART_EXPENSE_SOFTWARE },
      ads: { label: 'Advertising', color: CHART_EXPENSE_ADVERTISING },
      oth: { label: 'Other', color: CHART_EXPENSE_GRAY },
    };
    return m[catKey] || { label: String(catKey), color: CHART_EXPENSE_GRAY };
  }

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

  function spendMatchesSpendTab(tx, tab, pillDefs) {
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
    if (tab.indexOf('cli:') === 0) {
      var wantC = tab.slice(4);
      if (wantC === '__other__') {
        var topSetC = {};
        pillDefs.forEach(function (p) {
          if (p.id.indexOf('cli:') === 0 && p.id !== 'cli:__other__') topSetC[p.id.slice(4)] = true;
        });
        var txKeyC = tx.clientId ? String(tx.clientId) : '__unallocated__';
        return !topSetC[txKeyC];
      }
      var txKey = tx.clientId ? String(tx.clientId) : '__unallocated__';
      return txKey === wantC;
    }
    return true;
  }

  function spendVendorAggregateKey(tx) {
    return (tx.vendor && String(tx.vendor).trim()) || '—';
  }

  function spendVendorDisplayLabel(key) {
    return key === '—' ? 'No vendor' : key;
  }

  function spendRankVendors(expenseTxsInRange) {
    var tot = {};
    expenseTxsInRange.forEach(function (tx) {
      var k = spendVendorAggregateKey(tx);
      tot[k] = (tot[k] || 0) + (+tx.amount || 0);
    });
    return Object.keys(tot).map(function (k) {
      return { key: k, total: tot[k] };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function renderSpendTopVendors(inRange, rangeMode, re) {
    var sumEl = document.getElementById('spend-top-vendors-summary');
    var listEl = document.getElementById('spend-top-vendors-list');
    if (!sumEl || !listEl) return;

    var periodDen = inRange.reduce(function (a, tx) { return a + (+tx.amount || 0); }, 0);
    if (!inRange.length || periodDen < 0.01) {
      sumEl.innerHTML = '<span class="spend-top-vendors-empty">No spend recorded in this period.</span>';
      listEl.innerHTML = '';
      return;
    }

    var ranked = spendRankVendors(inRange).filter(function (r) { return r.total > 0.01; });
    var topN = 10;
    var rows = ranked.slice(0, topN);

    var narrPrefix = '';
    if (rangeMode === 'month') {
      narrPrefix = 'In ' + re.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } else if (rangeMode === '30d') {
      narrPrefix = 'Over the last 30 days';
    } else if (rangeMode === '90d') {
      narrPrefix = 'Over the last 90 days';
    } else if (rangeMode === 'ytd') {
      narrPrefix = 'Year to date';
    } else {
      narrPrefix = 'All time';
    }

    var narr = ranked.slice(0, 3);
    var narrHtml = '';
    if (narr.length === 1) {
      var d0 = spendVendorDisplayLabel(narr[0].key);
      narrHtml = esc(narrPrefix) + ', you spent <strong>' + esc(fmtCurrency(narr[0].total)) + '</strong> with ' + esc(d0) + '.';
    } else if (narr.length === 2) {
      var d0a = spendVendorDisplayLabel(narr[0].key);
      var d1a = spendVendorDisplayLabel(narr[1].key);
      narrHtml = esc(narrPrefix) + ', you spent <strong>' + esc(fmtCurrency(narr[0].total)) + '</strong> with ' + esc(d0a) +
        ' and <strong>' + esc(fmtCurrency(narr[1].total)) + '</strong> with ' + esc(d1a) + '.';
    } else if (narr.length >= 3) {
      var d0b = spendVendorDisplayLabel(narr[0].key);
      var d1b = spendVendorDisplayLabel(narr[1].key);
      var d2b = spendVendorDisplayLabel(narr[2].key);
      narrHtml = esc(narrPrefix) + ', you spent <strong>' + esc(fmtCurrency(narr[0].total)) + '</strong> with ' + esc(d0b) +
        ', <strong>' + esc(fmtCurrency(narr[1].total)) + '</strong> with ' + esc(d1b) +
        ', and <strong>' + esc(fmtCurrency(narr[2].total)) + '</strong> with ' + esc(d2b) + '.';
    }
    sumEl.innerHTML = narrHtml;

    listEl.innerHTML = rows.map(function (r, i) {
      var pct = periodDen > 0 ? Math.round((r.total / periodDen) * 1000) / 10 : 0;
      var pctStr = (pct % 1 === 0 ? String(Math.round(pct)) : pct.toFixed(1)) + '%';
      var label = spendVendorDisplayLabel(r.key);
      var barW = periodDen > 0 ? Math.min(100, Math.round((r.total / periodDen) * 1000) / 10) : 0;
      return '<div class="spend-tv-row">' +
        '<span class="spend-tv-rank">' + (i + 1) + '</span>' +
        '<span class="spend-tv-name" title="' + esc(label) + '">' + esc(label) + '</span>' +
        '<span class="spend-tv-amt">' + esc(fmtCurrency(r.total)) + '</span>' +
        '<span class="spend-tv-pct">' + esc(pctStr) + '</span>' +
        '<div class="spend-tv-bar" aria-hidden="true"><div class="spend-tv-bar-fill" style="width:' + barW + '%"></div></div>' +
        '</div>';
    }).join('');
  }

  function renderSpendingReport() {
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
    if (isNaN(rs.getTime()) || isNaN(re.getTime())) {
      var sumBad = document.getElementById('spend-top-vendors-summary');
      var listBad = document.getElementById('spend-top-vendors-list');
      if (sumBad) sumBad.innerHTML = '';
      if (listBad) listBad.innerHTML = '';
      return;
    }

    var inRange = allExpense.filter(function (tx) {
      if (!tx.date) return false;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return false;
      return d >= rs && d <= re;
    });

    renderSpendTopVendors(inRange, rangeMode, re);

    var canvas = document.getElementById('cSpendTrend');
    if (!canvas || !window.Chart) return;

    var missingDates = allExpense.filter(function (tx) { return !tx.date || isNaN(parseYMD(tx.date).getTime()); }).length;
    if (missingDates) {
      console.warn('Spending chart: ' + missingDates + ' expense row(s) have no valid date and are omitted from the series.');
    }

    var forPills = inRange.filter(function (tx) { return spendMatchesQuery(tx, q); });

    var pillsEl = document.getElementById('spend-pills');
    var pillsLbl = document.getElementById('spend-pills-lbl');
    if (pillsLbl) {
      if (slice === 'vendor') pillsLbl.textContent = 'Vendor';
      else if (slice === 'client') pillsLbl.textContent = 'Client';
      else pillsLbl.textContent = 'Category';
    }

    var pillDefs = [{ id: 'all', label: 'All', color: 'var(--text)' }];
    if (slice === 'category') {
      SPEND_EXP_CATS.forEach(function (k) {
        var has = forPills.some(function (tx) { return tx.category === k; });
        if (has) {
          var catMeta = spendCategoryPillMeta(k);
          pillDefs.push({ id: 'cat:' + k, label: catMeta.label, color: catMeta.color });
        }
      });
    } else if (slice === 'client') {
      var cliTot = {};
      forPills.forEach(function (tx) {
        var ck = tx.clientId ? String(tx.clientId) : '__unallocated__';
        cliTot[ck] = (cliTot[ck] || 0) + (+tx.amount || 0);
      });
      var cliList = Object.keys(cliTot).sort(function (a, b) { return cliTot[b] - cliTot[a]; });
      var maxC = 12;
      var topC = cliList.slice(0, maxC);
      var restC = cliList.slice(maxC);
      var PALc = CHART_VENDOR_PAL;
      topC.forEach(function (k, i) {
        var label = k === '__unallocated__' ? 'Unallocated' : (clientCompanyNameById(k) || 'Unknown client');
        pillDefs.push({ id: 'cli:' + k, label: label, color: PALc[i % PALc.length] });
      });
      if (restC.length) pillDefs.push({ id: 'cli:__other__', label: 'Other', color: CHART_EXPENSE_GRAY });
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
      var PAL = CHART_VENDOR_PAL;
      top.forEach(function (v, i) {
        pillDefs.push({ id: 'ven:' + v, label: v, color: PAL[i % PAL.length] });
      });
      if (rest.length) pillDefs.push({ id: 'ven:__other__', label: 'Other', color: CHART_EXPENSE_GRAY });
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
      return spendMatchesSpendTab(tx, tab, pillDefs);
    });

    var costType = spendReportUi.costType || 'all';
    if (costType !== 'all' && costType !== 'fixed' && costType !== 'variable') costType = 'all';

    var enumed = spendEnumerateBuckets(rs, re, interval);
    var keys = enumed.keys;
    var shortLabels = enumed.shortLabels;
    spendReportTooltipTitles = enumed.titles.slice();

    var sumsFixed = {};
    var sumsVar = {};
    keys.forEach(function (k) {
      sumsFixed[k] = 0;
      sumsVar[k] = 0;
    });

    var useIndexAxis = filtered.length > 0 && filtered.every(function (tx) {
      return !tx.date || isNaN(parseYMD(tx.date).getTime());
    });

    if (!useIndexAxis) {
      filtered.forEach(function (tx) {
        var bk = spendTxBucketKey(tx.date, interval);
        if (!bk || !sumsFixed.hasOwnProperty(bk)) return;
        var amt = +tx.amount || 0;
        if (isFixedRecurringExpense(tx)) sumsFixed[bk] += amt;
        else sumsVar[bk] += amt;
      });
    } else {
      keys = filtered.map(function (_, i) { return 'i' + i; });
      shortLabels = filtered.map(function (_, i) { return 'Entry ' + (i + 1); });
      spendReportTooltipTitles = filtered.map(function (tx) {
        return (tx.title || tx.vendor || tx.description || 'Expense') + ' · ' + (tx.date || 'no date');
      });
      sumsFixed = {};
      sumsVar = {};
      filtered.forEach(function (tx, i) {
        var k = 'i' + i;
        var amt = +tx.amount || 0;
        if (isFixedRecurringExpense(tx)) sumsFixed[k] = amt;
        else sumsVar[k] = amt;
      });
    }

    if (!keys.length) {
      keys = ['_empty'];
      shortLabels = ['—'];
      spendReportTooltipTitles = ['No data in range'];
      sumsFixed = { _empty: 0 };
      sumsVar = { _empty: 0 };
    }

    var round2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
    var dataValsFixed = keys.map(function (k) { return round2(sumsFixed[k] || 0); });
    var dataValsVar = keys.map(function (k) { return round2(sumsVar[k] || 0); });
    var dataValsTotal = keys.map(function (_, i) { return round2(dataValsFixed[i] + dataValsVar[i]); });

    var periodTotalFixed = dataValsFixed.reduce(function (a, b) { return a + b; }, 0);
    var periodTotalVar = dataValsVar.reduce(function (a, b) { return a + b; }, 0);
    var periodTotalAll = periodTotalFixed + periodTotalVar;

    var dataVals;
    if (costType === 'fixed') dataVals = dataValsFixed;
    else if (costType === 'variable') dataVals = dataValsVar;
    else dataVals = dataValsTotal;

    var periodTotal;
    if (costType === 'fixed') periodTotal = periodTotalFixed;
    else if (costType === 'variable') periodTotal = periodTotalVar;
    else periodTotal = periodTotalAll;

    var pr = spendPriorRange(range.start, range.end);
    var priorTxs = allExpense.filter(function (tx) {
      if (!tx.date) return false;
      var d = parseYMD(tx.date);
      if (isNaN(d.getTime())) return false;
      return d >= parseYMD(pr.start) && d <= parseYMD(pr.end);
    }).filter(function (tx) { return spendMatchesQuery(tx, q); }).filter(function (tx) {
      return spendMatchesSpendTab(tx, tab, pillDefs);
    });

    var priorTotalFixed = 0;
    var priorTotalVar = 0;
    var priorTotalAll = 0;
    var priorTotal = 0;
    if (!useIndexAxis) {
      var pEnumPrior = spendEnumerateBuckets(parseYMD(pr.start), parseYMD(pr.end), interval);
      var priorSumsF = {};
      var priorSumsV = {};
      pEnumPrior.keys.forEach(function (k) {
        priorSumsF[k] = 0;
        priorSumsV[k] = 0;
      });
      priorTxs.forEach(function (tx) {
        var bk = spendTxBucketKey(tx.date, interval);
        if (!bk || !priorSumsF.hasOwnProperty(bk)) return;
        var amt = +tx.amount || 0;
        if (isFixedRecurringExpense(tx)) priorSumsF[bk] += amt;
        else priorSumsV[bk] += amt;
      });
      priorTotalFixed = pEnumPrior.keys.reduce(function (a, k) { return a + (priorSumsF[k] || 0); }, 0);
      priorTotalVar = pEnumPrior.keys.reduce(function (a, k) { return a + (priorSumsV[k] || 0); }, 0);
      priorTotalAll = priorTotalFixed + priorTotalVar;
      if (costType === 'fixed') priorTotal = priorTotalFixed;
      else if (costType === 'variable') priorTotal = priorTotalVar;
      else priorTotal = priorTotalAll;
    }

    var kpiPrimaryLbl = document.getElementById('spend-kpi-primary-lbl');
    var kpiSecondaryLbl = document.getElementById('spend-kpi-secondary-lbl');
    var kpiPrimaryVal = document.getElementById('spend-kpi-primary-val');
    var kpiSecondaryVal = document.getElementById('spend-kpi-secondary-val');
    var kpiPrimaryBrk = document.getElementById('spend-kpi-primary-brk');
    var kpiSecondaryBrk = document.getElementById('spend-kpi-secondary-brk');

    var basePeriodLbl;
    if (rangeMode === 'month') {
      basePeriodLbl = re.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ' spend';
    } else if (rangeMode === '30d') {
      basePeriodLbl = 'Last 30 days spend';
    } else if (rangeMode === '90d') {
      basePeriodLbl = 'Last 90 days spend';
    } else if (rangeMode === 'ytd') {
      basePeriodLbl = 'Year-to-date spend';
    } else {
      basePeriodLbl = 'All-time spend';
    }

    if (kpiPrimaryLbl) {
      if (costType === 'fixed') kpiPrimaryLbl.textContent = basePeriodLbl + ' (fixed recurring)';
      else if (costType === 'variable') kpiPrimaryLbl.textContent = basePeriodLbl + ' (one-time)';
      else kpiPrimaryLbl.textContent = basePeriodLbl;
    }
    if (kpiSecondaryLbl) {
      if (costType === 'fixed') {
        kpiSecondaryLbl.textContent = 'Prior period (fixed) · ' + fmtDateDisplay(pr.start) + ' – ' + fmtDateDisplay(pr.end);
      } else if (costType === 'variable') {
        kpiSecondaryLbl.textContent = 'Prior period (one-time) · ' + fmtDateDisplay(pr.start) + ' – ' + fmtDateDisplay(pr.end);
      } else {
        kpiSecondaryLbl.textContent = 'Prior period · ' + fmtDateDisplay(pr.start) + ' – ' + fmtDateDisplay(pr.end);
      }
    }
    if (kpiPrimaryVal) kpiPrimaryVal.innerHTML = spendFormatKpiSplit(periodTotal);
    if (kpiSecondaryVal) kpiSecondaryVal.innerHTML = spendFormatKpiSplit(priorTotal);

    if (kpiPrimaryBrk) {
      if (costType === 'all' && !useIndexAxis) {
        kpiPrimaryBrk.textContent = 'Fixed ' + fmtCurrencyPrecise(periodTotalFixed) + ' · One-time ' + fmtCurrencyPrecise(periodTotalVar);
        kpiPrimaryBrk.style.display = 'block';
      } else {
        kpiPrimaryBrk.textContent = '';
        kpiPrimaryBrk.style.display = 'none';
      }
    }
    if (kpiSecondaryBrk) {
      if (costType === 'all' && !useIndexAxis) {
        kpiSecondaryBrk.textContent = 'Fixed ' + fmtCurrencyPrecise(priorTotalFixed) + ' · One-time ' + fmtCurrencyPrecise(priorTotalVar);
        kpiSecondaryBrk.style.display = 'block';
      } else {
        kpiSecondaryBrk.textContent = '';
        kpiSecondaryBrk.style.display = 'none';
      }
    }

    spendReportCsvPayload = {
      labels: shortLabels.slice(),
      titles: spendReportTooltipTitles.slice(),
      costType: costType,
      values: dataVals.slice(),
      valuesFixed: dataValsFixed.slice(),
      valuesVariable: dataValsVar.slice(),
    };

    var avgRef = dataVals.length ? dataVals.reduce(function (a, b) { return a + b; }, 0) / dataVals.length : 0;
    avgRef = Math.round(avgRef * 100) / 100;
    var refLine = keys.map(function () { return avgRef; });

    var gridMuted = CHART_GRID;
    var axisTick = CHART_TICK;
    var lineStroke = CHART_ORANGE;
    var lineFill = CHART_ORANGE_FILL;
    var lineVarStroke = '#52525b';
    var lineVarFill = 'rgba(82, 82, 91, 0.12)';
    var refStroke = 'rgba(0,0,0,0.12)';

    if (spendTrendChart) {
      spendTrendChart.destroy();
      spendTrendChart = null;
    }

    var stackedMode = costType === 'all';
    var commonPlugins = {
      legend: {
        display: stackedMode,
        position: 'bottom',
        labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, color: axisTick },
      },
      tooltip: {
        backgroundColor: '#ffffff',
        titleColor: '#0a0a0a',
        bodyColor: '#52525b',
        borderColor: 'rgba(0,0,0,0.08)',
        borderWidth: 1,
        padding: 10,
        cornerRadius: 6,
        displayColors: true,
        filter: function (item) {
          if (stackedMode) return item.datasetIndex <= 1;
          return item.datasetIndex === 0;
        },
        callbacks: {
          title: function (items) {
            var i = items[0].dataIndex;
            return spendReportTooltipTitles[i] || shortLabels[i] || '';
          },
          label: function (ctx) {
            var y = ctx.parsed.y != null ? ctx.parsed.y : ctx.parsed;
            return (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + fmtCurrencyPrecise(y);
          },
          footer: function (items) {
            if (!stackedMode || !items.length) return '';
            var i = items[0].dataIndex;
            var t = round2((dataValsFixed[i] || 0) + (dataValsVar[i] || 0));
            return 'Total: ' + fmtCurrencyPrecise(t);
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
          stacked: stackedMode,
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
      var barDatasets;
      if (stackedMode) {
        barDatasets = [
          {
            type: 'bar',
            label: 'Fixed (recurring)',
            data: dataValsFixed,
            stack: 'spend',
            backgroundColor: CHART_ORANGE_FILL_BAR,
            borderColor: CHART_ORANGE_BORDER_BAR,
            borderWidth: 1,
            borderRadius: { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 },
            order: 3,
          },
          {
            type: 'bar',
            label: 'One-time',
            data: dataValsVar,
            stack: 'spend',
            backgroundColor: 'rgba(82, 82, 91, 0.28)',
            borderColor: 'rgba(63,63,70,0.45)',
            borderWidth: 1,
            borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
            order: 3,
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
        ];
      } else {
        barDatasets = [
          {
            type: 'bar',
            label: 'Spend',
            data: dataVals,
            backgroundColor: CHART_ORANGE_FILL_BAR,
            borderColor: CHART_ORANGE_BORDER_BAR,
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
        ];
      }
      spendTrendChart = new Chart(canvas, {
        type: 'bar',
        data: { labels: shortLabels, datasets: barDatasets },
        options: Object.assign({ plugins: commonPlugins }, commonOptions),
      });
    } else {
      var lineDatasets;
      if (stackedMode) {
        lineDatasets = [
          {
            type: 'line',
            label: 'Fixed (recurring)',
            data: dataValsFixed,
            stack: 'spend',
            borderColor: lineStroke,
            backgroundColor: lineFill,
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: CHART_ORANGE,
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
            order: 3,
          },
          {
            type: 'line',
            label: 'One-time',
            data: dataValsVar,
            stack: 'spend',
            borderColor: lineVarStroke,
            backgroundColor: lineVarFill,
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: lineVarStroke,
            pointHoverBorderColor: '#ffffff',
            pointHoverBorderWidth: 2,
            order: 3,
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
        ];
      } else {
        lineDatasets = [
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
            pointHoverBackgroundColor: CHART_ORANGE,
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
        ];
      }
      spendTrendChart = new Chart(canvas, {
        type: 'line',
        data: { labels: shortLabels, datasets: lineDatasets },
        options: Object.assign({ plugins: commonPlugins }, commonOptions),
      });
    }

    var lineBtn = document.getElementById('spend-chart-line');
    var barBtn = document.getElementById('spend-chart-bar');
    if (lineBtn) lineBtn.classList.toggle('on', chartType === 'line');
    if (barBtn) barBtn.classList.toggle('on', chartType === 'bar');
  }

  function wireSettingsSave() {
    // Populate budget inputs from saved state
    function populateBudgetInputs() {
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        var el = document.getElementById('budget-input-' + k);
        if (el && budgets[k] > 0) el.value = budgets[k];
      });
    }
    populateBudgetInputs();
    var accentInput = document.getElementById('setting-accent');
    var accentHexInput = document.getElementById('setting-accent-hex');
    if (accentInput) {
      var accentPresets = document.getElementById('setting-accent-presets');
      function accentHexNow() {
        return parseAccentHexOrNull(accentHexInput && accentHexInput.value) || normalizeHexColor(accentInput.value, '#e8501a');
      }
      function syncAccentFieldsAndApply(hex) {
        var h = normalizeHexColor(hex, '#e8501a');
        accentInput.value = h;
        if (accentHexInput) accentHexInput.value = h;
        syncAccentPresetSwatches(h);
        applyAccentBranding(h);
        if (state.computed) {
          renderAll();
          renderProjects();
        }
      }
      if (accentHexInput && !accentHexInput.value.trim()) {
        accentHexInput.value = normalizeHexColor(accentInput.value, '#e8501a');
      }
      syncAccentFieldsAndApply(accentHexNow());
      if (accentPresets) {
        accentPresets.addEventListener('click', function (ev) {
          var t = ev.target && ev.target.closest ? ev.target.closest('[data-accent-preset]') : null;
          if (!t || !accentPresets.contains(t)) return;
          var raw = t.getAttribute('data-accent-preset');
          var p = parseAccentHexOrNull(raw) || normalizeHexColor(raw, '#e8501a');
          syncAccentFieldsAndApply(p);
        });
      }
    }

    function readBudgetInputsIntoState() {
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        var el = document.getElementById('budget-input-' + k);
        if (el) budgets[k] = Math.max(0, parseFloat(el.value) || 0);
      });
    }

    async function syncBudgetsNow() {
      readBudgetInputsIntoState();
      saveBudgets(budgets);
      recomputeAndRender();
      await persistAppSettingsToSupabase({ includeDashboard: true });
    }

    async function uploadBrandLogoInput(inputId, variant) {
      var input = document.getElementById(inputId);
      if (!input || !input.files || !input.files.length) return '';
      supabase = window.supabaseClient || supabase;
      currentUser = window.currentUser || currentUser;
      if (!supabase || !currentUser) return '';
      var file = input.files[0];
      var ext = (String(file.name || '').split('.').pop() || 'png').toLowerCase();
      var path = (getCurrentOrgId() || currentUser.id) + '/' + variant + '-' + Date.now() + '.' + ext;
      var upload = await supabase.storage.from('brand-assets').upload(path, file, { upsert: true, cacheControl: '3600' });
      if (upload.error) throw upload.error;
      var signed = await supabase.storage.from('brand-assets').createSignedUrl(path, BRAND_LOGO_SIGNED_URL_TTL_SEC);
      if (signed.error) throw signed.error;
      return signed.data && signed.data.signedUrl ? signed.data.signedUrl : '';
    }

    function wireLogoPreviewInput(inputId, variant) {
      var input = document.getElementById(inputId);
      if (!input) return;
      input.addEventListener('change', function () {
        if (!input.files || !input.files.length) return;
        var file = input.files[0];
        if (!file || String(file.type || '').indexOf('image/') !== 0) return;
        var previewUrl = URL.createObjectURL(file);
        if (variant === 'light') applyBrandLogo(previewUrl, '');
        else applyBrandLogo('', previewUrl);
      });
    }

    wireLogoPreviewInput('setting-logo-light', 'light');
    wireLogoPreviewInput('setting-logo-dark', 'dark');

    ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
      var el = document.getElementById('budget-input-' + k);
      if (!el) return;
      el.addEventListener('change', function () {
        syncBudgetsNow();
      });
    });

    var saveBtn = document.getElementById('btn-save-settings');
    if (saveBtn) {
      var saveLabelDefault = 'Save changes';
      saveBtn.addEventListener('click', async function () {
        if (saveBtn.disabled) return;
        saveBtn.classList.remove('is-saved');
        saveBtn.classList.add('is-saving');
        saveBtn.disabled = true;
        saveBtn.setAttribute('aria-busy', 'true');
        saveBtn.textContent = 'Saving…';
        var brandImg = document.getElementById('sb-brand-img');
        var lightUrl = brandImg && brandImg.getAttribute('data-logo-light') ? String(brandImg.getAttribute('data-logo-light')) : '';
        var darkUrl = brandImg && brandImg.getAttribute('data-logo-dark') ? String(brandImg.getAttribute('data-logo-dark')) : '';
        try {
          try {
            var nextLight = await uploadBrandLogoInput('setting-logo-light', 'light');
            var nextDark = await uploadBrandLogoInput('setting-logo-dark', 'dark');
            if (nextLight) lightUrl = nextLight;
            if (nextDark) darkUrl = nextDark;
          } catch (e) {
            console.warn('brand logo upload failed', e);
            alert('Logo upload failed. Check brand-assets storage bucket and policies, then try again.');
          }
          applyBrandLogo(lightUrl, darkUrl);
          syncProfilePanelToPrefs();
          await persistProfileUserMetadata();
          await persistWorkspaceOrganizationName();
          await syncBudgetsNow();
          await flushPersistUserUiPreferences();
          saveBtn.classList.remove('is-saving');
          saveBtn.classList.add('is-saved');
          saveBtn.textContent = 'Saved!';
          saveBtn.removeAttribute('aria-busy');
          setTimeout(function () {
            saveBtn.textContent = saveLabelDefault;
            saveBtn.classList.remove('is-saved');
            saveBtn.disabled = false;
          }, 1600);
        } catch (err) {
          console.error('save settings failed', err);
          saveBtn.classList.remove('is-saving');
          saveBtn.textContent = saveLabelDefault;
          saveBtn.disabled = false;
          saveBtn.removeAttribute('aria-busy');
          alert('Could not save settings. Please check your connection and try again.');
        }
      });
    }

    function wirePreferencesPanel() {
      var root = document.getElementById('page-settings');
      if (!root || root.getAttribute('data-pref-wired') === '1') return;
      if (!document.getElementById('pref-theme')) return;
      root.setAttribute('data-pref-wired', '1');
      ensurePreferenceTimezoneOptionsBuilt();
      function bumpRuntime() {
        applyPreferencesRuntime(readPreferencesFromDom());
      }
      ['pref-theme', 'pref-language', 'pref-number-format', 'pref-date-mention-format', 'pref-week-starts-mon', 'pref-timezone-auto', 'pref-timezone'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', function () {
          if (id === 'pref-timezone-auto') {
            var autoOn = !!(document.getElementById('pref-timezone-auto') && document.getElementById('pref-timezone-auto').checked);
            setPrefTimezoneComboboxInteractive(!autoOn);
          }
          if (id === 'pref-week-starts-mon') {
            syncProfileWeekSelectFromMainCheckbox();
          }
          bumpRuntime();
          ensureUserUiPrefsCache();
          schedulePersistUserUiPreferences();
        });
      });
      bumpRuntime();
    }
    wirePreferencesPanel();
  }

  var connDetailEscHandler = null;

  function bizdashCloseConnDetailSubmodal() {
    var root = document.getElementById('conn-detail-submodal');
    if (!root) return;
    root.classList.remove('on');
    root.setAttribute('aria-hidden', 'true');
    var bd = document.getElementById('conn-detail-backdrop');
    if (bd) bd.setAttribute('aria-hidden', 'true');
    ['conn-detail-pane-gmail', 'conn-detail-pane-calendar', 'conn-detail-pane-stripe'].forEach(function (id) {
      var p = document.getElementById(id);
      if (p) p.hidden = true;
    });
    if (connDetailEscHandler) {
      document.removeEventListener('keydown', connDetailEscHandler);
      connDetailEscHandler = null;
    }
  }

  function bizdashOpenConnDetailSubmodal(which) {
    var root = document.getElementById('conn-detail-submodal');
    if (!root) return;
    if (which !== 'gmail' && which !== 'calendar' && which !== 'stripe') return;
    var titleEl = document.getElementById('conn-detail-title');
    var titles = { gmail: 'Gmail', calendar: 'Google Calendar', stripe: 'Stripe' };
    if (titleEl) titleEl.textContent = titles[which] || which;
    var pg = document.getElementById('conn-detail-pane-gmail');
    var pc = document.getElementById('conn-detail-pane-calendar');
    var ps = document.getElementById('conn-detail-pane-stripe');
    if (pg) pg.hidden = which !== 'gmail';
    if (pc) pc.hidden = which !== 'calendar';
    if (ps) ps.hidden = which !== 'stripe';
    root.classList.add('on');
    root.setAttribute('aria-hidden', 'false');
    var backdrop = document.getElementById('conn-detail-backdrop');
    if (backdrop) backdrop.setAttribute('aria-hidden', 'false');
    if (which === 'stripe') refreshStripeConnectPanel();
    if (!connDetailEscHandler) {
      connDetailEscHandler = function (e) {
        if (e.key === 'Escape' && root.classList.contains('on')) {
          e.preventDefault();
          bizdashCloseConnDetailSubmodal();
        }
      };
      document.addEventListener('keydown', connDetailEscHandler);
    }
  }

  window.bizdashCloseConnDetailSubmodal = bizdashCloseConnDetailSubmodal;
  window.bizdashOpenConnDetailSubmodal = bizdashOpenConnDetailSubmodal;

  function wireSettingsShell() {
    var root = document.getElementById('page-settings');
    if (!root || root.getAttribute('data-settings-shell-wired') === '1') return;
    root.setAttribute('data-settings-shell-wired', '1');

    var filterInput = document.getElementById('settings-nav-filter');
    var activeTitle = document.getElementById('settings-active-title');
    var activeDesc = document.getElementById('settings-active-desc');
    var activeKicker = document.getElementById('settings-active-kicker');
    var navItems = root.querySelectorAll('.settings-nav-item');

    function applyNavFilter() {
      var q = (filterInput && filterInput.value ? String(filterInput.value) : '').trim().toLowerCase();
      if (!q) {
        root.querySelectorAll('.settings-nav-group').forEach(function (g) {
          var title = g.querySelector('.settings-nav-group-title');
          g.querySelectorAll('.settings-nav-item').forEach(function (item) {
            item.style.display = '';
          });
          if (title) title.style.display = '';
        });
        return;
      }
      root.querySelectorAll('.settings-nav-group').forEach(function (g) {
        var title = g.querySelector('.settings-nav-group-title');
        var items = g.querySelectorAll('.settings-nav-item');
        var visibleCount = 0;
        items.forEach(function (item) {
          var label = (item.getAttribute('data-settings-title') || '') + ' ' + (item.textContent || '');
          label = label.toLowerCase();
          var match = label.indexOf(q) !== -1;
          item.style.display = match ? '' : 'none';
          if (match) visibleCount++;
        });
        if (title) title.style.display = visibleCount ? '' : 'none';
      });
    }

    function setSettingsPanel(panelId, openerBtn) {
      if (!panelId) return;
      navItems.forEach(function (btn) {
        var id = btn.getAttribute('data-settings-panel');
        var on = id === panelId;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      root.querySelectorAll('.settings-panel').forEach(function (p) {
        var pid = p.getAttribute('data-settings-panel-id');
        p.classList.toggle('on', pid === panelId);
      });
      var opener =
        openerBtn || root.querySelector('.settings-nav-item[data-settings-panel="' + panelId + '"]');
      if (!opener) return;
      if (activeTitle) activeTitle.textContent = opener.getAttribute('data-settings-title') || '';
      if (activeDesc) {
        if (panelId === 'people') {
          activeDesc.innerHTML =
            'Manage people in your workspace and their roles. <a href="#" id="settings-people-learn-inline" style="color:var(--coral);font-weight:500;text-decoration:none;">Learn more</a>';
        } else if (panelId === 'refer-earn') {
          activeDesc.innerHTML =
            'Earn rewards by referring teams to Compass. <a href="#" id="settings-refer-learn" style="color:var(--coral);font-weight:500;text-decoration:none;">Learn more</a>';
        } else {
          activeDesc.textContent = opener.getAttribute('data-settings-desc') || '';
        }
      }
      if (activeKicker) activeKicker.textContent = opener.getAttribute('data-settings-kicker') || '';
      var saveBtn = document.getElementById('btn-save-settings');
      var dirLink = document.getElementById('settings-people-directory-link');
      if (saveBtn) {
        saveBtn.style.display =
          panelId === 'people' || panelId === 'refer-earn' || panelId === 'connections' || panelId === 'pages'
            ? 'none'
            : '';
      }
      if (dirLink) dirLink.style.display = panelId === 'people' ? 'inline-flex' : 'none';
      if (panelId === 'account') refreshAccountSecurityUiFromServer();
      if (panelId === 'workspace') hydrateWorkspaceSettingsFields();
      if (panelId === 'people' && typeof window.refreshTeamPage === 'function') {
        window.refreshTeamPage();
      }
      if (panelId === 'refer-earn' && typeof window.refreshReferEarnPanel === 'function') {
        window.refreshReferEarnPanel();
      }
      if (panelId === 'connections') {
        refreshConnectionsPanel();
        refreshStripeConnectPanel();
      }
      if (panelId === 'profile') {
        syncPrefsToProfilePanel();
        refreshAccountSecurityUiFromServer();
      }
      if (panelId === 'pages') {
        renderSettingsPagesPanel();
      }
      if (panelId !== 'connections') {
        bizdashCloseConnDetailSubmodal();
      }
    }

    navItems.forEach(function (btn) {
      btn.setAttribute('role', 'tab');
      var pid = btn.getAttribute('data-settings-panel');
      if (pid) btn.setAttribute('aria-controls', 'settings-panel-' + pid);
      btn.setAttribute('aria-selected', btn.classList.contains('on') ? 'true' : 'false');
      btn.addEventListener('click', function () {
        setSettingsPanel(btn.getAttribute('data-settings-panel'), btn);
      });
    });

    if (filterInput) {
      filterInput.addEventListener('input', function () {
        applyNavFilter();
      });
    }

    var initial = root.querySelector('.settings-nav-item.on');
    setSettingsPanel(
      (initial && initial.getAttribute('data-settings-panel')) || 'general',
      initial
    );

    var back = document.getElementById('settings-btn-back');
    if (back && back.getAttribute('data-settings-back-wired') !== '1') {
      back.setAttribute('data-settings-back-wired', '1');
      back.addEventListener('click', function () {
        var dash = document.querySelector('.ni[data-nav="dashboard"]');
        if (typeof window.nav === 'function') window.nav('dashboard', dash || null);
      });
    }

    function openConnectionsScrollTo(subSectionId) {
      var c = document.getElementById('settings-nav-connections');
      if (c) c.click();
      if (!subSectionId) return;
      window.requestAnimationFrame(function () {
        window.setTimeout(function () {
          if (subSectionId === 'conn-section-stripe') {
            bizdashOpenConnDetailSubmodal('stripe');
            return;
          }
          if (subSectionId === 'conn-section-google') {
            bizdashOpenConnDetailSubmodal('gmail');
            return;
          }
          if (subSectionId === 'gmail' || subSectionId === 'calendar' || subSectionId === 'stripe') {
            bizdashOpenConnDetailSubmodal(subSectionId);
            return;
          }
          var el = document.getElementById(subSectionId);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
      });
    }

    var jumpMc = document.getElementById('settings-jump-mail-calendar');
    if (jumpMc && jumpMc.getAttribute('data-settings-jump-mc-wired') !== '1') {
      jumpMc.setAttribute('data-settings-jump-mc-wired', '1');
      jumpMc.addEventListener('click', function () {
        if (typeof window.nav === 'function') {
          window.nav('settings', document.querySelector('.ni[data-nav="settings"]'));
        }
        window.setTimeout(function () {
          openConnectionsScrollTo('conn-section-google');
        }, 120);
      });
    }

    var connBack = document.getElementById('conn-back-to-general');
    if (connBack && connBack.getAttribute('data-conn-back-wired') !== '1') {
      connBack.setAttribute('data-conn-back-wired', '1');
      connBack.addEventListener('click', function () {
        var g = document.getElementById('settings-nav-general');
        if (g) g.click();
      });
    }

    var connDetailBd = document.getElementById('conn-detail-backdrop');
    if (connDetailBd && connDetailBd.getAttribute('data-conn-detail-bd-wired') !== '1') {
      connDetailBd.setAttribute('data-conn-detail-bd-wired', '1');
      connDetailBd.addEventListener('click', function () {
        bizdashCloseConnDetailSubmodal();
      });
    }
    var connDetailClose = document.getElementById('conn-detail-close');
    if (connDetailClose && connDetailClose.getAttribute('data-conn-detail-close-wired') !== '1') {
      connDetailClose.setAttribute('data-conn-detail-close-wired', '1');
      connDetailClose.addEventListener('click', function () {
        bizdashCloseConnDetailSubmodal();
      });
    }

    document.querySelectorAll('.conn-app-card[data-conn-sub]').forEach(function (card) {
      if (card.getAttribute('data-conn-card-wired') === '1') return;
      card.setAttribute('data-conn-card-wired', '1');
      card.addEventListener('click', function () {
        var sub = (card.getAttribute('data-conn-sub') || '').trim();
        if (!sub) return;
        if (sub === 'gmail' || sub === 'calendar' || sub === 'stripe') {
          bizdashOpenConnDetailSubmodal(sub);
          return;
        }
        var nav = document.querySelector('.settings-nav-item[data-settings-panel="' + sub + '"]');
        if (nav) nav.click();
      });
    });

    wireSettingsPagesPanel();
  }

  async function refreshConnectionsPanel() {
    var gmailCard = document.getElementById('conn-card-gmail');
    var calCard = document.getElementById('conn-card-gcalendar');
    var stripeCard = document.getElementById('conn-card-stripe');
    if (!gmailCard || !calCard || !stripeCard) return;

    function setRow(card, on) {
      card.classList.toggle('conn-app-card--on', !!on);
      var nm = (card.querySelector('.conn-app-card-name') || {}).textContent || 'App';
      card.setAttribute('aria-label', nm + (on ? ', connected' : ', not connected'));
    }

    var sb = window.supabaseClient;
    var org = getCurrentOrgId();
    if (!sb || !org) {
      setRow(gmailCard, false);
      setRow(calCard, false);
      setRow(stripeCard, false);
      return;
    }
    var sessRes = await sb.auth.getSession();
    var sess = sessRes && sessRes.data ? sessRes.data.session : null;
    if (!sess || !sess.access_token) {
      setRow(gmailCard, false);
      setRow(calCard, false);
      setRow(stripeCard, false);
      return;
    }
    var base = typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
    var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey.trim() : '';
    if (!base || !anon) return;
    var res = await fetch(base + '/functions/v1/integration-connection-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + sess.access_token,
        apikey: anon,
      },
      body: JSON.stringify({ organizationId: org }),
    });
    var j = {};
    try {
      j = await res.json();
    } catch (_) {}
    if (!res.ok) {
      setRow(gmailCard, false);
      setRow(calCard, false);
      setRow(stripeCard, false);
      return;
    }
    setRow(gmailCard, !!j.gmail);
    setRow(calCard, !!j.google_calendar);
    setRow(stripeCard, !!j.stripe);
  }

  async function refreshStripeConnectPanel() {
    var el = document.getElementById('stripe-connect-status');
    var btnStart = document.getElementById('btn-stripe-connect-start');
    var sb = window.supabaseClient;
    var org = getCurrentOrgId();
    try {
      if (!el) return;
      if (!sb || !org) {
        el.textContent = 'Sign in and open a workspace to manage Stripe.';
        if (btnStart) btnStart.disabled = true;
        return;
      }
      if (btnStart) btnStart.disabled = false;
      el.textContent = 'Loading…';
      var result = await sb.from('organization_stripe_connections').select('*').eq('organization_id', org).maybeSingle();
      if (result.error) {
        el.textContent =
          'Could not load Stripe status. For new installs, run supabase/organization_stripe_connect.sql in the Supabase SQL editor. ' +
          formatSupabaseErr(result.error);
        return;
      }
      var data = result.data;
      if (!data) {
        el.innerHTML =
          '<strong>Not connected.</strong> Invoice <strong>Pay now</strong> is disabled until an owner or admin completes Stripe Connect.';
        if (btnStart) btnStart.textContent = 'Connect Stripe';
        return;
      }
      var ch = data.charges_enabled ? 'yes' : 'no';
      var py = data.payouts_enabled ? 'yes' : 'no';
      var st = data.connect_status || 'pending';
      el.innerHTML =
        '<div><strong>Stripe account</strong> ' +
        esc(String(data.stripe_account_id || '—')) +
        '</div>' +
        '<div style="margin-top:6px;"><strong>Dashboard status</strong> ' +
        esc(st) +
        ' · charges ' +
        ch +
        ' · payouts ' +
        py +
        '</div>';
      if (btnStart) {
        btnStart.textContent =
          data.charges_enabled && data.payouts_enabled ? 'Open Stripe onboarding again' : 'Continue Stripe setup';
      }
    } finally {
      var connPanel = document.getElementById('settings-panel-connections');
      if (connPanel && connPanel.classList.contains('on')) {
        refreshConnectionsPanel();
      }
    }
  }

  function consumeStripeSettingsReturnFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var stripeReturn = (params.get('stripe_return') || '').trim();
      var stripeRefresh = (params.get('stripe_refresh') || '').trim();
      var stripePanel = (params.get('stripe_panel') || '').trim();
      if (!stripeReturn && !stripeRefresh && stripePanel !== 'stripe') return;

      params.delete('stripe_return');
      params.delete('stripe_refresh');
      params.delete('stripe_panel');
      params.delete('settings');
      var qs = params.toString();
      var path = window.location.pathname || '/';
      window.history.replaceState(null, '', path + (qs ? '?' + qs : '') + (window.location.hash || ''));

      var bar = document.getElementById('app-invite-flash');
      var msg =
        stripeReturn === '1'
          ? 'Returned from Stripe. Status updates in a few seconds after webhooks process.'
          : stripeRefresh === '1'
            ? 'Stripe onboarding link was refreshed. Continue setup when you are ready.'
            : '';
      if (bar && msg) {
        bar.textContent = msg;
        bar.style.display = 'block';
        window.setTimeout(function () {
          bar.style.display = 'none';
          bar.textContent = '';
        }, 10000);
      }

      if (typeof window.nav === 'function') {
        window.nav('settings', document.querySelector('.ni[data-nav="settings"]'));
        var st = document.getElementById('settings-nav-connections');
        if (st) st.click();
        window.setTimeout(function () {
          bizdashOpenConnDetailSubmodal('stripe');
        }, 80);
      }
      window.setTimeout(function () {
        refreshStripeConnectPanel();
        refreshConnectionsPanel();
      }, 800);
    } catch (_) {}
  }

  /** Human-readable reason when Edge returns !ok or JSON without {url} (no secrets / tokens). */
  function bizdashDescribeEdgeFnFailure(res, text, j) {
    var status = res && typeof res.status === 'number' ? res.status : 0;
    var body = typeof text === 'string' ? text : '';
    var o = j && typeof j === 'object' ? j : {};
    var direct = o.error || o.message || o.msg;
    if (direct) return String(direct);
    if (status === 404) {
      return (
        'This Supabase project does not expose this Edge Function (HTTP 404). Deploy it from the repo ' +
        '(e.g. supabase functions deploy oauth-google-start stripe-connect-start) and confirm VITE_SUPABASE_URL matches that project.'
      );
    }
    if (status === 401 || status === 403) {
      return (
        'Request was not authorized (HTTP ' +
        status +
        '). Try signing out and back in. For Stripe Connect you must be a workspace owner or admin.'
      );
    }
    if (status >= 500) {
      return (
        'Server error (HTTP ' +
        status +
        '). Check Supabase Edge Function logs and secrets (docs/SUPABASE_EDGE_INTEGRATIONS.md or docs/STRIPE_CONNECT.md).'
      );
    }
    var b0 = body.slice(0, 400).toLowerCase();
    if (b0.indexOf('<!doctype') === 0 || b0.indexOf('<html') !== -1) {
      return (
        'Received HTML instead of JSON (HTTP ' +
        status +
        '). Usually the function is not deployed or the Supabase URL in the app does not match the project where functions run.'
      );
    }
    if (body.trim()) return 'Unexpected response (HTTP ' + status + '): ' + body.slice(0, 220);
    return 'Empty response (HTTP ' + status + '). Check deployment and Supabase project URL.';
  }

  function wireStripeConnectInSettings() {
    var start = document.getElementById('btn-stripe-connect-start');
    var refBtn = document.getElementById('btn-stripe-connect-refresh');
    var disc = document.getElementById('btn-stripe-connect-disconnect');
    if (start && start.getAttribute('data-wired-stripe-connect') !== '1') {
      start.setAttribute('data-wired-stripe-connect', '1');
      start.addEventListener('click', async function () {
        var supa = window.supabaseClient;
        var sessRes = supa ? await supa.auth.getSession() : null;
        var sess = sessRes && sessRes.data ? sessRes.data.session : null;
        if (!sess || !sess.access_token) {
          alert('Sign in first.');
          return;
        }
        var base =
          typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
        var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey.trim() : '';
        var orgId = getCurrentOrgId();
        if (!base || !anon) {
          alert('Supabase URL or anon key is not configured in this app.');
          return;
        }
        if (!orgId) {
          alert('Open a workspace before connecting Stripe.');
          return;
        }
        var res = await fetch(base + '/functions/v1/stripe-connect-start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + sess.access_token,
            apikey: anon,
          },
          body: JSON.stringify({ organizationId: orgId }),
        });
        var _stripeText = '';
        try {
          _stripeText = await res.text();
        } catch (_tx) {}
        var j = {};
        try {
          j = _stripeText ? JSON.parse(_stripeText) : {};
        } catch (_) {}
        if (!res.ok || !j.url) {
          alert(bizdashDescribeEdgeFnFailure(res, _stripeText, j));
          return;
        }
        window.location.href = String(j.url);
      });
    }
    if (refBtn && refBtn.getAttribute('data-wired-stripe-connect') !== '1') {
      refBtn.setAttribute('data-wired-stripe-connect', '1');
      refBtn.addEventListener('click', function () {
        refreshStripeConnectPanel();
      });
    }
    if (disc && disc.getAttribute('data-wired-stripe-connect') !== '1') {
      disc.setAttribute('data-wired-stripe-connect', '1');
      disc.addEventListener('click', async function () {
        if (!confirm('Disconnect Stripe for this workspace? Invoice Pay now will stop until you connect again.')) return;
        var supa = window.supabaseClient;
        var sessRes = supa ? await supa.auth.getSession() : null;
        var sess = sessRes && sessRes.data ? sessRes.data.session : null;
        if (!sess || !sess.access_token) {
          alert('Sign in first.');
          return;
        }
        var base =
          typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
        var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey.trim() : '';
        var orgId = getCurrentOrgId();
        if (!base || !anon || !orgId) return;
        var res = await fetch(base + '/functions/v1/stripe-connect-disconnect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + sess.access_token,
            apikey: anon,
          },
          body: JSON.stringify({ organizationId: orgId }),
        });
        var j = {};
        try {
          j = await res.json();
        } catch (_) {}
        if (!res.ok) {
          alert(j.error ? String(j.error) : 'Disconnect failed.');
          return;
        }
        refreshStripeConnectPanel();
      });
    }
  }

  // #region agent log
  function __dbgOAuthIngest(payload) {
    fetch('http://127.0.0.1:7914/ingest/507d12bf-babb-4204-8816-34a6e29c9b5b', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '1266cb' },
      body: JSON.stringify({
        sessionId: '1266cb',
        location: payload.location,
        message: payload.message,
        data: payload.data,
        timestamp: Date.now(),
        hypothesisId: payload.hypothesisId,
        runId: payload.runId || 'pre-fix',
      }),
    }).catch(function () {});
  }
  // #endregion

  function updateGoogleOAuthRedirectHint() {
    var line = document.getElementById('bizdash-google-oauth-redirect-line');
    if (!line) return;
    var base =
      typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
    if (!base) {
      line.textContent =
        'Set VITE_SUPABASE_URL in your build. Error 401 invalid_client is fixed in Google Cloud: Web OAuth client, correct Client ID/secret in Supabase Edge secrets, and Authorized redirect URIs — see docs/SUPABASE_EDGE_INTEGRATIONS.md.';
      return;
    }
    var uri = base + '/functions/v1/oauth-google-callback';
    line.innerHTML =
      'In Google Cloud → Credentials → <strong>OAuth 2.0 Client ID</strong> (type <strong>Web application</strong>), under <strong>Authorized redirect URIs</strong>, add exactly: <code style="font-size:10px;word-break:break-all;">' +
      uri +
      '</code> Edge secrets <code style="font-size:11px;">GOOGLE_CLIENT_ID</code> and <code style="font-size:11px;">GOOGLE_CLIENT_SECRET</code> must be from <em>that same</em> client. <code style="font-size:11px;">invalid_client</code> means Google rejected the client ID or the redirect URI is not listed.';
  }

  function wireGoogleOAuthInSettings() {
    var nodes = document.querySelectorAll('[data-google-oauth-start]');
    if (!nodes.length) return;
    nodes.forEach(function (btn) {
      if (btn.getAttribute('data-wired-google-oauth') === '1') return;
      btn.setAttribute('data-wired-google-oauth', '1');
      btn.addEventListener('click', async function () {
        var supa = window.supabaseClient;
        var sessRes = supa ? await supa.auth.getSession() : null;
        var sess = sessRes && sessRes.data ? sessRes.data.session : null;
        if (!sess || !sess.access_token) {
          alert('Sign in first.');
          return;
        }
        var base = typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
        var anon = typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey.trim() : '';
        if (!base || !anon) {
          alert('Supabase URL or anon key is not configured in this app.');
          return;
        }
        var orgId = getCurrentOrgId();
        if (!orgId || !String(orgId).trim()) {
          alert('Open a workspace before connecting Google.');
          return;
        }
        var returnPath = window.location.pathname || '/';
        var res = await fetch(base + '/functions/v1/oauth-google-start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + sess.access_token,
            apikey: anon,
          },
          body: JSON.stringify({ organization_id: orgId, return_path: returnPath }),
        });
        var _gText = '';
        try {
          _gText = await res.text();
        } catch (_gt) {}
        var j = {};
        try {
          j = _gText ? JSON.parse(_gText) : {};
        } catch (_) {}
        if (!res.ok || !j.url) {
          // #region agent log
          __dbgOAuthIngest({
            location: 'financial-core.js:wireGoogleOAuthInSettings',
            message: 'oauth-google-start failed before redirect',
            hypothesisId: 'H4',
            data: {
              httpStatus: res.status,
              supabaseHost: base ? new URL(base).hostname : '',
              errSnippet: j && j.error ? String(j.error).slice(0, 120) : (_gText || '').slice(0, 120),
            },
          });
          // #endregion
          alert(bizdashDescribeEdgeFnFailure(res, _gText, j));
          return;
        }
        // #region agent log
        try {
          var authU = new URL(String(j.url));
          var cid = authU.searchParams.get('client_id') || '';
          var ruri = authU.searchParams.get('redirect_uri') || '';
          __dbgOAuthIngest({
            location: 'financial-core.js:wireGoogleOAuthInSettings',
            message: 'oauth-google-start ok; auth URL params',
            hypothesisId: 'H1',
            data: {
              supabaseHost: base ? new URL(base).hostname : '',
              clientIdLen: cid.length,
              clientIdLooksWeb: /\.apps\.googleusercontent\.com$/.test(cid),
              redirectUriFromAuthUrl: ruri ? decodeURIComponent(ruri) : '',
              redirectUriFromApi: j.redirect_uri ? String(j.redirect_uri) : null,
            },
          });
        } catch (_e) {
          __dbgOAuthIngest({
            location: 'financial-core.js:wireGoogleOAuthInSettings',
            message: 'parse auth URL failed',
            hypothesisId: 'H1',
            data: { err: String(_e && _e.message ? _e.message : _e) },
          });
        }
        // #endregion
        window.location.href = String(j.url);
      });
    });
  }

  /** After Google redirects back to APP_SITE_URL with ?oauth=… strip params and show status. */
  function consumeOAuthReturnFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var oauth = (params.get('oauth') || '').trim();
      if (!oauth) return;
      var provider = (params.get('provider') || '').trim();
      var detail = (params.get('detail') || '').trim();
      var googleErr = (params.get('google_error') || '').trim();
      // #region agent log
      __dbgOAuthIngest({
        location: 'financial-core.js:consumeOAuthReturnFromUrl',
        message: 'oauth query params after redirect to app',
        hypothesisId: 'H3',
        data: { oauth: oauth, provider: provider, detail: detail, google_error: googleErr || undefined },
      });
      // #endregion
      params.delete('oauth');
      params.delete('provider');
      params.delete('detail');
      params.delete('google_error');
      var qs = params.toString();
      var path = window.location.pathname || '/';
      window.history.replaceState(null, '', path + (qs ? '?' + qs : '') + (window.location.hash || ''));

      var fromOnboarding = false;
      try {
        fromOnboarding = sessionStorage.getItem('bizdash_oauth_from_onboarding') === '1';
        if (fromOnboarding) sessionStorage.removeItem('bizdash_oauth_from_onboarding');
      } catch (_) {}

      if (fromOnboarding) {
        try {
          sessionStorage.setItem('bizdash_post_oauth_onboard_resume', '1');
        } catch (_) {}
        if (typeof window.bizdashOnboardingOAuthDone === 'function') {
          window.bizdashOnboardingOAuthDone(oauth === 'ok', provider);
        }
        return;
      }

      var bar = document.getElementById('app-invite-flash');
      var msg = '';
      if (oauth === 'ok') {
        msg = provider ? 'Connected ' + provider + ' for this workspace.' : 'Connected.';
      } else {
        msg =
          'Could not complete sign-in' +
          (provider ? ' (' + provider + ')' : '') +
          (detail ? ': ' + detail : '') +
          (googleErr ? ' [' + googleErr + ']' : '') +
          '.';
      }
      if (bar && msg) {
        bar.textContent = msg;
        bar.style.display = 'block';
        window.setTimeout(function () {
          bar.style.display = 'none';
          bar.textContent = '';
        }, 12000);
      }
      if (typeof window.nav === 'function') {
        window.nav('settings', document.querySelector('.ni[data-nav="settings"]'));
        var connTab = document.getElementById('settings-nav-connections');
        if (connTab) {
          connTab.click();
          window.setTimeout(function () {
            bizdashOpenConnDetailSubmodal('gmail');
          }, 80);
        } else {
          var acctTab = document.getElementById('settings-nav-account');
          if (acctTab) acctTab.click();
        }
      }
      window.setTimeout(function () {
        refreshConnectionsPanel();
      }, 600);
    } catch (_) {}
  }

  function wireSpendingReport() {
    function syncFromDom() {
      var sl = document.getElementById('spend-slice');
      var rg = document.getElementById('spend-range');
      var iv = document.getElementById('spend-interval');
      var ct = document.getElementById('spend-cost-type');
      if (sl) spendReportUi.slice = sl.value || 'category';
      if (rg) spendReportUi.range = rg.value || '90d';
      if (iv) spendReportUi.interval = iv.value || 'weekly';
      if (ct) spendReportUi.costType = ct.value || 'all';
    }

    var sliceEl = document.getElementById('spend-slice');
    var rangeEl = document.getElementById('spend-range');
    var intEl = document.getElementById('spend-interval');
    var costTypeEl = document.getElementById('spend-cost-type');
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
    if (costTypeEl) {
      costTypeEl.addEventListener('change', function () {
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
        var rows;
        if (p.costType === 'all' && p.valuesFixed && p.valuesVariable) {
          rows = ['Period,Fixed recurring,One-time,Total'];
          for (var i = 0; i < p.labels.length; i++) {
            var lab = String(p.titles && p.titles[i] != null ? p.titles[i] : p.labels[i]).replace(/"/g, '""');
            var f = p.valuesFixed[i] != null ? p.valuesFixed[i] : 0;
            var v = p.valuesVariable[i] != null ? p.valuesVariable[i] : 0;
            var tot = Math.round((Number(f) + Number(v)) * 100) / 100;
            rows.push('"' + lab + '",' + f + ',' + v + ',' + tot);
          }
        } else {
          rows = ['Period,Amount'];
          for (var j = 0; j < p.labels.length; j++) {
            var lab2 = String(p.titles && p.titles[j] != null ? p.titles[j] : p.labels[j]).replace(/"/g, '""');
            rows.push('"' + lab2 + '",' + (p.values[j] != null ? p.values[j] : 0));
          }
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

  /** Live recap for Personable CRM “Latest summary” (same metrics as the former Monday/Friday buttons). */
  function buildDashboardRecapText() {
    var c = state.computed || compute({ mode: 'all', start: null, end: null });
    var openInvoices = invoices.filter(function (i) { return i && i.status !== 'paid'; }).length;
    var doneProjects = projects.filter(function (p) { return p && String(p.status || '').toLowerCase().indexOf('complete') !== -1; }).length;
    return (
      'Business recap: Revenue ' +
      fmtCurrency(c.revenueTotal || 0) +
      ', expenses ' +
      fmtCurrency(c.expenseTotal || 0) +
      ', net profit ' +
      fmtCurrency(c.netProfit || 0) +
      ', open invoices ' +
      openInvoices +
      ', delivered projects ' +
      doneProjects +
      '.'
    );
  }

  function wirePersonableActions() {
    var dash = $('page-dashboard');
    if (dash && dash.getAttribute('data-crm-wire') !== '1') {
      dash.setAttribute('data-crm-wire', '1');
      dash.addEventListener('click', async function (ev) {
        var done = ev.target.closest('[data-suggestion-done]');
        if (done) {
          done.disabled = true;
          await addCrmEvent('suggestion_done', 'Follow-up suggestion completed', {}, null, 'suggestion:' + Date.now() + ':' + done.getAttribute('data-suggestion-done'));
          renderPersonableCards();
          return;
        }
      });
    }
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
      setKpiBadge('kpi-ar-badge', '—', 'neutral');
      var arBadge0 = $('kpi-ar-badge');
      if (arBadge0) {
        arBadge0.title = 'Outstanding AR is a snapshot; comparing to a prior period would require saved history.';
      }
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
    setKpiBadge('kpi-ar-badge', '—', 'neutral');
    var arBadge = $('kpi-ar-badge');
    if (arBadge) {
      arBadge.title = 'Outstanding AR is a snapshot; comparing to a prior period would require saved history.';
    }
  }

  function renderAll() {
    var c = state.computed;
    if (!c) return;
    renderKPIs(c);
    renderExpenseChart(c);
    renderIncomeStatement(c);
    renderTransactionLog(c);
    renderExpensesTable(c);
    renderBudgetVsActual();
    renderSpendingReport();
    renderRevenueVsExpenses(c);
    renderIncomeSection(c);
    renderRevenueByVertical(c);
    renderInsights();
    renderMarketing();
    renderDashAR();
    renderClients();
    renderRetention();
    renderTimesheet();
    renderPersonableCards();
    var pgTasks = document.getElementById('page-tasks');
    if (pgTasks && pgTasks.classList.contains('on')) renderTasksPage();
    var pgSet = document.getElementById('page-settings');
    if (pgSet && pgSet.classList.contains('on')) renderAutomationSettings();
  }

  function renderPersonableCards() {
    var now = new Date();
    var hh = now.getHours();
    var sal = hh < 12 ? 'Good morning' : (hh < 18 ? 'Good afternoon' : 'Good evening');
    var owner = ($('setting-owner') && $('setting-owner').value ? $('setting-owner').value.trim() : '') || 'there';
    setText('crm-welcome', sal + ', ' + owner.split(' ')[0]);
    setText('crm-local-date', now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));

    var tgIn = $('setting-tagline');
    var tagOut = $('dash-brand-tagline');
    if (tagOut && tgIn) {
      var tgx = String(tgIn.value || '').trim();
      if (tgx) {
        tagOut.textContent = tgx;
        tagOut.style.display = 'block';
      } else {
        tagOut.textContent = '';
        tagOut.style.display = 'none';
      }
    }

    var reminders = [];
    clients.forEach(function (c) {
      if (!c || !c.lastTouchAt) return;
      var d = new Date(c.lastTouchAt + 'T12:00:00');
      if (isNaN(d.getTime())) return;
      var days = Math.floor((now - d) / 86400000);
      if (days >= 30) reminders.push({ client: c, text: days + ' days since last outreach' });
    });
    var remEl = $('crm-reminders-list');
    if (remEl) {
      remEl.innerHTML = reminders.length ? reminders.slice(0, 6).map(function (r) {
        return '<div class="kb bn" style="padding:8px 10px;background:var(--bg2);">' + esc(r.client.companyName || 'Client') + ': ' + esc(r.text) + '</div>';
      }).join('') : '<div style="font-size:13px;color:var(--text3);">No overdue follow-ups right now.</div>';
    }

    var suggestions = [];
    clients.forEach(function (c) {
      if (!c) return;
      if (c.lastTouchAt) {
        var daysSince = Math.floor((now - new Date(c.lastTouchAt + 'T12:00:00')) / 86400000);
        if (daysSince > 30) suggestions.push({ c: c, text: 'Send a quick check-in via ' + (c.preferredChannel || 'email') + '.' });
      }
      var overdue = invoices.some(function (inv) { return inv && inv.status !== 'paid' && inv.dueDate && (new Date(inv.dueDate) < now); });
      if (overdue && c.preferredChannel) suggestions.push({ c: c, text: 'Overdue invoice: follow up on ' + c.preferredChannel + '.' });
      var completed = projects.some(function (p) { return p && p.clientId === c.id && String(p.status || '').toLowerCase().indexOf('complete') !== -1; });
      if (completed) suggestions.push({ c: c, text: 'Ask for a testimonial for the delivered project.' });
    });
    var sugEl = $('crm-suggestions-list');
    if (sugEl) {
      sugEl.innerHTML = suggestions.length ? suggestions.slice(0, 5).map(function (s, idx) {
        return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--border);border-radius:10px;">' +
          '<div style="font-size:13px;color:var(--text2);"><strong style="color:var(--text);">' + esc(s.c.companyName || 'Client') + '</strong> - ' + esc(s.text) + '</div>' +
          '<button type="button" class="btn" data-suggestion-done="' + idx + '">Done</button>' +
        '</div>';
      }).join('') : '<div style="font-size:13px;color:var(--text3);">No suggestions for now.</div>';
    }

    var milestones = [];
    var firstPaid = invoices.filter(function (x) { return x && x.status === 'paid'; }).sort(function (a, b) { return String(a.paidAt || '').localeCompare(String(b.paidAt || '')); })[0];
    if (firstPaid) {
      milestones.push('First paid invoice: #' + (firstPaid.number || '—'));
      addCrmEvent('milestone', 'First paid invoice', { invoiceNumber: firstPaid.number || '' }, null, 'milestone:first-paid');
    }
    var monthMap = {};
    (state.transactions || []).forEach(function (tx) {
      if (!tx || (tx.category !== 'svc' && tx.category !== 'ret') || !tx.date) return;
      var ym = tx.date.slice(0, 7);
      monthMap[ym] = (monthMap[ym] || 0) + (Number(tx.amount) || 0);
    });
    var bestMonth = Object.keys(monthMap).sort(function (a, b) { return monthMap[b] - monthMap[a]; })[0];
    if (bestMonth) {
      milestones.push('Best month: ' + bestMonth + ' (' + fmtCurrency(monthMap[bestMonth]) + ')');
      addCrmEvent('milestone', 'Best revenue month', { month: bestMonth, revenue: monthMap[bestMonth] }, null, 'milestone:best-month:' + bestMonth);
    }
    if (projects.some(function (p) { return p && String(p.status || '').toLowerCase().indexOf('complete') !== -1; })) {
      milestones.push('Project delivered');
      addCrmEvent('milestone', 'Project delivered', {}, null, 'milestone:project-delivered');
    }
    var milEl = $('crm-milestones-list');
    if (milEl) milEl.innerHTML = milestones.length ? milestones.map(function (m) { return '<div class="kb bn" style="padding:8px 10px;background:var(--bg2);">' + esc(m) + '</div>'; }).join('') : '<div style="font-size:13px;color:var(--text3);">No milestones yet.</div>';

    var evEl = $('crm-events-timeline');
    if (evEl) {
      evEl.innerHTML = crmEvents.length ? crmEvents.slice(0, 8).map(function (ev) {
        var when = ev.eventAt ? new Date(ev.eventAt).toLocaleDateString() : '—';
        return '<div style="padding:8px 10px;border:1px solid var(--border);border-radius:10px;"><div style="font-size:12px;color:var(--text3);">' + esc(when) + ' • ' + esc(ev.kind || 'event') + '</div><div style="font-size:13px;color:var(--text2);">' + esc(ev.title || '') + '</div></div>';
      }).join('') : '<div style="font-size:13px;color:var(--text3);">No timeline events yet.</div>';
    }

    var latestSummary = $('crm-latest-summary');
    if (latestSummary) {
      try {
        latestSummary.textContent = buildDashboardRecapText();
      } catch (e) {
        latestSummary.textContent = 'Recap will appear once dashboard numbers are loaded.';
      }
    }
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

    var sliceColors = labels[0] === 'No data' ? [CHART_EMPTY] : chartMultiColors(labels.length);

    if (!verticalChart) {
      verticalChart = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: sliceColors,
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
      verticalChart.data.datasets[0].backgroundColor = sliceColors;
      verticalChart.update('none');
    }
  }

  // ---------- Insights ----------

  var insTrendChart = null;
  var retTrendChart = null;

  function monthKeyShift(ym, deltaMonths) {
    var y = parseInt(String(ym || '').slice(0, 4), 10);
    var m = parseInt(String(ym || '').slice(5, 7), 10);
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return null;
    var d = new Date(y, m - 1 + deltaMonths, 1, 12, 0, 0, 0);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function computeRetentionMetrics() {
    var allTxs = state.transactions || [];
    var totalClients = clients.length;
    var retainerClients = clients.filter(clientIsRetainer);
    var retentionRatePct = totalClients > 0 ? (retainerClients.length / totalClients) * 100 : null;

    var revenueByClient = {};
    allTxs.forEach(function (tx) {
      if (!tx || !tx.clientId || !tx.date) return;
      if (tx.category !== 'svc' && tx.category !== 'ret') return;
      var amt = Number(tx.amount || 0);
      if (!isFinite(amt) || amt <= 0) return;
      revenueByClient[tx.clientId] = (revenueByClient[tx.clientId] || 0) + amt;
    });
    var lifetimeRevenueTotal = clients.reduce(function (sum, c) {
      return sum + (revenueByClient[c.id] || 0);
    }, 0);
    // Denominator = all clients for stable KPI behavior across account sizes.
    var avgClientLtv = totalClients > 0 ? (lifetimeRevenueTotal / totalClients) : 0;

    var today = new Date();
    var todayYmd = dateYMD(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12));
    var churnedThisMonth = clients.filter(function (c) {
      if (!c || clientIsRetainer(c)) return false;
      var incomeTxs = allTxs.filter(function (tx) {
        return tx && tx.clientId === c.id && (tx.category === 'svc' || tx.category === 'ret') && tx.date;
      });
      if (!incomeTxs.length) return false;
      var latestDate = incomeTxs.map(function (tx) { return tx.date; }).sort().pop();
      var diff = (parseYMD(todayYmd) - parseYMD(latestDate)) / 86400000;
      return diff >= 60;
    }).length;

    return {
      totalClients: totalClients,
      retainerClients: retainerClients,
      retentionRatePct: retentionRatePct,
      avgClientLtv: avgClientLtv,
      churnedThisMonth: churnedThisMonth,
      revenueByClient: revenueByClient,
      todayYmd: todayYmd,
    };
  }

  function computeRetentionTrendSeries(lookbackMonths) {
    var monthsBack = Math.max(3, Number(lookbackMonths) || 6);
    var now = new Date();
    var currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    var allTxs = state.transactions || [];
    var out = [];
    for (var i = monthsBack - 1; i >= 0; i--) {
      var mk = monthKeyShift(currentMonth, -i);
      if (!mk) continue;
      var activeById = {};
      allTxs.forEach(function (tx) {
        if (!tx || !tx.clientId || !tx.date) return;
        if (tx.date.slice(0, 7) !== mk) return;
        if (tx.category !== 'svc' && tx.category !== 'ret') return;
        var amt = Number(tx.amount || 0);
        if (!isFinite(amt) || amt <= 0) return;
        activeById[tx.clientId] = true;
      });
      var activeClients = clients.filter(function (c) { return c && c.id && activeById[c.id]; });
      var activeRetainers = activeClients.filter(clientIsRetainer).length;
      var pct = activeClients.length ? (activeRetainers / activeClients.length) * 100 : 0;
      out.push({ month: mk, pct: pct });
    }
    return out;
  }

  function renderRetention() {
    var m = computeRetentionMetrics();
    if (m.retentionRatePct == null) {
      setText('ret-kpi-1', '—');
      setText('ret-kpi-1b', 'no clients');
    } else {
      setText('ret-kpi-1', m.retentionRatePct.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 }) + '%');
      setText('ret-kpi-1b', m.retainerClients.length + ' of ' + m.totalClients + ' on retainer');
    }
    setText('ret-kpi-2', fmtCurrency(m.avgClientLtv));
    setText('ret-kpi-2b', 'lifetime avg (all clients)');
    setText('ret-kpi-3', String(m.churnedThisMonth));
    setText('ret-kpi-3b', 'no activity 60d+');

    var listEl = $('retainers-list');
    var emptyEl = $('retainers-empty');
    if (listEl && emptyEl) {
      if (!m.retainerClients.length) {
        emptyEl.style.display = 'block';
        listEl.style.display = 'none';
        listEl.innerHTML = '';
      } else {
        emptyEl.style.display = 'none';
        listEl.style.display = 'flex';
        listEl.innerHTML = m.retainerClients
          .slice()
          .sort(function (a, b) {
            var ar = m.revenueByClient[a.id] || 0;
            var br = m.revenueByClient[b.id] || 0;
            return br - ar;
          })
          .map(function (c) {
            var rev = m.revenueByClient[c.id] || 0;
            var status = c.status ? esc(c.status) : 'Retainer';
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);">' +
              '<div style="min-width:0;">' +
                '<div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(c.companyName || c.contactName || 'Client') + '</div>' +
                '<div style="font-size:11px;color:var(--text3);margin-top:2px;">' + status + '</div>' +
              '</div>' +
              '<div style="font-size:12px;font-weight:600;color:var(--text2);font-variant-numeric:tabular-nums;padding-left:10px;">' + fmtCurrency(rev) + '</div>' +
            '</div>';
          }).join('');
      }
    }

    var trendSeries = computeRetentionTrendSeries(6);
    var trendCanvas = document.getElementById('cRet');
    if (trendCanvas && window.Chart) {
      var labels = trendSeries.map(function (p) { return fmtMonthLabel(p.month); });
      var values = trendSeries.map(function (p) { return Math.round(p.pct * 10) / 10; });
      if (!retTrendChart) {
        retTrendChart = new Chart(trendCanvas, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: 'Retention %',
              data: values,
              borderColor: CHART_ORANGE,
              backgroundColor: CHART_ORANGE_FILL,
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: CHART_ORANGE,
              pointHoverBackgroundColor: CHART_ORANGE,
              fill: true,
              tension: 0.3,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: CHART_TICK, font: { size: 11 } } },
              y: {
                min: 0,
                max: 100,
                grid: { color: CHART_GRID },
                ticks: {
                  color: CHART_TICK,
                  font: { size: 11 },
                  callback: function (v) { return v + '%'; },
                },
              },
            },
          },
        });
      } else {
        retTrendChart.data.labels = labels;
        retTrendChart.data.datasets[0].data = values;
        syncBrandedRevenueLineDataset(retTrendChart.data.datasets[0]);
        retTrendChart.update('none');
      }
    }
  }

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

  function computeMonthlyExpenseSeries() {
    var byMonth = {};
    (state.transactions || []).forEach(function (tx) {
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
      var amt = +tx.amount || 0;
      if (amt <= 0 || !tx.date) return;
      var key = tx.date.slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + amt;
    });
    var keys = Object.keys(byMonth).sort();
    return keys.map(function (k) { return { month: k, expense: byMonth[k] }; });
  }

  function linearForecastValues(ys) {
    var n = ys.length;
    if (n < 2) return null;
    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) {
      sumX += i;
      sumY += ys[i];
      sumXY += i * ys[i];
      sumXX += i * i;
    }
    var denom = n * sumXX - sumX * sumX;
    if (!denom) return null;
    var slope = (n * sumXY - sumX * sumY) / denom;
    var intercept = (sumY - slope * sumX) / n;
    return { slope: slope, intercept: intercept, nextValue: Math.max(0, slope * n + intercept) };
  }

  function linearForecast(series) {
    if (!series || series.length < 2) return null;
    return linearForecastValues(series.map(function (s) { return s.revenue; }));
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

  /** First and last YYYY-MM with positive svc/ret or expense amounts. */
  function insightTransactionMonthBounds(txs) {
    var min = null;
    var max = null;
    (txs || []).forEach(function (tx) {
      if (!tx.date) return;
      var k = tx.date.slice(0, 7);
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      var inc = tx.category === 'svc' || tx.category === 'ret';
      var exp = ['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) !== -1;
      if (!inc && !exp) return;
      if (!min || k < min) min = k;
      if (!max || k > max) max = k;
    });
    return min && max ? { min: min, max: max } : null;
  }

  /**
   * Dense calendar months from first to last insight-related transaction month (inclusive),
   * with zero-filled gaps so walk-forward trend matches calendar periods.
   */
  function buildDenseRevExpSeries(txs) {
    var b = insightTransactionMonthBounds(txs);
    if (!b) return null;
    var months = [];
    var y = +b.min.split('-')[0];
    var m = +b.min.split('-')[1];
    var yEnd = +b.max.split('-')[0];
    var mEnd = +b.max.split('-')[1];
    while (y < yEnd || (y === yEnd && m <= mEnd)) {
      months.push(y + '-' + String(m).padStart(2, '0'));
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    if (months.length < 3) return null;
    var revBy = {};
    var expBy = {};
    (txs || []).forEach(function (tx) {
      if (!tx.date) return;
      var k = tx.date.slice(0, 7);
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (tx.category === 'svc' || tx.category === 'ret') revBy[k] = (revBy[k] || 0) + amt;
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) !== -1) expBy[k] = (expBy[k] || 0) + amt;
    });
    return {
      months: months,
      revenue: months.map(function (mk) { return revBy[mk] || 0; }),
      expense: months.map(function (mk) { return expBy[mk] || 0; }),
    };
  }

  /** For each closed month at index i>=2: OLS on prior months predicts values[i]. */
  function walkForwardTrendAccuracy(months, values, thisMonthKey) {
    var out = [];
    for (var i = 2; i < months.length; i++) {
      if (months[i] >= thisMonthKey) continue;
      var lf = linearForecastValues(values.slice(0, i));
      if (!lf) continue;
      var pred = lf.nextValue;
      var act = values[i];
      out.push({ month: months[i], forecast: pred, actual: act, delta: act - pred });
    }
    return out;
  }

  function fmtInsightAccDelta(d, invertGood) {
    var good = invertGood ? d < 0 : d > 0;
    var col = Math.abs(d) < 0.005 ? 'var(--text3)' : good ? 'var(--green)' : 'var(--red)';
    var sign = d > 0 ? '+' : '';
    return '<span style="color:' + col + ';font-weight:500;font-variant-numeric:tabular-nums;">' + sign + fmtCurrency(d) + '</span>';
  }

  /** When forecast > 0: round((actual - forecast) / forecast * 100). */
  function fmtInsightAccPctCell(forecast, actual, invertGood) {
    if (!forecast || forecast <= 0) {
      return '<td style="color:var(--text3);font-size:13px;">—</td>';
    }
    var pct = Math.round(((actual - forecast) / forecast) * 100);
    var good = invertGood ? pct < 0 : pct > 0;
    var col = pct === 0 ? 'var(--text3)' : good ? 'var(--green)' : 'var(--red)';
    var sign = pct > 0 ? '+' : '';
    return '<td style="color:' + col + ';font-weight:500;font-variant-numeric:tabular-nums;">' + sign + pct + '%</td>';
  }

  function renderInsightsForecastAccuracy(allTxs, thisMonthKey) {
    var wrap = document.getElementById('ins-forecast-accuracy');
    if (!wrap) return;
    var dense = buildDenseRevExpSeries(allTxs);
    if (!dense) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;line-height:1.5;">' +
        'Need more history: at least three calendar months with revenue or expense activity. Each row backtests the same linear trend model as Outlook (walk-forward).</p>';
      return;
    }
    var revAcc = walkForwardTrendAccuracy(dense.months, dense.revenue, thisMonthKey);
    var expAcc = walkForwardTrendAccuracy(dense.months, dense.expense, thisMonthKey);
    var keySet = {};
    revAcc.forEach(function (r) { keySet[r.month] = true; });
    expAcc.forEach(function (r) { keySet[r.month] = true; });
    var keys = Object.keys(keySet).sort();
    if (!keys.length) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;line-height:1.5;">' +
        'Forecast accuracy rows appear for months that are already closed. After this month ends, the trend vs. actual for it will show here.</p>';
      return;
    }
    var revMap = {};
    revAcc.forEach(function (r) { revMap[r.month] = r; });
    var expMap = {};
    expAcc.forEach(function (r) { expMap[r.month] = r; });
    var tbody = keys.map(function (mk) {
      var rv = revMap[mk];
      var ex = expMap[mk];
      var label = fmtMonthLabel(mk);
      var revCells = rv
        ? '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(rv.forecast) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(rv.actual) + '</td>' +
          '<td>' + fmtInsightAccDelta(rv.delta, false) + '</td>' +
          fmtInsightAccPctCell(rv.forecast, rv.actual, false)
        : '<td colspan="4" style="color:var(--text3);font-size:13px;">—</td>';
      var expCells = ex
        ? '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(ex.forecast) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(ex.actual) + '</td>' +
          '<td>' + fmtInsightAccDelta(ex.delta, true) + '</td>' +
          fmtInsightAccPctCell(ex.forecast, ex.actual, true)
        : '<td colspan="4" style="color:var(--text3);font-size:13px;">—</td>';
      return '<tr><td class="tdp" style="font-weight:500;">' + esc(label) + '</td>' + revCells + expCells + '</tr>';
    }).join('');
    wrap.innerHTML =
      '<p style="font-size:12px;color:var(--text3);margin:0 0 12px;line-height:1.5;">' +
      'Delta = actual − forecast. Err% uses the same basis when forecast &gt; 0. Only completed months; under-spend on expenses is green.</p>' +
      '<div style="overflow-x:auto;">' +
      '<table class="dt" style="margin:0;">' +
      '<thead><tr>' +
      '<th>Month</th>' +
      '<th colspan="4" style="text-align:center;border-left:1px solid var(--border);">Revenue</th>' +
      '<th colspan="4" style="text-align:center;border-left:1px solid var(--border);">Expenses</th>' +
      '</tr>' +
      '<tr>' +
      '<th></th>' +
      '<th style="border-left:1px solid var(--border);">Forecast</th><th>Actual</th><th>Delta</th><th>Err%</th>' +
      '<th style="border-left:1px solid var(--border);">Forecast</th><th>Actual</th><th>Delta</th><th>Err%</th>' +
      '</tr></thead><tbody>' + tbody + '</tbody></table></div>';
  }

  function renderInsightsBudgetAccuracy(allTxs, thisMonthKey) {
    var wrap = document.getElementById('ins-budget-accuracy');
    if (!wrap) return;
    var snaps = loadBudgetMonthSnapshots();
    var snapKeys = Object.keys(snaps).filter(function (k) { return /^\d{4}-\d{2}$/.test(k); }).sort();
    var totalCurrent = budgets.lab + budgets.sw + budgets.ads + budgets.oth;
    var hasAnyBudget = totalCurrent > 0.01;
    var hasSnaps = snapKeys.length > 0;
    if (!hasAnyBudget && !hasSnaps) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;line-height:1.5;">' +
        'Save monthly budgets in Settings to compare <strong>plan vs spend</strong> for closed months. Each save stores that calendar month’s budget snapshot for this table.</p>';
      return;
    }
    var dense = buildDenseRevExpSeries(allTxs);
    var monthSet = {};
    if (dense) {
      dense.months.forEach(function (mk) {
        if (mk < thisMonthKey) monthSet[mk] = true;
      });
    }
    snapKeys.forEach(function (mk) {
      if (mk < thisMonthKey) monthSet[mk] = true;
    });
    var keys = Object.keys(monthSet).sort();
    if (!keys.length) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;">Budget history rows appear once prior months are closed.</p>';
      return;
    }
    var expByMonth = {};
    (allTxs || []).forEach(function (tx) {
      if (!tx.date) return;
      var k = tx.date.slice(0, 7);
      var amt = +tx.amount || 0;
      if (amt <= 0) return;
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
      expByMonth[k] = (expByMonth[k] || 0) + amt;
    });
    var anyFallback = false;
    var tbody = keys.map(function (mk) {
      var act = expByMonth[mk] || 0;
      var sn = snaps[mk];
      var fromSnap = sn && budgetSnapshotTotal(sn) > 0.005;
      var planned = fromSnap ? budgetSnapshotTotal(sn) : totalCurrent;
      if (!fromSnap && totalCurrent < 0.01 && act < 0.01) return '';
      if (!fromSnap && totalCurrent >= 0.01) anyFallback = true;
      if (planned < 0.01 && act < 0.01) return '';
      var delta = act - planned;
      var deltaHtml = fmtInsightAccDelta(delta, true);
      var planCell = fmtCurrency(planned) + (fromSnap ? '' : ' <span style="color:var(--text3);font-size:11px;font-weight:500;">*</span>');
      return '<tr>' +
        '<td class="tdp" style="font-weight:500;">' + esc(fmtMonthLabel(mk)) + '</td>' +
        '<td style="font-variant-numeric:tabular-nums;">' + planCell + '</td>' +
        '<td style="font-variant-numeric:tabular-nums;">' + fmtCurrency(act) + '</td>' +
        '<td>' + deltaHtml + '</td>' +
        fmtInsightAccPctCell(planned, act, true) +
      '</tr>';
    }).filter(Boolean).join('');
    if (!tbody) {
      wrap.innerHTML =
        '<p style="font-size:13px;color:var(--text3);margin:0;">No closed months with budget or spend yet.</p>';
      return;
    }
    var foot = anyFallback
      ? '<p style="font-size:11px;color:var(--text3);margin:10px 0 0;line-height:1.45;">* No snapshot for that month — using your <strong>current</strong> Settings budget total. Save budgets during each month to lock the plan for history.</p>'
      : '';
    wrap.innerHTML =
      '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:8px;">Budget vs actual</div>' +
      '<p style="font-size:12px;color:var(--text3);margin:0 0 10px;line-height:1.5;">Planned spend from saved budget snapshots (or current total). Actual = same expense categories as Budget vs. Actual on the main page.</p>' +
      '<div style="overflow-x:auto;">' +
      '<table class="dt" style="margin:0;">' +
      '<thead><tr><th>Month</th><th>Budget (plan)</th><th>Actual</th><th>Delta</th><th>Err%</th></tr></thead>' +
      '<tbody>' + tbody + '</tbody></table></div>' + foot;
  }

  var INSIGHT_EXPENSE_CATEGORIES = ['lab', 'sw', 'ads', 'oth'];

  function isExpenseCategory(cat) {
    return INSIGHT_EXPENSE_CATEGORIES.indexOf(cat) !== -1;
  }

  /** Lowercase, collapse spaces, strip common corporate suffixes for matching. */
  function normalizeVendorName(v) {
    if (v == null) return '';
    var s = String(v).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return '';
    s = s.replace(/\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  function filterExpenseTxsInRange(txs, startYmd, endYmd) {
    return (txs || []).filter(function (tx) {
      if (!tx || !tx.date) return false;
      if (tx.date < startYmd || tx.date > endYmd) return false;
      var amt = +tx.amount || 0;
      if (amt <= 0) return false;
      return isExpenseCategory(tx.category);
    });
  }

  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    var al = a.length;
    var bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    var row = [];
    var i; var j; var prev; var t;
    for (j = 0; j <= bl; j++) row[j] = j;
    for (i = 1; i <= al; i++) {
      prev = row[0];
      row[0] = i;
      for (j = 1; j <= bl; j++) {
        t = row[j];
        row[j] = a.charAt(i - 1) === b.charAt(j - 1) ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
        prev = t;
      }
    }
    return row[bl];
  }

  function insightAlertCardHtml(a) {
    var bg = a.type === 'good' ? 'var(--green-bg)' : a.type === 'warn' ? 'var(--amber-bg)' : 'var(--blue-bg)';
    var border = a.type === 'good' ? 'var(--green)' : a.type === 'warn' ? 'var(--amber)' : 'var(--blue)';
    var icon = a.type === 'good' ? '✓' : a.type === 'warn' ? '⚠' : 'ℹ';
    return '<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:var(--r);background:' + bg + ';border-left:3px solid ' + border + ';">' +
      '<span style="font-size:14px;line-height:1.4;flex-shrink:0;">' + icon + '</span>' +
      '<span style="font-size:13px;line-height:1.5;color:var(--text);">' + a.msg + '</span>' +
      '</div>';
  }

  function renderInsightsAlertList(items) {
    return (items || []).map(insightAlertCardHtml).join('');
  }

  function renderInsights() {
    var allTxs = state.transactions || [];
    var now = new Date();
    var todayStr = dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12));

    // ---- Monthly revenue & expense series ----
    var series = computeMonthlyRevenueSeries();
    var expSeries = computeMonthlyExpenseSeries();
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
      var rev = effectiveClientRevenue(c);
      return sum + (rev > 0 ? rev / Math.max(1, series.length) : 0);
    }, 0);

    // ---- Top client ----
    var clientRevs = clients.map(function (c) {
      return { client: c, rev: effectiveClientRevenue(c) };
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
    var expForecast = linearForecastValues(expSeries.map(function (s) { return s.expense; }));

    // ---- Alerts (revenue vs spending columns) ----
    var wrapEl = document.getElementById('insights-alerts-wrap');
    var rowEl = document.getElementById('insights-alerts-row');
    var revAlertsEl = document.getElementById('insights-alerts-revenue');
    var spendAlertsEl = document.getElementById('insights-alerts-spend');
    var healthyEl = document.getElementById('insights-alerts-healthy');
    var legacyAlertsEl = document.getElementById('insights-alerts');
    var revenueAlerts = [];
    var spendAlerts = [];
    var budgetCatLabels = { lab: 'Labor', sw: 'Software & Tools', ads: 'Advertising', oth: 'Other' };

    // Expense spike vs 3-month avg → spending
    var thisMonthExp = 0;
    allTxs.forEach(function (tx) {
      if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
      var amt = +tx.amount || 0;
      if (expByCat.hasOwnProperty(tx.category) && amt > 0) thisMonthExp += amt;
    });
    var last3Exp = [];
    for (var mi = 1; mi <= 3; mi++) {
      var dExp = new Date(now.getFullYear(), now.getMonth() - mi, 1);
      var mkExp = dExp.getFullYear() + '-' + String(dExp.getMonth() + 1).padStart(2, '0');
      var mExp = 0;
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== mkExp) return;
        var amt = +tx.amount || 0;
        if (expByCat.hasOwnProperty(tx.category) && amt > 0) mExp += amt;
      });
      last3Exp.push(mExp);
    }
    var avgExp3 = last3Exp.length ? last3Exp.reduce(function (a, b) { return a + b; }, 0) / last3Exp.length : 0;
    if (avgExp3 > 0 && thisMonthExp > avgExp3 * 1.35) {
      var expPct = Math.round((thisMonthExp / avgExp3 - 1) * 100);
      spendAlerts.push({ type: 'warn', msg: 'Expenses this month are <strong>' + expPct + '% above</strong> your 3-month average (' + fmtCurrency(thisMonthExp) + ' vs avg ' + fmtCurrency(avgExp3) + ').' });
    }

    // Revenue vs avg → revenue
    if (avg3 > 0 && thisMonthRev > 0 && thisMonthRev < avg3 * 0.6) {
      revenueAlerts.push({ type: 'warn', msg: 'Revenue this month (' + fmtCurrency(thisMonthRev) + ') is tracking <strong>below</strong> your 3-month average of ' + fmtCurrency(avg3) + '.' });
    }
    if (avg3 > 0 && thisMonthRev > avg3 * 1.25) {
      var upPct = Math.round((thisMonthRev / avg3 - 1) * 100);
      revenueAlerts.push({ type: 'good', msg: 'Revenue this month is <strong>' + upPct + '% above</strong> your 3-month average — great month!' });
    }
    if (churnRisk.length) {
      revenueAlerts.push({ type: 'warn', msg: churnRisk.length + ' client' + (churnRisk.length > 1 ? 's have' : ' has') + ' had no income in 60+ days: <strong>' + churnRisk.map(function (c) { return esc(c.companyName || c.contactName || 'Unknown'); }).join(', ') + '</strong>.' });
    }
    if (!retainerClients.length && clients.length > 0) {
      revenueAlerts.push({ type: 'info', msg: 'You have no retainer clients yet. Retainers provide predictable monthly revenue.' });
    }

    // Budget alerts → spending
    var hasAnyBudget = (budgets.lab + budgets.sw + budgets.ads + budgets.oth) > 0;
    if (!hasAnyBudget && allTxs.length > 0) {
      spendAlerts.push({ type: 'info', msg: 'No monthly budgets set. <a href="#" onclick="window.nav(\'settings\');return false;" style="color:var(--blue);font-weight:500;text-decoration:none;">Set budgets in Settings</a> to track spending targets.' });
    } else if (hasAnyBudget) {
      var budgetActual = { lab: 0, sw: 0, ads: 0, oth: 0 };
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
        var amtB = +tx.amount || 0;
        if (amtB > 0 && budgetActual.hasOwnProperty(tx.category)) budgetActual[tx.category] += amtB;
      });
      ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
        var bgt = budgets[k];
        var act = budgetActual[k];
        if (bgt < 0.01) return;
        var usedPct = act / bgt * 100;
        if (usedPct >= 100) {
          var overAmt = act - bgt;
          spendAlerts.push({ type: 'warn', msg: '<strong>' + budgetCatLabels[k] + '</strong> is <strong>' + fmtCurrency(overAmt) + ' over budget</strong> this month (budgeted ' + fmtCurrency(bgt) + ', spent ' + fmtCurrency(act) + ').' });
        } else if (usedPct >= 80) {
          var leftAmt = bgt - act;
          spendAlerts.push({ type: 'warn', msg: '<strong>' + budgetCatLabels[k] + '</strong> has used <strong>' + Math.round(usedPct) + '%</strong> of its monthly budget — ' + fmtCurrency(leftAmt) + ' remaining.' });
        }
      });
    }

    // --- Spending nudges: overlap, category spikes, duplicate vendors/charges, recurring ---
    var start90 = dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 90, 12));
    var start180 = dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 180, 12));
    var swByVendor90 = {};
    filterExpenseTxsInRange(allTxs, start90, todayStr).forEach(function (tx) {
      if (tx.category !== 'sw') return;
      var rawV = (tx.vendor && String(tx.vendor).trim()) || '';
      var nk = normalizeVendorName(rawV);
      if (!nk) return;
      var amt = +tx.amount || 0;
      swByVendor90[nk] = (swByVendor90[nk] || 0) + amt;
    });
    var swVendorCount = Object.keys(swByVendor90).filter(function (vk) { return swByVendor90[vk] >= 25; }).length;
    if (swVendorCount >= 3) {
      spendAlerts.push({ type: 'info', msg: 'You have <strong>' + swVendorCount + ' software &amp; tool vendors</strong> with meaningful spend (90d) — review for overlap or duplicate tools.' });
    }

    var prior3Cat = { lab: 0, sw: 0, ads: 0, oth: 0 };
    for (var pci = 1; pci <= 3; pci++) {
      var dPrior = new Date(now.getFullYear(), now.getMonth() - pci, 1);
      var mkPrior = dPrior.getFullYear() + '-' + String(dPrior.getMonth() + 1).padStart(2, '0');
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== mkPrior) return;
        var amtP = +tx.amount || 0;
        if (amtP <= 0 || !prior3Cat.hasOwnProperty(tx.category)) return;
        prior3Cat[tx.category] += amtP;
      });
    }
    ['lab', 'sw', 'ads', 'oth'].forEach(function (ck) {
      var priorAvg = prior3Cat[ck] / 3;
      var thisCat = 0;
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey || tx.category !== ck) return;
        var amtC = +tx.amount || 0;
        if (amtC > 0) thisCat += amtC;
      });
      if (priorAvg > 100 && thisCat > priorAvg * 1.5) {
        var catUp = Math.round((thisCat / priorAvg - 1) * 100);
        spendAlerts.push({ type: 'warn', msg: '<strong>' + budgetCatLabels[ck] + '</strong> spend this month is <strong>' + catUp + '% above</strong> your prior 3-month average (' + fmtCurrency(thisCat) + ' vs avg ' + fmtCurrency(priorAvg) + ').' });
      }
    });

    var vendorSpend180 = {};
    var vendorDisplay180 = {};
    filterExpenseTxsInRange(allTxs, start180, todayStr).forEach(function (tx) {
      var raw = (tx.vendor && String(tx.vendor).trim()) || '';
      if (!raw) return;
      var nk = normalizeVendorName(raw);
      if (!nk) return;
      vendorSpend180[nk] = (vendorSpend180[nk] || 0) + (+tx.amount || 0);
      if (!vendorDisplay180[nk]) vendorDisplay180[nk] = raw;
    });
    var normKeys = Object.keys(vendorSpend180).filter(function (k) { return vendorSpend180[k] > 0; });
    var dupPairs = [];
    var pi; var pj;
    for (pi = 0; pi < normKeys.length; pi++) {
      for (pj = pi + 1; pj < normKeys.length; pj++) {
        var ka = normKeys[pi];
        var kb = normKeys[pj];
        if (ka.length < 4 || kb.length < 4) continue;
        if (levenshteinDistance(ka, kb) <= 1) {
          dupPairs.push([vendorDisplay180[ka] || ka, vendorDisplay180[kb] || kb]);
          if (dupPairs.length >= 4) break;
        }
      }
      if (dupPairs.length >= 4) break;
    }
    if (dupPairs.length) {
      var pairStr = dupPairs.slice(0, 3).map(function (pair) {
        return '<strong>' + esc(pair[0]) + '</strong> / <strong>' + esc(pair[1]) + '</strong>';
      }).join('; ');
      spendAlerts.push({ type: 'info', msg: 'Possible duplicate vendor names (similar spelling): ' + pairStr + '.' });
    }

    var dupChargeMap = {};
    allTxs.forEach(function (tx) {
      if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
      var amtD = +tx.amount || 0;
      if (amtD <= 0 || !isExpenseCategory(tx.category)) return;
      var nv = normalizeVendorName(tx.vendor || '');
      if (!nv) nv = normalizeVendorName(tx.title || '');
      if (!nv) return;
      var cents = Math.round(amtD * 100);
      var dk = nv + '\0' + tx.date + '\0' + cents;
      dupChargeMap[dk] = (dupChargeMap[dk] || 0) + 1;
    });
    Object.keys(dupChargeMap).forEach(function (dk) {
      if (dupChargeMap[dk] < 2) return;
      var parts = dk.split('\0');
      spendAlerts.push({ type: 'warn', msg: 'Possible <strong>duplicate expense entries</strong> on ' + esc(parts[1]) + ' (' + esc(parts[0]) + ', same amount) — check your ledger.' });
    });

    var recurringLeads = allTxs.filter(function (t) {
      return t && t.expenseRecurringLead && t.recurrence && t.recurrenceSeriesId && isExpenseCategory(t.category);
    });
    var staleSeriesWarned = {};
    recurringLeads.forEach(function (lead) {
      var sid = lead.recurrenceSeriesId;
      if (staleSeriesWarned[sid]) return;
      var rule = lead.recurrence;
      var endD = rule.endDate && String(rule.endDate).trim();
      if (endD && endD < todayStr) return;
      var seriesDates = [];
      allTxs.forEach(function (t) {
        if (t.recurrenceSeriesId === sid && t.date) seriesDates.push(t.date);
      });
      var latest = seriesDates.length ? seriesDates.sort().pop() : lead.date;
      if (!latest) return;
      var gapDays = (parseYMD(todayStr) - parseYMD(latest)) / 86400000;
      var intervalN = Math.max(1, parseInt(rule.interval, 10) || 1);
      var expectedDays = rule.repeat === 'weekly' ? 7 * intervalN : 30 * intervalN;
      if (gapDays > expectedDays * 1.5) {
        staleSeriesWarned[sid] = true;
        var staleLabel = esc(lead.vendor || lead.title || 'Recurring expense');
        spendAlerts.push({ type: 'warn', msg: 'Recurring expense <strong>' + staleLabel + '</strong> has <strong>no recent charge</strong> in this series — confirm it is still active or update the schedule.' });
      }
    });

    var swRecurringLeads = recurringLeads.filter(function (t) { return t.category === 'sw'; });
    if (swRecurringLeads.length >= 3) {
      spendAlerts.push({ type: 'info', msg: 'You have <strong>' + swRecurringLeads.length + ' active recurring</strong> software &amp; tool subscriptions — worth a periodic audit.' });
    }

    var hasNewLayout = wrapEl && revAlertsEl && spendAlertsEl;
    if (hasNewLayout) {
      if (!revenueAlerts.length && !spendAlerts.length && allTxs.length > 0) {
        if (rowEl) rowEl.style.display = 'none';
        if (healthyEl) healthyEl.innerHTML = insightAlertCardHtml({ type: 'good', msg: 'Everything looks healthy — no anomalies detected.' });
      } else {
        if (rowEl) rowEl.style.display = 'grid';
        if (healthyEl) healthyEl.innerHTML = '';
        revAlertsEl.innerHTML = renderInsightsAlertList(revenueAlerts);
        spendAlertsEl.innerHTML = renderInsightsAlertList(spendAlerts);
      }
    } else if (legacyAlertsEl) {
      var merged = revenueAlerts.concat(spendAlerts);
      if (!merged.length && allTxs.length > 0) merged.push({ type: 'good', msg: 'Everything looks healthy — no anomalies detected.' });
      legacyAlertsEl.innerHTML = renderInsightsAlertList(merged);
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
              borderColor: CHART_ORANGE,
              backgroundColor: CHART_ORANGE_FILL,
              borderWidth: 2,
              pointRadius: 3,
              pointBackgroundColor: CHART_ORANGE,
              pointBorderColor: '#ffffff',
              pointBorderWidth: 2,
              pointHoverBackgroundColor: CHART_ORANGE,
              fill: true,
              tension: 0.35,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: CHART_TICK, font: { size: 11 } } },
              y: { grid: { color: CHART_GRID }, ticks: { color: CHART_TICK, font: { size: 11 }, callback: function (v) { return '$' + v.toLocaleString(); } } },
            },
          },
        });
      } else {
        insTrendChart.data.labels = trendLabels;
        insTrendChart.data.datasets[0].data = trendData;
        syncBrandedRevenueLineDataset(insTrendChart.data.datasets[0]);
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

    // ---- Forecast & run rate card ----
    var forecastEl = document.getElementById('ins-forecast-body');
    if (forecastEl) {
      var dim = daysInMonth(now.getFullYear(), now.getMonth());
      var dom = Math.max(1, now.getDate());
      var mtdExpense = 0;
      allTxs.forEach(function (tx) {
        if (!tx.date || tx.date.slice(0, 7) !== thisMonthKey) return;
        if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
        var a = +tx.amount || 0;
        if (a > 0) mtdExpense += a;
      });
      var projectedEom = mtdExpense > 0 ? (mtdExpense / dom) * dim : 0;

      var paceHtml = '<div id="ins-pace-block" style="padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border);">' +
        '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">This month (pace)</div>';
      if (mtdExpense > 0) {
        paceHtml +=
          '<div style="font-size:13px;color:var(--text2);line-height:1.5;">MTD ' + fmtCurrency(mtdExpense) + ' · At current daily pace, ~<strong style="color:var(--text);">' + fmtCurrency(projectedEom) + '</strong> by month-end</div>' +
          '<div style="font-size:12px;color:var(--text3);margin-top:6px;line-height:1.45;">' + dim + ' days in month · day ' + dom + '.</div>';
      } else {
        paceHtml += '<div style="font-size:13px;color:var(--text3);">No expense recorded this month yet.</div>';
      }
      paceHtml += '</div>';

      var lastRevMonth = series.length ? series[series.length - 1].month : null;
      var lastExpMonth = expSeries.length ? expSeries[expSeries.length - 1].month : null;
      var anchorMonth = lastRevMonth && lastExpMonth
        ? (lastRevMonth > lastExpMonth ? lastRevMonth : lastExpMonth)
        : (lastRevMonth || lastExpMonth);
      var nextLabelCombined = anchorMonth ? nextMonthLabel(anchorMonth) : '';

      var revHtml = '';
      if (forecast && series.length >= 2) {
        var nextLabelRev = nextMonthLabel(series[series.length - 1].month);
        var lastActual = series[series.length - 1].revenue;
        var delta = forecast.nextValue - lastActual;
        var deltaColor = delta >= 0 ? 'var(--green)' : 'var(--red)';
        var deltaSign = delta >= 0 ? '+' : '';
        revHtml =
          '<div id="ins-rev-trend-block" style="padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border);">' +
            '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">Next month — revenue (trend)</div>' +
            '<div style="font-size:13px;color:var(--text3);margin-bottom:8px;">' + nextLabelRev + '</div>' +
            '<div style="font-size:32px;font-weight:600;letter-spacing:-0.03em;margin-bottom:6px;">' + fmtCurrency(forecast.nextValue) + '</div>' +
            '<div style="font-size:13px;color:' + deltaColor + ';font-weight:500;">' + deltaSign + fmtCurrency(delta) + ' vs last month</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:8px;line-height:1.5;">Linear trend across ' + series.length + ' month' + (series.length > 1 ? 's' : '') + ' of revenue.</div>' +
          '</div>';
      }

      var expHtml = '';
      if (expForecast && expSeries.length >= 2) {
        var nextLabelExp = nextMonthLabel(expSeries[expSeries.length - 1].month);
        var lastExpAmt = expSeries[expSeries.length - 1].expense;
        var expDelta = expForecast.nextValue - lastExpAmt;
        var expDeltaColor = expDelta >= 0 ? 'var(--red)' : 'var(--green)';
        var expDeltaSign = expDelta >= 0 ? '+' : '';
        expHtml =
          '<div id="ins-exp-trend-block" style="padding-bottom:14px;margin-bottom:14px;border-bottom:1px solid var(--border);">' +
            '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">Next month — expense (trend)</div>' +
            '<div style="font-size:13px;color:var(--text3);margin-bottom:8px;">' + nextLabelExp + '</div>' +
            '<div style="font-size:32px;font-weight:600;letter-spacing:-0.03em;margin-bottom:6px;">' + fmtCurrency(expForecast.nextValue) + '</div>' +
            '<div style="font-size:13px;color:' + expDeltaColor + ';font-weight:500;">' + expDeltaSign + fmtCurrency(expDelta) + ' vs last month</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:8px;line-height:1.5;">Linear trend across ' + expSeries.length + ' month' + (expSeries.length > 1 ? 's' : '') + ' of expenses.</div>' +
          '</div>';
      }

      var netHtml = '';
      if (forecast && expForecast && series.length >= 2 && expSeries.length >= 2) {
        var netVal = forecast.nextValue - expForecast.nextValue;
        var netColor = netVal >= 0 ? 'var(--green)' : 'var(--red)';
        netHtml =
          '<div id="ins-net-block">' +
            '<div style="font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:0.06em;color:var(--text3);margin-bottom:6px;">Projected net — ' + nextLabelCombined + '</div>' +
            '<div style="font-size:32px;font-weight:600;letter-spacing:-0.03em;color:' + netColor + ';">' + fmtCurrency(netVal) + '</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:8px;line-height:1.5;">Revenue trend minus expense trend (next period).</div>' +
          '</div>';
      } else if ((forecast && series.length >= 2) || (expForecast && expSeries.length >= 2)) {
        netHtml =
          '<div id="ins-net-block" style="font-size:12px;color:var(--text3);line-height:1.5;">Need at least 2 months of both revenue and expense history for a full projected net estimate.</div>';
      }

      var hasRevForecast = forecast && series.length >= 2;
      var hasExpForecast = expForecast && expSeries.length >= 2;
      if (!hasRevForecast && !hasExpForecast && mtdExpense <= 0 && !series.length && !expSeries.length) {
        forecastEl.innerHTML = '<div style="font-size:13px;color:var(--text3);">Add transactions to see pace and trends. Need at least 2 months of history for revenue or expense forecasts.</div>';
      } else if (!hasRevForecast && !hasExpForecast && mtdExpense <= 0) {
        forecastEl.innerHTML = paceHtml +
          '<div style="font-size:13px;color:var(--text3);">Need at least 2 months of revenue or expense history for trend forecasts.</div>';
      } else {
        forecastEl.innerHTML = paceHtml + revHtml + expHtml + netHtml;
      }
    }

    renderInsightsForecastAccuracy(allTxs, thisMonthKey);
    renderInsightsBudgetAccuracy(allTxs, thisMonthKey);

    // ---- Client performance table ----
    var clientsTbody = document.getElementById('ins-clients-tbody');
    var clientsTable = document.getElementById('ins-clients-table');
    var clientsEmpty = document.getElementById('ins-clients-empty');
    if (clientsTbody) {
      var sortedClients = clients.slice().sort(function (a, b) {
        return effectiveClientRevenue(b) - effectiveClientRevenue(a);
      });
      if (!sortedClients.length) {
        if (clientsEmpty) clientsEmpty.style.display = 'block';
        if (clientsTable) clientsTable.style.display = 'none';
      } else {
        if (clientsEmpty) clientsEmpty.style.display = 'none';
        if (clientsTable) clientsTable.style.display = 'table';
        clientsTbody.innerHTML = sortedClients.map(function (c) {
          var rev = effectiveClientRevenue(c);
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
          var rev = effectiveClientRevenue(c);
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

    if (!pairs.length) {
      labels = ['No active pipeline'];
      data = [1];
    } else {
      pairs.forEach(function (p) {
        labels.push(p[0]);
        data.push(p[1]);
      });
    }

    var bg = !pairs.length ? [CHART_EMPTY] : chartMultiColors(labels.length);

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
      btnSave.addEventListener('click', async function () {
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

  function incomeRuleOptionsForColumn(colId) {
    if (colId === 'amount') return ['eq', 'gt', 'gte', 'lt', 'lte', 'between'];
    if (colId === 'date') return ['on', 'after', 'before', 'between'];
    if (colId === 'category' || colId === 'invoice' || colId === 'recording') return ['is', 'not'];
    return ['contains', 'is', 'starts'];
  }

  function incomeCellRaw(row, colId) {
    if (colId === 'amount') return Number(row.amount || 0);
    return row[colId] == null ? '' : String(row[colId]);
  }

  function incomeMatchesRule(row, rule) {
    if (!rule || !rule.column || !rule.op) return true;
    var v = incomeCellRaw(row, rule.column);
    var q = String(rule.value == null ? '' : rule.value).trim();
    var q2 = String(rule.value2 == null ? '' : rule.value2).trim();
    if (!q && rule.op !== 'between') return true;
    if (rule.column === 'amount') {
      var n = Number(v || 0);
      var a = Number(q || 0);
      var b = Number(q2 || 0);
      if (rule.op === 'eq') return n === a;
      if (rule.op === 'gt') return n > a;
      if (rule.op === 'gte') return n >= a;
      if (rule.op === 'lt') return n < a;
      if (rule.op === 'lte') return n <= a;
      if (rule.op === 'between') return n >= Math.min(a, b) && n <= Math.max(a, b);
      return true;
    }
    var sv = String(v || '').toLowerCase();
    var sq = q.toLowerCase();
    if (rule.column === 'date') {
      if (rule.op === 'on') return sv === sq;
      if (rule.op === 'after') return sv >= sq;
      if (rule.op === 'before') return sv <= sq;
      if (rule.op === 'between') {
        var a2 = q.toLowerCase();
        var b2 = q2.toLowerCase();
        if (!a2 || !b2) return true;
        var lo = a2 < b2 ? a2 : b2;
        var hi = a2 < b2 ? b2 : a2;
        return sv >= lo && sv <= hi;
      }
      return true;
    }
    if (rule.op === 'contains') return sv.indexOf(sq) !== -1;
    if (rule.op === 'starts') return sv.indexOf(sq) === 0;
    if (rule.op === 'is') return sv === sq;
    if (rule.op === 'not') return sv !== sq;
    return true;
  }

  function exportIncomeRowsCsv(rows, onlySelected) {
    if (!rows || !rows.length) {
      alert('No rows to export.');
      return;
    }
    var out = ['Date,Source,Client,Project,Category,Amount,Invoice status,Recording'];
    rows.forEach(function (r) {
      out.push(
        '"' + String(r.date || '').replace(/"/g, '""') + '",' +
        '"' + String(r.source || '').replace(/"/g, '""') + '",' +
        '"' + String(r.client || '').replace(/"/g, '""') + '",' +
        '"' + String(r.project || '').replace(/"/g, '""') + '",' +
        '"' + String(r.category || '').replace(/"/g, '""') + '",' +
        Number(r.amount || 0) + ',' +
        '"' + String(r.invoice || '').replace(/"/g, '""') + '",' +
        '"' + String(r.recording || '').replace(/"/g, '""') + '"'
      );
    });
    var blob = new Blob([out.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = onlySelected ? 'income-selected.csv' : 'income-filtered.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

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

    // Income entries table (power-table view: column chooser, filters, bulk actions, export)
    var tbody = $('income-tbody');
    var thead = $('income-thead');
    var empty = $('income-empty');
    var table = $('income-table');
    var meta = $('income-power-meta');
    if (tbody) {
      var sourceRows = revTxs.slice().sort(function (a, b) {
        return (b.date || '').localeCompare(a.date || '');
      }).map(function (tx) {
        var cl = tx.clientId ? clients.find(function (c2) { return c2.id === tx.clientId; }) : null;
        var pr = tx.projectId ? projects.find(function (p2) { return p2.id === tx.projectId; }) : null;
        var inv2 = invoiceForTx[tx.id] || null;
        var recording =
          tx.incomeSourceStripe || tx.stripePaymentIntentId ? 'Stripe' : 'Manual';
        return {
          tx: tx,
          id: tx.id,
          date: tx.date || '—',
          source: tx.description || '—',
          client: (cl && cl.companyName) || '—',
          project: (pr && pr.name) || '—',
          category: displayIncomeCategory(tx),
          amount: Number(tx.amount || 0),
          invoice: inv2 ? (inv2.status === 'paid' ? 'Paid' : 'Sent') : 'No invoice',
          invoiceObj: inv2,
          recording: recording,
        };
      });
      var sourceIdMap = {};
      sourceRows.forEach(function (r) { sourceIdMap[r.id] = true; });
      Object.keys(incomePowerState.selected || {}).forEach(function (sid) {
        if (!sourceIdMap[sid]) delete incomePowerState.selected[sid];
      });
      var q = String(incomePowerState.search || '').trim().toLowerCase();
      var filteredRows = sourceRows.filter(function (row) {
        var textHit = true;
        if (q) {
          var hay = [row.date, row.source, row.client, row.project, row.category, row.invoice, row.recording]
            .join(' ')
            .toLowerCase();
          textHit = hay.indexOf(q) !== -1;
        }
        if (!textHit) return false;
        return (incomePowerState.filters || []).every(function (rule) {
          return incomeMatchesRule(row, rule);
        });
      });
      if (meta) {
        var selCount = Object.keys(incomePowerState.selected || {}).filter(function (id) { return incomePowerState.selected[id]; }).length;
        meta.textContent = filteredRows.length + ' rows' + (selCount ? ' · ' + selCount + ' selected' : '');
      }
      if (!filteredRows.length) {
        tbody.innerHTML = '';
        if (thead) thead.innerHTML = '<tr><th class="selcol"><input type="checkbox" disabled /></th><th>Results</th><th>Actions</th></tr>';
        if (empty) empty.style.display = 'block';
        if (table) table.style.display = 'none';
      } else {
        if (empty) empty.style.display = 'none';
        if (table) table.style.display = 'table';
        var visibleCols = incomePowerColumns.filter(function (col) { return incomePowerState.visible[col.id] !== false; });
        var allSelected = filteredRows.length > 0 && filteredRows.every(function (r) { return !!incomePowerState.selected[r.id]; });
        if (thead) {
          thead.innerHTML = '<tr>' +
            '<th class="selcol"><input type="checkbox" id="income-power-select-all"' + (allSelected ? ' checked' : '') + ' /></th>' +
            visibleCols.map(function (col) { return '<th>' + esc(col.label) + '</th>'; }).join('') +
            '<th style="width:360px;">Actions</th>' +
            '</tr>';
        }
        tbody.innerHTML = filteredRows.map(function (row) {
          var tx = row.tx;
          var inv = row.invoiceObj;
          var invBadge = inv
            ? ('<span class="pl ' + (inv.status === 'paid' ? 'pg-g' : 'pg-a') + '" style="margin-right:6px;">' + (inv.status === 'paid' ? 'Paid' : 'Sent') + '</span>')
            : '<span class="pl" style="margin-right:6px;background:var(--bg3);color:var(--text3);">No invoice</span>';
          var colCells = visibleCols.map(function (col) {
            if (col.id === 'amount') return '<td class="tdp">' + fmtCurrency(row.amount) + '</td>';
            return '<td>' + esc(row[col.id]) + '</td>';
          }).join('');
          return '<tr>' +
            '<td class="selcol"><input type="checkbox" data-income-select="' + esc(row.id) + '"' + (incomePowerState.selected[row.id] ? ' checked' : '') + ' /></td>' +
            colCells +
            '<td style="white-space:nowrap;">' +
              invBadge +
              (inv
                ? '<button type="button" class="btn" data-income-invoice-edit="' + tx.id + '" style="margin-right:6px;">Edit invoice</button>'
                : '<button type="button" class="btn" data-income-invoice-create="' + tx.id + '" style="margin-right:6px;">Create invoice</button>') +
              (inv ? '<button type="button" class="btn" data-income-invoice-view="' + tx.id + '" style="margin-right:6px;">View invoice</button>' : '') +
              (inv && inv.status !== 'paid' ? '<button type="button" class="btn btn-p" data-income-invoice-pay="' + tx.id + '" style="margin-right:6px;">Pay now</button>' : '') +
              (inv && inv.status !== 'paid' ? '<button type="button" class="btn" data-income-invoice-paid="' + tx.id + '" style="margin-right:6px;">Mark received</button>' : '') +
              '<button type="button" class="btn" data-income-edit="' + tx.id + '" style="margin-right:6px;">Edit</button>' +
              '<button type="button" class="btn" data-income-del="' + tx.id + '" style="color:var(--red);">Delete</button>' +
            '</td>' +
          '</tr>';
        }).join('');
      }
      window.__incomePowerFilteredRows = filteredRows;
    }

    // Revenue Trend chart (cRevT)
    var canvas = document.getElementById('cRevT');
    if (canvas && window.Chart) {
      var rangeMode = incomeTrendRange || '90d';
      var hint = $('rev-trend-hint');
      if (hint) {
        hint.textContent = rangeMode === '30d'
          ? 'Past month'
          : (rangeMode === 'ytd' ? 'Year to date' : (rangeMode === 'all' ? 'All time' : 'Last 90 days'));
      }
      var rangeSel = $('rev-trend-range');
      if (rangeSel) rangeSel.value = rangeMode;

      var today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
      var cutoff = null;
      if (rangeMode === '30d') cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30, 12, 0, 0, 0);
      if (rangeMode === '90d') cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90, 12, 0, 0, 0);
      if (rangeMode === 'ytd') cutoff = new Date(today.getFullYear(), 0, 1, 12, 0, 0, 0);

      var labels = [];
      var data = [];
      if (rangeMode === 'all') {
        // Keep all-time readable by aggregating to month.
        var chartRevByMonth = {};
        var chartMonthLatestTxDate = {};
        revTxs.forEach(function (tx) {
          var d = parseDate(tx.date);
          if (!d) return;
          var key = d.getFullYear() + '-' + d.getMonth();
          chartRevByMonth[key] = (chartRevByMonth[key] || 0) + (+tx.amount || 0);
          var ds = (tx.date || '').trim();
          if (ds && (!chartMonthLatestTxDate[key] || ds > chartMonthLatestTxDate[key])) {
            chartMonthLatestTxDate[key] = ds;
          }
        });
        var monthKeys = Object.keys(chartRevByMonth);
        if (monthKeys.length) {
          monthKeys.sort(function (a, b) {
            var pa = a.split('-').map(Number);
            var pb = b.split('-').map(Number);
            if (pa[0] !== pb[0]) return pa[0] - pb[0];
            return pa[1] - pb[1];
          });
        }
        labels = monthKeys.map(function (key) {
          var parts = key.split('-').map(Number);
          var y = parts[0];
          var m0 = parts[1];
          return chartPointDateLabel(chartMonthLatestTxDate[key], y, m0);
        });
        data = monthKeys.map(function (k) { return chartRevByMonth[k] || 0; });
      } else {
        // For 30d/90d views, show daily totals so entries don't collapse into one monthly point.
        var chartRevByDay = {};
        revTxs.forEach(function (tx) {
          var d = parseDate(tx.date);
          if (!d) return;
          if (cutoff && d < cutoff) return;
          var dayKey = (tx.date || '').slice(0, 10);
          if (!dayKey) return;
          chartRevByDay[dayKey] = (chartRevByDay[dayKey] || 0) + (+tx.amount || 0);
        });
        var dayKeys = Object.keys(chartRevByDay).sort();
        labels = dayKeys.map(function (key) {
          var dd = parseYMD(key);
          if (isNaN(dd.getTime())) return key;
          return dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });
        data = dayKeys.map(function (k) { return chartRevByDay[k] || 0; });
      }

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
              borderColor: CHART_ORANGE,
              backgroundColor: CHART_ORANGE_FILL,
              borderWidth: 2,
              fill: true,
              tension: 0.35,
              pointBackgroundColor: CHART_ORANGE,
              pointBorderColor: '#ffffff',
              pointBorderWidth: 2,
              pointRadius: 4,
              pointHoverRadius: 6,
              pointHoverBackgroundColor: CHART_ORANGE,
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
                ticks: { color: CHART_TICK, font: { size: 11 } },
              },
              y: {
                beginAtZero: true,
                grid: { color: CHART_GRID },
                ticks: {
                  color: CHART_TICK,
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
        syncBrandedRevenueLineDataset(revTrendChart.data.datasets[0]);
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
      var projLbls = typeLabels.length ? typeLabels : ['No projects'];
      var projData = typeLabels.length ? typeCounts : [1];
      var projBg = typeLabels.length ? chartMultiColors(projLbls.length) : [CHART_EMPTY];
      if (!projTypeChart) {
        projTypeChart = new Chart(svcCanvas, {
          type: 'doughnut',
          data: {
            labels: projLbls,
            datasets: [{
              data: projData,
              backgroundColor: projBg,
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
        projTypeChart.data.labels = projLbls;
        projTypeChart.data.datasets[0].data = projData;
        projTypeChart.data.datasets[0].backgroundColor = projBg;
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
              backgroundColor: CHART_ORANGE,
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
                ticks: { color: CHART_TICK, font: { size: 11 } },
              },
              y: {
                grid: { color: CHART_GRID },
                ticks: {
                  color: CHART_TICK,
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
        projMonthlyChart.data.datasets[0].backgroundColor = CHART_ORANGE;
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

  /** Sum of lab/sw/ads/oth tagged to this client (all-time). */
  function clientAllocatedCostFromTransactions(clientId) {
    if (!clientId) return 0;
    var sum = 0;
    (state.transactions || []).forEach(function (tx) {
      if (tx.clientId !== clientId) return;
      if (['lab', 'sw', 'ads', 'oth'].indexOf(tx.category) === -1) return;
      var amt = +tx.amount || 0;
      if (amt > 0) sum += amt;
    });
    return sum;
  }

  /** Revenue shown on Customers tab: optional manual amount, else sum of linked income. */
  function effectiveClientRevenue(c) {
    if (!c || !c.id) return 0;
    if (c.custTabRevenue != null && isFinite(Number(c.custTabRevenue))) return Math.max(0, Number(c.custTabRevenue));
    return clientRevenueFromTransactions(c.id);
  }

  /** Allocated cost on Customers tab: optional manual amount, else sum of linked expenses. */
  function effectiveClientAllocatedCost(c) {
    if (!c || !c.id) return 0;
    if (c.custTabAllocatedCost != null && isFinite(Number(c.custTabAllocatedCost))) {
      return Math.max(0, Number(c.custTabAllocatedCost));
    }
    return clientAllocatedCostFromTransactions(c.id);
  }

  function clientCompanyNameById(clientId) {
    if (!clientId) return '';
    var c = clients.find(function (x) { return x.id === clientId; });
    return c ? (c.companyName || 'Untitled client') : '';
  }

  function fmtProfitMarginRoi(revenue, cost) {
    var rev = +revenue || 0;
    var cst = +cost || 0;
    var profit = rev - cst;
    var marginStr = rev > 0 ? (profit / rev * 100).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + '%' : '—';
    var roiStr = cst > 0 ? (profit / cst * 100).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 }) + '%' : '—';
    return { profit: profit, marginStr: marginStr, roiStr: roiStr };
  }

  function clientProjectCount(clientId) {
    if (!clientId) return 0;
    return projects.filter(function (p) { return p.clientId === clientId; }).length;
  }

  function computeClientKpis() {
    var total = clients.length;
    var activeRetainers = clients.filter(clientIsRetainer).length;
    var totalRevenue = clients.reduce(function (sum, c) {
      return sum + effectiveClientRevenue(c);
    }, 0);
    var avgValue = total ? totalRevenue / total : 0;
    return {
      total: total,
      activeRetainers: activeRetainers,
      avgValue: avgValue,
    };
  }

  function applyCustomersColumnVisibility() {
    var table = $('customers-table');
    if (!table) return;
    CUSTOMERS_COLUMN_DEFS.forEach(function (col) {
      var show = col.locked ? true : customersColumnPrefs[col.id] !== false;
      var selector = 'thead th:nth-child(' + col.index + '), tbody td:nth-child(' + col.index + ')';
      table.querySelectorAll(selector).forEach(function (cell) {
        cell.style.display = show ? '' : 'none';
      });
    });
  }

  function renderCustomersColumnsPanel() {
    var panel = $('customers-columns-panel');
    if (!panel) return;
    var optionsHtml = CUSTOMERS_COLUMN_DEFS.map(function (col) {
      var checked = col.locked || customersColumnPrefs[col.id] !== false;
      var disabled = col.locked ? ' disabled' : '';
      var label = esc(col.label) + (col.locked ? ' (required)' : '');
      return '<label class="customers-col-opt">' +
        '<input type="checkbox" data-customer-col="' + col.id + '"' + (checked ? ' checked' : '') + disabled + ' />' +
        '<span>' + label + '</span>' +
      '</label>';
    }).join('');
    panel.innerHTML = optionsHtml +
      '<div class="customers-col-actions">' +
        '<button type="button" class="btn" id="btn-customers-columns-reset">Reset columns</button>' +
      '</div>';
  }

  function wireCustomersColumnsPicker() {
    var btn = $('btn-customers-columns');
    var panel = $('customers-columns-panel');
    if (!btn || !panel) return;

    renderCustomersColumnsPanel();
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      panel.classList.toggle('on');
    });
    panel.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    panel.addEventListener('change', function (ev) {
      var input = ev.target;
      if (!input || !input.matches || !input.matches('input[data-customer-col]')) return;
      var colId = input.getAttribute('data-customer-col');
      if (!colId) return;
      var def = CUSTOMERS_COLUMN_DEFS.find(function (c) { return c.id === colId; });
      if (!def || def.locked) return;
      customersColumnPrefs[colId] = input.checked !== false;
      saveCustomersColumnPrefs(customersColumnPrefs);
      applyCustomersColumnVisibility();
    });
    panel.addEventListener('click', function (ev) {
      var resetBtn = ev.target.closest('#btn-customers-columns-reset');
      if (!resetBtn) return;
      customersColumnPrefs = defaultCustomersColumnPrefs();
      saveCustomersColumnPrefs(customersColumnPrefs);
      renderCustomersColumnsPanel();
      applyCustomersColumnVisibility();
    });
    document.addEventListener('click', function () {
      panel.classList.remove('on');
    });
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
        var rev = effectiveClientRevenue(c);
        var cost = effectiveClientAllocatedCost(c);
        var pr = fmtProfitMarginRoi(rev, cost);
        var profitStyle = 'font-variant-numeric:tabular-nums;';
        if (pr.profit < 0) profitStyle += 'color:var(--red);';
        else if (pr.profit > 0) profitStyle += 'color:var(--green);';
        var pcount = clientProjectCount(c.id);
        var revTitle = c.custTabRevenue != null ? ' title="Custom revenue — edit client to change"' : '';
        var costTitle = c.custTabAllocatedCost != null ? ' title="Custom allocated cost — edit client to change"' : '';
        var companyText = c.companyName || '—';
        var contactText = c.contactName || '—';
        var emailText = c.email || '—';
        var phoneText = c.phone || '—';
        return '<tr>' +
          '<td class="tdp td-truncate" title="' + escAttr(companyText) + '">' + esc(companyText) + '</td>' +
          '<td class="td-truncate" title="' + escAttr(contactText) + '">' + esc(contactText) + '</td>' +
          '<td class="td-truncate" title="' + escAttr(emailText) + '">' + esc(emailText) + '</td>' +
          '<td class="td-truncate" title="' + escAttr(phoneText) + '">' + esc(phoneText) + '</td>' +
          '<td>' + esc(c.preferredChannel || '—') + '</td>' +
          '<td>' + esc(c.communicationStyle || '—') + '</td>' +
          '<td>' + esc(c.status || '—') +
            (clientIsRetainer(c) ? ' <span style="font-size:10px;font-weight:600;color:var(--coral);white-space:nowrap;">Retainer</span>' : '') +
          '</td>' +
          '<td>' + (pcount ? String(pcount) : '—') + '</td>' +
          '<td' + revTitle + ' style="font-variant-numeric:tabular-nums;">' + fmtCurrency(rev) + '</td>' +
          '<td' + costTitle + ' style="font-variant-numeric:tabular-nums;">' + fmtCurrency(cost) + '</td>' +
          '<td class="tdp" style="' + profitStyle + '">' + fmtCurrency(pr.profit) + '</td>' +
          '<td>' + pr.marginStr + '</td>' +
          '<td>' + pr.roiStr + '</td>' +
          '<td style="min-width:120px;">' +
            '<div style="display:flex;gap:6px;flex-wrap:nowrap;">' +
              '<button type="button" class="btn" data-client-edit="' + c.id + '">Edit</button>' +
              '<button type="button" class="btn" data-client-del="' + c.id + '" style="color:var(--red);">Delete</button>' +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join('');
      applyCustomersColumnVisibility();
    }

    var k = computeClientKpis();
    setText('cust-kpi-1', String(k.total));
    setText('cust-kpi-2', String(k.activeRetainers));
    setText('cust-kpi-3', fmtCurrency(k.avgValue || 0));
  }

  function parseTimeInputToMinutes(raw) {
    var s = String(raw || '').trim();
    if (!s) return NaN;
    var m = s.match(/^(\d{1,2}):([0-5]\d)$/);
    if (!m) return NaN;
    var hh = parseInt(m[1], 10);
    var mm = parseInt(m[2], 10);
    if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23) return NaN;
    return hh * 60 + mm;
  }

  function formatMinutesToHours(mins) {
    var n = Math.max(0, Number(mins) || 0);
    return (n / 60).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + 'h';
  }

  function startOfWeekMonday(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
    var wd = x.getDay(); // Sun=0..Sat=6
    var delta = wd === 0 ? -6 : 1 - wd;
    x.setDate(x.getDate() + delta);
    return x;
  }

  function calendarQuarterFromDate(d) {
    var m = d.getMonth();
    return { year: d.getFullYear(), q: Math.floor(m / 3) + 1 };
  }

  function shiftMonthYm(ym, deltaMonths) {
    var y = parseInt((ym || '').slice(0, 4), 10);
    var m0 = parseInt((ym || '').slice(5, 7), 10) - 1 + deltaMonths;
    var dt = new Date(y, m0, 1, 12, 0, 0, 0);
    if (isNaN(dt.getTime())) return ym;
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
  }

  function shiftQuarter(year, q, deltaQ) {
    var y = year;
    var qq = q + deltaQ;
    while (qq < 1) {
      qq += 4;
      y -= 1;
    }
    while (qq > 4) {
      qq -= 4;
      y += 1;
    }
    return { year: y, q: qq };
  }

  function timesheetEntryYmd(e) {
    return (e && e.date ? String(e.date) : '').slice(0, 10);
  }

  function timesheetEnsurePeriodAnchors() {
    if (!timesheetWeekMondayYmd) {
      timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
    }
    if (!timesheetMonthYm) {
      var n = new Date();
      timesheetMonthYm = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
    }
    if (timesheetQuarterYear == null || timesheetQuarterQ == null) {
      var cq = calendarQuarterFromDate(new Date());
      timesheetQuarterYear = cq.year;
      timesheetQuarterQ = cq.q;
    }
  }

  /** Monday Date for spreading new entries by weekday checkboxes. */
  function timesheetBaseMondayForNewEntry() {
    timesheetEnsurePeriodAnchors();
    var mode = timesheetPeriodMode || 'week';
    if (mode === 'week') {
      var ymd = timesheetWeekMondayYmd || dateYMD(startOfWeekMonday(new Date()));
      var w = parseYMD(ymd);
      return isNaN(w.getTime()) ? startOfWeekMonday(new Date()) : w;
    }
    if (mode === 'month') {
      var first = parseYMD(timesheetMonthYm + '-01');
      return isNaN(first.getTime()) ? startOfWeekMonday(new Date()) : startOfWeekMonday(first);
    }
    if (mode === 'quarter') {
      var q0 = (timesheetQuarterQ - 1) * 3;
      var first = new Date(timesheetQuarterYear, q0, 1, 12, 0, 0, 0);
      return startOfWeekMonday(first);
    }
    if (mode === 'ytd') {
      var ytd = new Date(new Date().getFullYear(), 0, 1, 12, 0, 0, 0);
      return startOfWeekMonday(ytd);
    }
    return startOfWeekMonday(new Date());
  }

  function renderTimesheet() {
    var empty = $('timesheet-empty');
    var table = $('timesheet-table');
    var tbody = $('timesheet-tbody');
    var logEmpty = $('timesheet-log-empty');
    var logTable = $('timesheet-log-table');
    var logBody = $('timesheet-log-tbody');
    if (!tbody || !logBody) return;

    timesheetEnsurePeriodAnchors();
    var mode = timesheetPeriodMode || 'week';
    var periodSel = $('ts-period-mode');
    if (periodSel) periodSel.value = mode;

    var weekWrap = $('ts-period-week-wrap');
    var monthWrap = $('ts-period-month-wrap');
    var quarterWrap = $('ts-period-quarter-wrap');
    var allWrap = $('ts-period-all-wrap');
    if (weekWrap) weekWrap.style.display = mode === 'week' ? '' : 'none';
    if (monthWrap) monthWrap.style.display = mode === 'month' ? '' : 'none';
    if (quarterWrap) quarterWrap.style.display = mode === 'quarter' ? '' : 'none';
    if (allWrap) allWrap.style.display = (mode === 'all' || mode === 'ytd') ? '' : 'none';
    if (allWrap) allWrap.textContent = mode === 'ytd' ? 'Year to date' : 'All recorded time';

    var allEntries = timesheetEntries || [];
    var filteredEntries;
    if (mode === 'all') {
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds.length === 10;
      });
    } else if (mode === 'week') {
      var wkStartD = parseYMD(timesheetWeekMondayYmd);
      var wkEndD = new Date(wkStartD.getFullYear(), wkStartD.getMonth(), wkStartD.getDate() + 6, 12, 0, 0, 0);
      var weekEndYmd = dateYMD(wkEndD);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= timesheetWeekMondayYmd && ds <= weekEndYmd;
      });
      var weekLabelEl = $('ts-week-label');
      if (weekLabelEl && !isNaN(wkStartD.getTime()) && !isNaN(wkEndD.getTime())) {
        var lo = { month: 'short', day: 'numeric', year: 'numeric' };
        weekLabelEl.textContent =
          wkStartD.toLocaleDateString('en-US', lo) + ' – ' + wkEndD.toLocaleDateString('en-US', lo);
      }
      var thisWeekMon = dateYMD(startOfWeekMonday(new Date()));
      var todayWeekBtn = $('ts-week-today');
      if (todayWeekBtn) todayWeekBtn.hidden = timesheetWeekMondayYmd === thisWeekMon;
    } else if (mode === 'month') {
      var y = parseInt(timesheetMonthYm.slice(0, 4), 10);
      var m0 = parseInt(timesheetMonthYm.slice(5, 7), 10) - 1;
      var monthFirst = new Date(y, m0, 1, 12, 0, 0, 0);
      var monthLast = new Date(y, m0 + 1, 0, 12, 0, 0, 0);
      var monthStartYmd = dateYMD(monthFirst);
      var monthEndYmd = dateYMD(monthLast);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= monthStartYmd && ds <= monthEndYmd;
      });
      var monthLabelEl = $('ts-month-label');
      if (monthLabelEl && !isNaN(monthFirst.getTime())) {
        monthLabelEl.textContent = monthFirst.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      }
      var nowM = new Date();
      var curYm = nowM.getFullYear() + '-' + String(nowM.getMonth() + 1).padStart(2, '0');
      var todayMonthBtn = $('ts-month-today');
      if (todayMonthBtn) todayMonthBtn.hidden = timesheetMonthYm === curYm;
    } else if (mode === 'quarter') {
      var q0m = (timesheetQuarterQ - 1) * 3;
      var qFirst = new Date(timesheetQuarterYear, q0m, 1, 12, 0, 0, 0);
      var qLast = new Date(timesheetQuarterYear, q0m + 3, 0, 12, 0, 0, 0);
      var qStartYmd = dateYMD(qFirst);
      var qEndYmd = dateYMD(qLast);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= qStartYmd && ds <= qEndYmd;
      });
      var quarterLabelEl = $('ts-quarter-label');
      if (quarterLabelEl) {
        quarterLabelEl.textContent = 'Q' + timesheetQuarterQ + ' ' + timesheetQuarterYear;
      }
      var cq = calendarQuarterFromDate(new Date());
      var todayQuarterBtn = $('ts-quarter-today');
      if (todayQuarterBtn) {
        todayQuarterBtn.hidden = timesheetQuarterYear === cq.year && timesheetQuarterQ === cq.q;
      }
    } else {
      var ytdStart = new Date(new Date().getFullYear(), 0, 1, 12, 0, 0, 0);
      var ytdEnd = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate(), 12, 0, 0, 0);
      var ytdStartYmd = dateYMD(ytdStart);
      var ytdEndYmd = dateYMD(ytdEnd);
      filteredEntries = allEntries.filter(function (e) {
        var ds = timesheetEntryYmd(e);
        return ds && ds >= ytdStartYmd && ds <= ytdEndYmd;
      });
    }

    var byEmp = {};
    var total = 0;
    var bill = 0;
    var non = 0;
    filteredEntries.forEach(function (e) {
      var key = (e.account || '').trim() || '—';
      if (!byEmp[key]) byEmp[key] = { total: 0, billable: 0, nonBillable: 0, entries: 0 };
      var mins = Math.max(0, Number(e.minutes) || 0);
      byEmp[key].total += mins;
      byEmp[key].entries += 1;
      if (e.billable) byEmp[key].billable += mins;
      else byEmp[key].nonBillable += mins;
      total += mins;
      if (e.billable) bill += mins;
      else non += mins;
    });

    var empKeys = Object.keys(byEmp).sort(function (a, b) { return byEmp[b].total - byEmp[a].total; });
    if (!empKeys.length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (table) table.style.display = 'none';
    } else {
      if (empty) empty.style.display = 'none';
      if (table) table.style.display = 'table';
      tbody.innerHTML = empKeys.map(function (k) {
        var row = byEmp[k];
        var util = row.total > 0 ? (row.billable / row.total * 100) : 0;
        return '<tr>' +
          '<td class="tdp">' + esc(k) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + formatMinutesToHours(row.total) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;color:var(--green);">' + formatMinutesToHours(row.billable) + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + formatMinutesToHours(row.nonBillable) + '</td>' +
          '<td>' + row.entries + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + util.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%</td>' +
        '</tr>';
      }).join('');
    }

    setText('ts-kpi-total', formatMinutesToHours(total));
    setText('ts-kpi-total-sub', filteredEntries.length + ' entries');
    setText('ts-kpi-billable', formatMinutesToHours(bill));
    setText('ts-kpi-billable-sub', total > 0 ? ((bill / total) * 100).toFixed(1) + '%' : '0.0%');
    setText('ts-kpi-nonbillable', formatMinutesToHours(non));
    setText('ts-kpi-nonbillable-sub', total > 0 ? ((non / total) * 100).toFixed(1) + '%' : '0.0%');
    setText('ts-kpi-employees', String(empKeys.length));
    setText('ts-kpi-avg', formatMinutesToHours(empKeys.length ? total / empKeys.length : 0));
    var avgSub = mode === 'all'
      ? 'all time'
      : mode === 'ytd'
        ? 'year to date'
        : mode === 'month'
          ? 'selected month'
          : mode === 'quarter'
            ? 'selected quarter'
            : 'selected week';
    setText('ts-kpi-avg-sub', avgSub);

    var subEmp = $('ts-sub-by-emp');
    var subLog = $('ts-sub-log');
    var rangePhrase = mode === 'all'
      ? 'all time'
      : mode === 'ytd'
        ? 'year to date'
        : mode === 'month'
          ? 'selected month'
          : mode === 'quarter'
            ? 'selected quarter'
            : 'selected week';
    if (subEmp) subEmp.textContent = 'Based on the Account field · ' + rangePhrase;
    if (subLog) subLog.textContent = 'Newest first · ' + rangePhrase;

    var list = filteredEntries.slice().sort(function (a, b) {
      var ad = (a.date || '') + ' ' + (a.createdAt || '');
      var bd = (b.date || '') + ' ' + (b.createdAt || '');
      return bd.localeCompare(ad);
    });
    if (!list.length) {
      logBody.innerHTML = '';
      if (logEmpty) logEmpty.style.display = 'block';
      if (logTable) logTable.style.display = 'none';
    } else {
      if (logEmpty) logEmpty.style.display = 'none';
      if (logTable) logTable.style.display = 'table';
      logBody.innerHTML = list.map(function (e) {
        var typ = e.billable ? '<span class="pl pg-g">Billable</span>' : '<span class="pl pg-a">Non-Billable</span>';
        var notes = e.notes ? esc(e.notes) : '—';
        return '<tr>' +
          '<td>' + esc(e.date || '—') + '</td>' +
          '<td class="tdp">' + esc(e.account || '—') + '</td>' +
          '<td>' + esc(e.project || '—') + '</td>' +
          '<td>' + esc(e.task || '—') + '</td>' +
          '<td>' + esc(e.activityCode || '—') + '</td>' +
          '<td style="font-variant-numeric:tabular-nums;">' + formatMinutesToHours(e.minutes) + '</td>' +
          '<td>' + typ + '</td>' +
          '<td>' + notes + '</td>' +
          '<td class="ts-row-actions">' +
            '<button type="button" class="btn" data-ts-edit="' + e.id + '" style="margin-right:6px;">Edit</button>' +
            '<button type="button" class="btn" data-ts-del="' + e.id + '" style="color:var(--red);">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }
  }

  function wireTimesheet() {
    var weekPrev = $('ts-week-prev');
    var weekNext = $('ts-week-next');
    var weekToday = $('ts-week-today');
    if (weekPrev) {
      weekPrev.addEventListener('click', function () {
        if (!timesheetWeekMondayYmd) timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
        var d = parseYMD(timesheetWeekMondayYmd);
        d.setDate(d.getDate() - 7);
        timesheetWeekMondayYmd = dateYMD(d);
        renderTimesheet();
      });
    }
    if (weekNext) {
      weekNext.addEventListener('click', function () {
        if (!timesheetWeekMondayYmd) timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
        var d = parseYMD(timesheetWeekMondayYmd);
        d.setDate(d.getDate() + 7);
        timesheetWeekMondayYmd = dateYMD(d);
        renderTimesheet();
      });
    }
    if (weekToday) {
      weekToday.addEventListener('click', function () {
        timesheetWeekMondayYmd = dateYMD(startOfWeekMonday(new Date()));
        renderTimesheet();
      });
    }

    var periodModeSel = $('ts-period-mode');
    if (periodModeSel) {
      periodModeSel.addEventListener('change', function () {
        timesheetPeriodMode = periodModeSel.value || 'week';
        timesheetEnsurePeriodAnchors();
        renderTimesheet();
      });
    }

    var monthPrev = $('ts-month-prev');
    var monthNext = $('ts-month-next');
    var monthToday = $('ts-month-today');
    if (monthPrev) {
      monthPrev.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        timesheetMonthYm = shiftMonthYm(timesheetMonthYm, -1);
        renderTimesheet();
      });
    }
    if (monthNext) {
      monthNext.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        timesheetMonthYm = shiftMonthYm(timesheetMonthYm, 1);
        renderTimesheet();
      });
    }
    if (monthToday) {
      monthToday.addEventListener('click', function () {
        var n = new Date();
        timesheetMonthYm = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
        renderTimesheet();
      });
    }

    var quarterPrev = $('ts-quarter-prev');
    var quarterNext = $('ts-quarter-next');
    var quarterToday = $('ts-quarter-today');
    if (quarterPrev) {
      quarterPrev.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        var s = shiftQuarter(timesheetQuarterYear, timesheetQuarterQ, -1);
        timesheetQuarterYear = s.year;
        timesheetQuarterQ = s.q;
        renderTimesheet();
      });
    }
    if (quarterNext) {
      quarterNext.addEventListener('click', function () {
        timesheetEnsurePeriodAnchors();
        var s = shiftQuarter(timesheetQuarterYear, timesheetQuarterQ, 1);
        timesheetQuarterYear = s.year;
        timesheetQuarterQ = s.q;
        renderTimesheet();
      });
    }
    if (quarterToday) {
      quarterToday.addEventListener('click', function () {
        var cq = calendarQuarterFromDate(new Date());
        timesheetQuarterYear = cq.year;
        timesheetQuarterQ = cq.q;
        renderTimesheet();
      });
    }

    var m = $('timesheetModal');
    var btnAdd = $('btn-add-time');
    var btnSave = $('btn-timesheet-save');
    var btnCancel = $('btn-timesheet-cancel');
    var toggleExternal = $('ts-toggle-external-note');
    var logTable = $('timesheet-log-table');
    if (!m) return;

    function openModal(editId) {
      var title = $('timesheet-modal-title');
      var eid = $('timesheet-edit-id');
      if (eid) eid.value = editId || '';
      var t = null;
      if (editId) {
        t = (timesheetEntries || []).find(function (x) { return x.id === editId; }) || null;
      }
      if (title) title.textContent = t ? 'Edit Time Entry' : 'Time Entry';
      $('ts-account').value = t ? (t.account || '') : '';
      $('ts-project').value = t ? (t.project || '') : '';
      $('ts-task').value = t ? (t.task || '') : '';
      $('ts-activity-code').value = t ? (t.activityCode || '') : '';
      if ($('ts-time')) {
        if (t && t.minutes != null) {
          var hh = String(Math.floor(t.minutes / 60)).padStart(2, '0');
          var mm = String((t.minutes % 60)).padStart(2, '0');
          $('ts-time').value = hh + ':' + mm;
        } else {
          $('ts-time').value = '01:00';
        }
      }
      if ($('ts-billable')) $('ts-billable').checked = t ? !!t.billable : true;
      if ($('ts-nonbillable')) $('ts-nonbillable').checked = t ? !t.billable : false;
      $('ts-notes').value = t ? (t.notes || '') : '';
      $('ts-external-note').value = t ? (t.externalNote || '') : '';
      var extWrap = $('ts-external-wrap');
      var showExt = !!(t && t.externalNote);
      if (extWrap) animateRollout(extWrap, showExt, true);
      if (toggleExternal) toggleExternal.textContent = showExt ? '− Hide External Note' : '+ Show External Note';
      var cbs = m.querySelectorAll('.ts-weekday-cb');
      cbs.forEach(function (cb) { cb.checked = false; });
      if (t && Array.isArray(t.weekdays) && t.weekdays.length) {
        cbs.forEach(function (cb) {
          var dow = parseInt(cb.getAttribute('data-dow'), 10);
          cb.checked = t.weekdays.indexOf(dow) !== -1;
        });
      }
      m.classList.add('on');
    }

    function closeModal() {
      m.classList.remove('on');
    }

    if (btnAdd) btnAdd.addEventListener('click', function () { openModal(''); });
    if (btnCancel) btnCancel.addEventListener('click', closeModal);
    if (toggleExternal) {
      toggleExternal.addEventListener('click', function (ev) {
        ev.preventDefault();
        var extWrap = $('ts-external-wrap');
        if (!extWrap) return;
        var show = extWrap.style.display === 'none' || !extWrap.classList.contains('on');
        animateRollout(extWrap, show, false);
        toggleExternal.textContent = show ? '− Hide External Note' : '+ Show External Note';
      });
    }
    if (btnSave) {
      btnSave.addEventListener('click', async function () {
        var account = $('ts-account').value.trim();
        var project = $('ts-project').value.trim();
        var task = $('ts-task').value.trim();
        var activityCode = $('ts-activity-code').value.trim();
        var minutes = parseTimeInputToMinutes($('ts-time').value);
        var notes = $('ts-notes').value.trim();
        var external = $('ts-external-note').value.trim();
        var billable = !!($('ts-billable') && $('ts-billable').checked);
        if (!account || !project || !task || !isFinite(minutes) || minutes <= 0) {
          alert('Account, Project, Task, and a valid time (HH:MM) are required.');
          return;
        }
        var editId = $('timesheet-edit-id') ? $('timesheet-edit-id').value : '';
        var selectedDow = [];
        m.querySelectorAll('.ts-weekday-cb').forEach(function (cb) {
          if (cb.checked) {
            var n = parseInt(cb.getAttribute('data-dow'), 10);
            if (!isNaN(n)) selectedDow.push(n);
          }
        });
        if (!selectedDow.length) {
          var td = new Date();
          selectedDow = [td.getDay()];
        }
        if (editId) {
          var changedEntry = null;
          timesheetEntries = (timesheetEntries || []).map(function (e) {
            if (e.id !== editId) return e;
            var date = e.date || dateYMD(new Date());
            changedEntry = {
              id: e.id,
              date: date,
              account: account,
              project: project,
              task: task,
              activityCode: activityCode,
              minutes: minutes,
              billable: billable,
              notes: notes,
              externalNote: external,
              weekdays: selectedDow.slice(),
              createdAt: e.createdAt || new Date().toISOString(),
            };
            return changedEntry;
          });
          if (changedEntry) await persistTimesheetEntryToSupabase(changedEntry);
        } else {
          var newEntries = [];
          var base = timesheetBaseMondayForNewEntry();
          if (isNaN(base.getTime())) base = startOfWeekMonday(new Date());
          selectedDow.forEach(function (dow) {
            var dt = new Date(base.getTime());
            var idx = dow === 0 ? 6 : (dow - 1);
            dt.setDate(base.getDate() + idx);
            var entry = {
              id: uuid(),
              date: dateYMD(dt),
              account: account,
              project: project,
              task: task,
              activityCode: activityCode,
              minutes: minutes,
              billable: billable,
              notes: notes,
              externalNote: external,
              weekdays: selectedDow.slice(),
              createdAt: new Date().toISOString(),
            };
            timesheetEntries.push(entry);
            newEntries.push(entry);
          });
          for (var i = 0; i < newEntries.length; i++) {
            await persistTimesheetEntryToSupabase(newEntries[i]);
          }
        }
        saveTimesheetEntries(timesheetEntries);
        renderTimesheet();
        closeModal();
      });
    }
    if (logTable) {
      logTable.addEventListener('click', function (ev) {
        var editBtn = ev.target.closest('[data-ts-edit]');
        if (editBtn) {
          var eid = editBtn.getAttribute('data-ts-edit');
          if (eid) openModal(eid);
          return;
        }
        var delBtn = ev.target.closest('[data-ts-del]');
        if (!delBtn) return;
        var did = delBtn.getAttribute('data-ts-del');
        if (!did) return;
        if (!confirm('Delete this time entry?')) return;
        timesheetEntries = (timesheetEntries || []).filter(function (e) { return e.id !== did; });
        saveTimesheetEntries(timesheetEntries);
        deleteTimesheetEntryRemote(did);
        renderTimesheet();
      });
    }
    if (m) {
      m.addEventListener('click', function (ev) {
        if (ev.target === m) closeModal();
      });
    }
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

  function renderIncomePowerFilterRows() {
    var host = $('income-power-filters');
    if (!host) return;
    var rows = incomePowerState.filters || [];
    host.innerHTML = rows.map(function (rule, idx) {
      var colOptions = incomePowerColumns.map(function (col) {
        return '<option value="' + col.id + '"' + (col.id === rule.column ? ' selected' : '') + '>' + esc(col.label) + '</option>';
      }).join('');
      var ops = incomeRuleOptionsForColumn(rule.column || 'source');
      var opOptions = ops.map(function (op) {
        return '<option value="' + op + '"' + (op === rule.op ? ' selected' : '') + '>' + esc(op) + '</option>';
      }).join('');
      var needsSecond = rule.op === 'between';
      return '<div class="power-filter-row" data-income-filter-row="' + idx + '">' +
        '<select class="fi" data-income-filter-col="' + idx + '">' + colOptions + '</select>' +
        '<select class="fi" data-income-filter-op="' + idx + '">' + opOptions + '</select>' +
        '<input class="fi" data-income-filter-value="' + idx + '" value="' + esc(rule.value || '') + '" placeholder="value" />' +
        (needsSecond ? '<input class="fi" data-income-filter-value2="' + idx + '" value="' + esc(rule.value2 || '') + '" placeholder="and value" />' : '') +
        '<button type="button" class="btn" data-income-filter-remove="' + idx + '">Remove</button>' +
      '</div>';
    }).join('');
  }

  function renderIncomePowerColumnChooser() {
    var grid = $('income-power-columns-grid');
    if (!grid) return;
    grid.innerHTML = incomePowerColumns.map(function (col) {
      var checked = incomePowerState.visible[col.id] !== false ? ' checked' : '';
      return '<label class="power-col-item"><input type="checkbox" data-income-col="' + esc(col.id) + '"' + checked + ' />' + esc(col.label) + '</label>';
    }).join('');
  }

  function applyIncomeBulkAction(action) {
    var selectedIds = Object.keys(incomePowerState.selected || {}).filter(function (id) { return incomePowerState.selected[id]; });
    if (!selectedIds.length) {
      alert('Select at least one row.');
      return;
    }
    if (action === 'export:selected') {
      var rows = (window.__incomePowerFilteredRows || []).filter(function (r) { return incomePowerState.selected[r.id]; });
      exportIncomeRowsCsv(rows, true);
      return;
    }
    if (action === 'delete:selected') {
      if (!confirm('Delete ' + selectedIds.length + ' selected income entr' + (selectedIds.length === 1 ? 'y' : 'ies') + '?')) return;
      deleteTransactionsByIds(selectedIds);
      incomePowerState.selected = {};
      return;
    }
    var txMap = {};
    selectedIds.forEach(function (id) { txMap[id] = true; });
    if (action === 'category:svc' || action === 'category:ret') {
      var nextCat = action.split(':')[1];
      state.transactions = state.transactions.map(function (tx) {
        if (!txMap[tx.id]) return tx;
        var next = Object.assign({}, tx, { category: nextCat });
        persistTransactionToSupabase(next);
        return next;
      });
      saveTransactions(state.transactions);
      recomputeAndRender();
      return;
    }
    if (action === 'invoice:paid' || action === 'invoice:sent') {
      var nextStatus = action.split(':')[1];
      invoices = invoices.map(function (inv) {
        if (!txMap[inv.incomeTxId]) return inv;
        var nextInv = Object.assign({}, inv, {
          status: nextStatus,
          paidAt: nextStatus === 'paid' ? new Date().toISOString().slice(0, 10) : null,
        });
        persistInvoiceToSupabase(nextInv);
        return nextInv;
      });
      saveInvoices(invoices);
      recomputeAndRender();
    }
  }

  function wireIncomePowerTable() {
    loadIncomePowerPrefs();
    loadIncomeTrendRange();
    renderIncomePowerColumnChooser();
    renderIncomePowerFilterRows();

    var trendRange = $('rev-trend-range');
    if (trendRange) {
      trendRange.value = incomeTrendRange;
      trendRange.addEventListener('change', function () {
        var v = trendRange.value;
        incomeTrendRange = (v === '30d' || v === '90d' || v === 'ytd' || v === 'all') ? v : '90d';
        saveIncomeTrendRange();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var search = $('income-power-search');
    if (search) {
      search.value = incomePowerState.search || '';
      search.addEventListener('input', function () {
        incomePowerState.search = search.value || '';
        saveIncomePowerPrefs();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var addFilter = $('income-power-add-filter');
    if (addFilter) {
      addFilter.addEventListener('click', function () {
        incomePowerState.filters.push({ column: 'source', op: 'contains', value: '' });
        saveIncomePowerPrefs();
        renderIncomePowerFilterRows();
      });
    }

    var colsBtn = $('income-power-columns');
    var colsPanel = $('income-power-columns-panel');
    if (colsBtn && colsPanel) {
      colsBtn.addEventListener('click', function () {
        colsPanel.classList.toggle('on');
      });
    }

    var filtersHost = $('income-power-filters');
    if (filtersHost) {
      filtersHost.addEventListener('input', function (ev) {
        var colIdx = ev.target.getAttribute('data-income-filter-col');
        var opIdx = ev.target.getAttribute('data-income-filter-op');
        var vIdx = ev.target.getAttribute('data-income-filter-value');
        var v2Idx = ev.target.getAttribute('data-income-filter-value2');
        if (colIdx != null) {
          var i = Number(colIdx);
          incomePowerState.filters[i].column = ev.target.value;
          incomePowerState.filters[i].op = incomeRuleOptionsForColumn(ev.target.value)[0];
        } else if (opIdx != null) {
          incomePowerState.filters[Number(opIdx)].op = ev.target.value;
        } else if (vIdx != null) {
          incomePowerState.filters[Number(vIdx)].value = ev.target.value;
        } else if (v2Idx != null) {
          incomePowerState.filters[Number(v2Idx)].value2 = ev.target.value;
        } else {
          return;
        }
        saveIncomePowerPrefs();
        renderIncomePowerFilterRows();
        if (state.computed) renderIncomeSection(state.computed);
      });
      filtersHost.addEventListener('click', function (ev) {
        var ridx = ev.target.getAttribute('data-income-filter-remove');
        if (ridx == null) return;
        incomePowerState.filters.splice(Number(ridx), 1);
        saveIncomePowerPrefs();
        renderIncomePowerFilterRows();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var colGrid = $('income-power-columns-grid');
    if (colGrid) {
      colGrid.addEventListener('change', function (ev) {
        var col = ev.target.getAttribute('data-income-col');
        if (!col) return;
        incomePowerState.visible[col] = !!ev.target.checked;
        var visibleCount = incomePowerColumns.filter(function (c) { return incomePowerState.visible[c.id] !== false; }).length;
        if (!visibleCount) {
          incomePowerState.visible[col] = true;
          ev.target.checked = true;
          alert('Keep at least one column visible.');
        }
        saveIncomePowerPrefs();
        if (state.computed) renderIncomeSection(state.computed);
      });
    }

    var applyBulk = $('income-power-apply-bulk');
    if (applyBulk) {
      applyBulk.addEventListener('click', function () {
        var sel = $('income-power-bulk-action');
        var action = sel ? sel.value : '';
        if (!action) return;
        applyIncomeBulkAction(action);
      });
    }
    var exportAll = $('income-power-export-all');
    if (exportAll) {
      exportAll.addEventListener('click', function () {
        exportIncomeRowsCsv(window.__incomePowerFilteredRows || [], false);
      });
    }

    var incomeTable = $('income-table');
    if (incomeTable) {
      incomeTable.addEventListener('change', function (ev) {
        var rid = ev.target.getAttribute('data-income-select');
        if (rid) {
          incomePowerState.selected[rid] = !!ev.target.checked;
          if (state.computed) renderIncomeSection(state.computed);
          return;
        }
        if (ev.target.id === 'income-power-select-all') {
          var checked = !!ev.target.checked;
          (window.__incomePowerFilteredRows || []).forEach(function (r) {
            incomePowerState.selected[r.id] = checked;
          });
          if (state.computed) renderIncomeSection(state.computed);
        }
      });
    }
  }

  function syncTransactionModalOtherFields() {
    var cat = $('tx-category') ? $('tx-category').value : '';
    var w1 = $('tx-other-wrapper');
    var w2 = $('tx-other-type-wrapper');
    var show = cat === 'oth';
    if (w1) animateRollout(w1, show, false);
    if (w2) animateRollout(w2, show, false);
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

  /** Local calendar YYYY-MM-DD (matches expandRecurringExpenseInstances "today"). */
  function todayLocalYMD() {
    var now = new Date();
    return dateYMD(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0));
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
    var todayStr = todayLocalYMD();
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
      // No legacy backfill: only auto-create instances on/after the day the user turned on recurring.
      var notBefore = rule.materializeNotBefore;
      if (notBefore && typeof notBefore === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(notBefore)) {
        dates = dates.filter(function (iso) { return iso >= notBefore; });
      }
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
          clientId: lead.clientId || null,
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
    if (panel && chk) animateRollout(panel, !!chk.checked, false);
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
    populateIncomeClientOptions();
    var editId = $('expense-edit-id');
    var fDate = $('expense-date');
    var fAmount = $('expense-amount');
    var fTitle = $('expense-title');
    var fCat = $('expense-category');
    var fVendor = $('expense-vendor');
    var fClient = $('expense-client');
    var fNotes = $('expense-notes');
    var recChk = $('expense-recurring');

    if (existingTx) {
      if (editId) editId.value = existingTx.id || '';
      if (fDate) fDate.value = existingTx.date || todayISO();
      if (fAmount) fAmount.value = existingTx.amount != null ? String(existingTx.amount) : '';
      if (fTitle) fTitle.value = (existingTx.title != null && existingTx.title !== '') ? existingTx.title : (existingTx.description || '');
      if (fCat) fCat.value = existingTx.categoryLabel || '';
      if (fVendor) fVendor.value = existingTx.vendor || '';
      if (fClient) fClient.value = existingTx.clientId || '';
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
      if (fClient) fClient.value = '';
      if (fNotes) fNotes.value = '';
      if (recChk) recChk.checked = false;
      resetExpenseRecurrenceUiDefaults();
    }
    syncExpenseRecurrenceRepeatRows();
    animateRollout($('expense-recurrence-panel'), !!(recChk && recChk.checked), true);
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
    if (isEdit && existing) {
      openFullInvoiceEditor(txId);
      return;
    }
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
    var serviceLabel = tx && tx.description ? tx.description : 'Project consulting';
    var det = inv && inv.invoiceDetails && typeof inv.invoiceDetails === 'object' ? inv.invoiceDetails : {};
    var lineItems = [];
    if (Array.isArray(det.lineItems) && det.lineItems.length) {
      det.lineItems.forEach(function (li) {
        if (!li || typeof li !== 'object') return;
        var qty = Math.max(0, Number(li.qty) || 0);
        var unit = Number(li.unitPrice);
        if (!isFinite(unit)) unit = 0;
        var desc = li.description != null ? String(li.description) : 'Item';
        lineItems.push({ description: desc, qty: qty || 1, unitPrice: unit, amount: (qty || 1) * unit });
      });
    }
    if (!lineItems.length) {
      var legacyAmt = Number(inv && inv.amount != null ? inv.amount : (tx && tx.amount ? tx.amount : 0));
      lineItems.push({ description: serviceLabel, qty: 1, unitPrice: legacyAmt, amount: legacyAmt });
    }
    var subtotal = lineItems.reduce(function (s, li) {
      return s + (Number(li.amount) || 0);
    }, 0);
    var taxPct =
      det &&
      typeof det === 'object' &&
      Object.prototype.hasOwnProperty.call(det, 'taxRate') &&
      typeof det.taxRate === 'number' &&
      isFinite(det.taxRate)
        ? det.taxRate
        : 10;
    var taxRate = taxPct / 100;
    var tax = subtotal * taxRate;
    var total = subtotal + tax;
    var taxLabel = taxPct ? String(taxPct) + '%' : '0%';

    var memoHtml = '';
    if (det.memo && String(det.memo).trim()) {
      memoHtml =
        '<div style="font-size:14px;color:#4c4c4c;margin-bottom:16px;line-height:1.5;"><strong>Memo:</strong> ' +
        esc(String(det.memo)) +
        '</div>';
    }

    var rowsHtml = lineItems
      .map(function (li) {
        return (
          '<tr>' +
          '<td style="padding:10px 0 8px;font-size:18px;font-weight:500;line-height:1.25;">' +
          esc(li.description) +
          '</td>' +
          '<td style="padding:10px 0 8px;font-size:18px;font-weight:500;">' +
          esc(fmtCurrencyPrecise(li.unitPrice)) +
          '</td>' +
          '<td style="padding:10px 0 8px;font-size:18px;font-weight:500;">' +
          esc(String(li.qty != null ? li.qty : 1)) +
          '</td>' +
          '<td style="padding:10px 0 8px;font-size:18px;font-weight:500;">' +
          esc(taxLabel) +
          '</td>' +
          '<td style="padding:10px 0 8px;font-size:18px;font-weight:500;text-align:right;">' +
          esc(fmtCurrencyPrecise(li.amount)) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    return '' +
      '<div style="max-width:860px;margin:0 auto;background:#fff;border-radius:16px;padding:54px 58px;color:#1f1f1f;font-family:\'Helvetica Now Pro Display Medium\',system-ui,-apple-system,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.08);">' +
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
        memoHtml +
        '<div style="border-radius:14px;background:#f5f5f5;padding:16px 18px;margin-bottom:18px;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:14px;">' +
            '<thead><tr style="color:#6d6d6d;text-align:left;">' +
              '<th style="padding:8px 0;font-weight:500;">Product</th>' +
              '<th style="padding:8px 0;font-weight:500;">Rate</th>' +
              '<th style="padding:8px 0;font-weight:500;">Qty</th>' +
              '<th style="padding:8px 0;font-weight:500;">Tax</th>' +
              '<th style="padding:8px 0;font-weight:500;text-align:right;">Amount</th>' +
            '</tr></thead>' +
            '<tbody>' +
            rowsHtml +
            '</tbody>' +
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

  /** User-facing income category for tables and the income modal; ledger still uses svc vs ret. */
  function displayIncomeCategory(tx) {
    if (!tx) return 'Services';
    var custom = tx.incomeCategoryLabel != null ? String(tx.incomeCategoryLabel).trim() : '';
    if (custom) return custom;
    return tx.category === 'ret' ? 'Retainer' : 'Services';
  }

  // ---------- CSV import & journal export (BYO data pipe) ----------

  var LAST_IMPORT_BATCH_KEY = 'last-import-batch:v1';
  var CSV_IMPORT_MAX_ROWS = 5000;

  function csvImportStoragePayload(batchId, ids) {
    return JSON.stringify({ batchId: batchId, ids: ids, at: Date.now() });
  }

  function loadLastImportBatch() {
    try {
      var raw = localStorage.getItem(storageKey(LAST_IMPORT_BATCH_KEY));
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !Array.isArray(o.ids) || !o.batchId) return null;
      if (Date.now() - (o.at || 0) > 86400000) return null;
      return o;
    } catch (_) {
      return null;
    }
  }

  function saveLastImportBatch(batchId, ids) {
    try {
      localStorage.setItem(storageKey(LAST_IMPORT_BATCH_KEY), csvImportStoragePayload(batchId, ids));
    } catch (_) {}
  }

  function clearLastImportBatch() {
    try {
      localStorage.removeItem(storageKey(LAST_IMPORT_BATCH_KEY));
    } catch (_) {}
  }

  function refreshUndoImportButtons() {
    var last = loadLastImportBatch();
    var en = !!(last && last.ids && last.ids.length);
    ['btn-undo-last-import', 'btn-undo-last-import-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.disabled = !en;
    });
  }

  function parseCsvLine(line) {
    var out = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && (ch === ',' || ch === ';')) {
        out.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  function detectCsvDelimiter(firstLine) {
    if (!firstLine) return ',';
    var semi = (firstLine.match(/;/g) || []).length;
    var com = (firstLine.match(/,/g) || []).length;
    return semi > com ? ';' : ',';
  }

  function splitCsvRows(text, delim) {
    var rows = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '"') {
        if (inQuotes && text[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        cur += ch;
        continue;
      }
      if (!inQuotes && ch === '\n') {
        if (cur.length || rows.length === 0) rows.push(cur);
        cur = '';
        continue;
      }
      if (!inQuotes && ch === '\r') continue;
      cur += ch;
    }
    if (cur.length || rows.length === 0) rows.push(cur);
    return rows.filter(function (r) {
      return String(r).trim().length > 0;
    });
  }

  function parseCsvToMatrix(text) {
    var lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) {
      return l.trim().length > 0;
    });
    if (!lines.length) return { headers: [], rows: [], delim: ',', warnings: ['File is empty.'] };
    var delim = detectCsvDelimiter(lines[0]);
    var headers = parseCsvLine(lines[0]).map(function (h) {
      return String(h || '').trim();
    });
    var rows = [];
    var warnings = [];
    var max = Math.min(lines.length - 1, CSV_IMPORT_MAX_ROWS);
    if (lines.length - 1 > CSV_IMPORT_MAX_ROWS) {
      warnings.push('Only the first ' + CSV_IMPORT_MAX_ROWS + ' data rows will be imported.');
    }
    for (var r = 1; r <= max; r++) {
      var cells = parseCsvLine(lines[r]);
      if (cells.length < headers.length) {
        while (cells.length < headers.length) cells.push('');
      } else if (cells.length > headers.length) {
        cells = cells.slice(0, headers.length);
      }
      rows.push(cells);
    }
    return { headers: headers, rows: rows, delim: delim, warnings: warnings };
  }

  function headerMatchScore(name, patterns) {
    var n = String(name || '').toLowerCase();
    var best = 0;
    for (var i = 0; i < patterns.length; i++) {
      if (n.indexOf(patterns[i]) !== -1) best = Math.max(best, patterns[i].length);
    }
    return best;
  }

  function guessCsvColumnIndices(headers) {
    var bestDate = -1;
    var bestDateScore = 0;
    var bestAmt = -1;
    var bestAmtScore = 0;
    var bestDebit = -1;
    var bestDebitScore = 0;
    var bestCredit = -1;
    var bestCreditScore = 0;
    var bestDesc = -1;
    var bestDescScore = 0;
    var bestExt = -1;
    var bestExtScore = 0;
    headers.forEach(function (h, idx) {
      var hs = headerMatchScore(h, [
        'transaction date',
        'posting date',
        'posted date',
        'date',
        'value date',
        'booking date',
      ]);
      if (hs > bestDateScore) {
        bestDateScore = hs;
        bestDate = idx;
      }
      hs = headerMatchScore(h, ['amount', 'amt', 'value']);
      if (hs > bestAmtScore && headerMatchScore(h, ['debit', 'credit']) === 0) {
        bestAmtScore = hs;
        bestAmt = idx;
      }
      hs = headerMatchScore(h, ['debit', 'withdraw', 'payment', 'outflow']);
      if (hs > bestDebitScore) {
        bestDebitScore = hs;
        bestDebit = idx;
      }
      hs = headerMatchScore(h, ['credit', 'deposit', 'inflow']);
      if (hs > bestCreditScore) {
        bestCreditScore = hs;
        bestCredit = idx;
      }
      hs = headerMatchScore(h, ['description', 'memo', 'details', 'narrative', 'payee', 'name', 'merchant']);
      if (hs > bestDescScore) {
        bestDescScore = hs;
        bestDesc = idx;
      }
      hs = headerMatchScore(h, ['transaction id', 'trans id', 'reference', 'fitid', 'id']);
      if (hs > bestExtScore) {
        bestExtScore = hs;
        bestExt = idx;
      }
    });
    return {
      dateIdx: bestDate,
      amountIdx: bestAmt,
      debitIdx: bestDebit,
      creditIdx: bestCredit,
      descIdx: bestDesc,
      extIdx: bestExt,
    };
  }

  function fillImpColumnSelects(headers, guess) {
    function opts(includeNone) {
      var o = [];
      if (includeNone) o.push('<option value="-1">— None —</option>');
      headers.forEach(function (h, i) {
        var lab = esc(String(h || 'Column ' + (i + 1)));
        o.push('<option value="' + i + '">' + lab + '</option>');
      });
      return o.join('');
    }
    var dateSel = $('imp-col-date');
    var amtSel = $('imp-col-amount');
    var debSel = $('imp-col-debit');
    var credSel = $('imp-col-credit');
    var descSel = $('imp-col-description');
    var extSel = $('imp-col-external');
    if (dateSel) dateSel.innerHTML = opts(false);
    if (amtSel) amtSel.innerHTML = opts(true);
    if (debSel) debSel.innerHTML = opts(true);
    if (credSel) credSel.innerHTML = opts(true);
    if (descSel) descSel.innerHTML = opts(false);
    if (extSel) extSel.innerHTML = opts(true);
    function setVal(sel, idx) {
      if (!sel || idx == null || idx < 0) return;
      if (idx < headers.length) sel.value = String(idx);
    }
    setVal(dateSel, guess.dateIdx);
    setVal(amtSel, guess.amountIdx);
    setVal(debSel, guess.debitIdx >= 0 ? guess.debitIdx : -1);
    setVal(credSel, guess.creditIdx >= 0 ? guess.creditIdx : -1);
    setVal(descSel, guess.descIdx >= 0 ? guess.descIdx : 0);
    setVal(extSel, guess.extIdx >= 0 ? guess.extIdx : -1);
  }

  function parseFlexibleMoney(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var neg = false;
    if (/^\(.*\)$/.test(s)) {
      neg = true;
      s = s.slice(1, -1).trim();
    }
    if (s[0] === '-') {
      neg = !neg;
      s = s.slice(1).trim();
    }
    s = s.replace(/[$€£\s]/g, '');
    var hasComma = s.indexOf(',') !== -1;
    var hasDot = s.indexOf('.') !== -1;
    if (hasComma && hasDot) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        s = s.replace(/,/g, '');
      }
    } else if (hasComma && !hasDot) {
      if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
      else s = s.replace(',', '.');
    } else if (!hasComma && hasDot && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, '');
    }
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    if (neg) n = -n;
    return n;
  }

  function parseFlexibleDate(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s) return null;
    var d = parseDate(s);
    if (d && !isNaN(d.getTime())) return dateYMD(d);
    var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      var mo = +m[1] - 1;
      var day = +m[2];
      var y = +m[3];
      if (y < 100) y += 2000;
      var d2 = new Date(y, mo, day, 12, 0, 0, 0);
      if (!isNaN(d2.getTime())) return dateYMD(d2);
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      var d3 = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
      if (!isNaN(d3.getTime())) return dateYMD(d3);
    }
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
      var d4 = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
      if (!isNaN(d4.getTime())) return dateYMD(d4);
    }
    return null;
  }

  function impSelectedIndex(sel) {
    if (!sel) return -1;
    var v = parseInt(sel.value, 10);
    return isNaN(v) ? -1 : v;
  }

  function txFingerprintForImport(dateYmd, amount, desc, ext) {
    var d = (desc || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return (dateYmd || '') + '|' + String(amount) + '|' + d + '|' + String(ext || '').trim();
  }

  function buildExistingImportFingerprints() {
    var ext = {};
    var fp = {};
    (state.transactions || []).forEach(function (t) {
      if (!t || !t.id) return;
      if (t.externalId) ext[String(t.externalId).trim()] = true;
      fp[txFingerprintForImport(t.date, t.amount, t.description || t.note || '', t.externalId)] = true;
    });
    return { extIds: ext, fps: fp };
  }

  function categoryLabelForJournal(code, tx) {
    if (code === 'svc' || code === 'ret') return displayIncomeCategory(tx);
    var m = {
      lab: 'Labor',
      sw: 'Software & tools',
      ads: 'Advertising',
      oth: 'Other',
      own: 'Owner investment',
    };
    return m[code] || code || '—';
  }

  function journalFlowForTx(tx) {
    var c = tx && tx.category;
    if (c === 'svc' || c === 'ret' || c === 'own') return 'Inflow';
    return 'Outflow';
  }

  function defaultJournalExportRange() {
    var f = state.filter || { mode: 'all', start: null, end: null };
    var end = new Date();
    var start = new Date(end.getTime());
    if (f.mode === 'range' && f.start && f.end) {
      return { start: f.start, end: f.end };
    }
    if (f.mode === 'month') {
      var y = end.getFullYear();
      var m0 = end.getMonth();
      var first = new Date(y, m0, 1, 12, 0, 0, 0);
      var last = new Date(y, m0 + 1, 0, 12, 0, 0, 0);
      return { start: dateYMD(first), end: dateYMD(last) };
    }
    start.setDate(start.getDate() - 89);
    return { start: dateYMD(start), end: dateYMD(end) };
  }

  function journalCsvEscapeCell(v) {
    return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  }

  function buildJournalCsvLines(startYmd, endYmd, format) {
    var lines = [];
    var txs = (state.transactions || []).filter(function (t) {
      if (!t || !t.date) return false;
      if (t.date < startYmd || t.date > endYmd) return false;
      return true;
    }).slice()
      .sort(function (a, b) {
        return (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id));
      });
    if (format === 'split') {
      lines.push('Date,Type,CategoryCode,CategoryLabel,Debit,Credit,Memo,ClientName,ProjectName,ExternalId');
    } else {
      lines.push('Date,Type,CategoryCode,CategoryLabel,Amount,Description,ClientName,ProjectName,ExternalId');
    }
    txs.forEach(function (tx) {
      var code = tx.category || '';
      var lab = categoryLabelForJournal(code, tx);
      var flow = journalFlowForTx(tx);
      var amt = Math.abs(Number(tx.amount || 0));
      var desc = tx.description || tx.note || tx.title || '';
      var ext = tx.externalId || '';
      var clientName = '';
      if (tx.clientId) {
        var cl = clients.find(function (c) { return c.id === tx.clientId; });
        if (cl) clientName = cl.companyName || cl.contactName || '';
      }
      var projName = '';
      if (tx.projectId) {
        var pr = projects.find(function (p) { return p.id === tx.projectId; });
        if (pr) projName = pr.name || '';
      }
      if (format === 'split') {
        var debit = '';
        var credit = '';
        if (flow === 'Outflow') debit = String(amt);
        else credit = String(amt);
        lines.push(
          journalCsvEscapeCell(tx.date) + ',' +
          journalCsvEscapeCell(flow) + ',' +
          journalCsvEscapeCell(code) + ',' +
          journalCsvEscapeCell(lab) + ',' +
          journalCsvEscapeCell(debit) + ',' +
          journalCsvEscapeCell(credit) + ',' +
          journalCsvEscapeCell(desc) + ',' +
          journalCsvEscapeCell(clientName) + ',' +
          journalCsvEscapeCell(projName) + ',' +
          journalCsvEscapeCell(ext)
        );
      } else {
        lines.push(
          journalCsvEscapeCell(tx.date) + ',' +
          journalCsvEscapeCell(flow) + ',' +
          journalCsvEscapeCell(code) + ',' +
          journalCsvEscapeCell(lab) + ',' +
          String(amt) + ',' +
          journalCsvEscapeCell(desc) + ',' +
          journalCsvEscapeCell(clientName) + ',' +
          journalCsvEscapeCell(projName) + ',' +
          journalCsvEscapeCell(ext)
        );
      }
    });
    return lines;
  }

  function downloadTextFile(filename, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  var impWizardState = {
    step: 1,
    matrix: null,
    previewTxs: [],
    batchId: null,
    lastSkipCount: 0,
  };

  function setImpStep(n) {
    impWizardState.step = n;
    var s1 = $('imp-step-1');
    var s2 = $('imp-step-2');
    var s3 = $('imp-step-3');
    var back = $('imp-back');
    var next = $('imp-next');
    var commit = $('imp-commit');
    if (s1) s1.style.display = n === 1 ? 'flex' : 'none';
    if (s2) s2.style.display = n === 2 ? 'block' : 'none';
    if (s3) s3.style.display = n === 3 ? 'flex' : 'none';
    if (back) back.style.display = n === 1 ? 'none' : 'inline-block';
    if (next) next.style.display = n === 3 ? 'none' : 'inline-block';
    if (commit) commit.style.display = n === 3 ? 'inline-block' : 'none';
  }

  function syncImpAmountModeUi() {
    var split = $('imp-amount-mode-split') && $('imp-amount-mode-split').checked;
    var wAmt = $('imp-wrap-col-amount');
    var wDeb = $('imp-wrap-col-debit');
    var wCred = $('imp-wrap-col-credit');
    if (wAmt) wAmt.style.display = split ? 'none' : '';
    if (wDeb) wDeb.style.display = split ? '' : 'none';
    if (wCred) wCred.style.display = split ? '' : 'none';
  }

  function buildImportPreviewTransactions() {
    var headers = impWizardState.matrix && impWizardState.matrix.headers;
    var rows = impWizardState.matrix && impWizardState.matrix.rows;
    if (!headers || !rows) return [];
    var dateIdx = impSelectedIndex($('imp-col-date'));
    var descIdx = impSelectedIndex($('imp-col-description'));
    var extIdx = impSelectedIndex($('imp-col-external'));
    var split = $('imp-amount-mode-split') && $('imp-amount-mode-split').checked;
    var amtIdx = impSelectedIndex($('imp-col-amount'));
    var debIdx = impSelectedIndex($('imp-col-debit'));
    var credIdx = impSelectedIndex($('imp-col-credit'));
    var defCat = $('imp-default-exp-cat') ? $('imp-default-exp-cat').value : 'infer';
    var importRev = $('imp-import-revenue') && $('imp-import-revenue').checked;
    var skipDup = $('imp-skip-dupes') && $('imp-skip-dupes').checked;
    var existing = skipDup ? buildExistingImportFingerprints() : { extIds: {}, fps: {} };
    var out = [];
    var skipped = 0;
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r];
      if (dateIdx < 0 || dateIdx >= cells.length) {
        skipped++;
        continue;
      }
      var dateY = parseFlexibleDate(cells[dateIdx]);
      if (!dateY) {
        skipped++;
        continue;
      }
      var desc = '';
      if (descIdx >= 0 && descIdx < cells.length) desc = String(cells[descIdx] || '').trim();
      var ext = '';
      if (extIdx >= 0 && extIdx < cells.length) ext = String(cells[extIdx] || '').trim();
      var signed = null;
      if (split) {
        var dv = debIdx >= 0 && debIdx < cells.length ? parseFlexibleMoney(cells[debIdx]) : null;
        var cv = credIdx >= 0 && credIdx < cells.length ? parseFlexibleMoney(cells[credIdx]) : null;
        var debitAmt = dv == null || isNaN(dv) ? 0 : Math.abs(dv);
        var creditAmt = cv == null || isNaN(cv) ? 0 : Math.abs(cv);
        if (debitAmt > 0 && creditAmt > 0) {
          skipped++;
          continue;
        }
        if (debitAmt > 0) signed = -debitAmt;
        else if (creditAmt > 0) signed = creditAmt;
      } else {
        if (amtIdx < 0 || amtIdx >= cells.length) {
          skipped++;
          continue;
        }
        signed = parseFlexibleMoney(cells[amtIdx]);
      }
      if (signed == null || isNaN(signed) || signed === 0) {
        skipped++;
        continue;
      }
      var flowOut = signed < 0;
      var amountPos = Math.abs(signed);
      var cat;
      if (flowOut) {
        if (defCat === 'infer') cat = mapExpenseCategory(desc);
        else cat = defCat;
      } else {
        if (!importRev) {
          skipped++;
          continue;
        }
        cat = mapIncomeCategory(desc);
      }
      var fp = txFingerprintForImport(dateY, amountPos, desc, ext);
      if (skipDup) {
        if (ext && existing.extIds[ext]) {
          skipped++;
          continue;
        }
        if (existing.fps[fp]) {
          skipped++;
          continue;
        }
        existing.fps[fp] = true;
        if (ext) existing.extIds[ext] = true;
      }
      out.push({
        date: dateY,
        description: desc || 'Imported',
        amount: amountPos,
        category: cat,
        externalId: ext || undefined,
        rawMemo: desc,
        flowLabel: flowOut ? 'Outflow' : 'Inflow',
      });
    }
    impWizardState.lastSkipCount = skipped;
    return out;
  }

  function renderImpPreviewTable(preview) {
    var tb = $('imp-preview-body');
    var sum = $('imp-preview-summary');
    if (sum) {
      var sk = impWizardState.lastSkipCount || 0;
      sum.textContent =
        'Ready to import ' +
        preview.length +
        ' row(s). ' +
        (sk ? sk + ' row(s) skipped (invalid or filtered).' : '');
    }
    if (!tb) return;
    var show = preview.slice(0, 50);
    var catLab = { lab: 'Labor', sw: 'Software & tools', ads: 'Advertising', oth: 'Other', svc: 'Services', ret: 'Retainers', own: 'Owner investment' };
    tb.innerHTML = show
      .map(function (p) {
        var cLab = catLab[p.category] || p.category || '—';
        return (
          '<tr><td>' +
          esc(p.date) +
          '</td><td>' +
          esc(p.flowLabel) +
          '</td><td>' +
          esc(cLab) +
          '</td><td class="tdp">' +
          esc(fmtCurrency(p.amount)) +
          '</td><td style="max-width:220px;" class="td-truncate" title="' +
          escAttr(p.description) +
          '">' +
          esc(p.description) +
          '</td></tr>'
        );
      })
      .join('');
    if (preview.length > 50 && sum) {
      sum.textContent += ' Showing first 50 rows in preview.';
    }
    var commit = $('imp-commit');
    if (commit) commit.textContent = 'Import ' + preview.length + ' row(s)';
  }

  async function persistImportedTransactionsThrottled(list) {
    if (isDemoDashboardUser()) return;
    for (var i = 0; i < list.length; i++) {
      await persistTransactionToSupabase(list[i]);
      if (i % 20 === 19) {
        await new Promise(function (res) {
          setTimeout(res, 40);
        });
      }
    }
  }

  function wireCsvImportAndJournalExport() {
    var modalImp = $('csvImportModal');
    var modalJ = $('journalExportModal');

    function openJournalExportModal() {
      if (!modalJ) return;
      var b = defaultJournalExportRange();
      var a = $('journal-exp-start');
      var e = $('journal-exp-end');
      if (a) a.value = b.start;
      if (e) e.value = b.end;
      var fmt = $('journal-exp-format');
      if (fmt) fmt.value = 'simple';
      modalJ.classList.add('on');
    }

    function closeJournalExportModal() {
      if (modalJ) modalJ.classList.remove('on');
    }

    function openCsvImportModal() {
      if (!modalImp) return;
      impWizardState = { step: 1, matrix: null, previewTxs: [], batchId: null, lastSkipCount: 0 };
      var f = $('imp-file');
      if (f) f.value = '';
      var st = $('imp-file-status');
      if (st) st.textContent = '';
      if ($('imp-import-revenue')) $('imp-import-revenue').checked = false;
      if ($('imp-skip-dupes')) $('imp-skip-dupes').checked = true;
      if ($('imp-amount-mode-single')) $('imp-amount-mode-single').checked = true;
      syncImpAmountModeUi();
      setImpStep(1);
      modalImp.classList.add('on');
    }

    function closeCsvImportModal() {
      if (modalImp) modalImp.classList.remove('on');
    }

    ['btn-csv-import-open', 'btn-csv-import-open-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', openCsvImportModal);
    });
    ['btn-journal-export-open', 'btn-journal-export-open-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', openJournalExportModal);
    });

    function runUndoLastImport() {
      var last = loadLastImportBatch();
      if (!last || !last.ids || !last.ids.length) return;
      if (!confirm('Remove the last CSV import (' + last.ids.length + ' transaction(s)) from this workspace?')) return;
      deleteTransactionsByIds(last.ids.slice());
      clearLastImportBatch();
      refreshUndoImportButtons();
    }
    ['btn-undo-last-import', 'btn-undo-last-import-settings'].forEach(function (id) {
      var b = $(id);
      if (b) b.addEventListener('click', runUndoLastImport);
    });

    var amtModeSingle = $('imp-amount-mode-single');
    var amtModeSplit = $('imp-amount-mode-split');
    if (amtModeSingle) amtModeSingle.addEventListener('change', syncImpAmountModeUi);
    if (amtModeSplit) amtModeSplit.addEventListener('change', syncImpAmountModeUi);

    var impFile = $('imp-file');
    if (impFile) {
      impFile.addEventListener('change', function () {
        var st = $('imp-file-status');
        var file = impFile.files && impFile.files[0];
        if (!file) {
          if (st) st.textContent = '';
          impWizardState.matrix = null;
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || '');
          var matrix = parseCsvToMatrix(text);
          impWizardState.matrix = matrix;
          var msg =
            'Found ' +
            matrix.rows.length +
            ' data row(s), ' +
            matrix.headers.length +
            ' column(s). Delimiter: ' +
            (matrix.delim === ';' ? 'semicolon' : 'comma') +
            '.';
          if (matrix.warnings && matrix.warnings.length) msg += ' ' + matrix.warnings.join(' ');
          if (st) st.textContent = msg;
        };
        reader.onerror = function () {
          if (st) st.textContent = 'Could not read file.';
          impWizardState.matrix = null;
        };
        reader.readAsText(file);
      });
    }

    var impNext = $('imp-next');
    if (impNext) {
      impNext.addEventListener('click', function () {
        if (impWizardState.step === 1) {
          if (!impWizardState.matrix || !impWizardState.matrix.headers.length) {
            alert('Choose a CSV file with a header row first.');
            return;
          }
          var guess = guessCsvColumnIndices(impWizardState.matrix.headers);
          fillImpColumnSelects(impWizardState.matrix.headers, guess);
          syncImpAmountModeUi();
          setImpStep(2);
          return;
        }
        if (impWizardState.step === 2) {
          var dateIdx = impSelectedIndex($('imp-col-date'));
          if (dateIdx < 0) {
            alert('Pick a date column.');
            return;
          }
          var split = $('imp-amount-mode-split') && $('imp-amount-mode-split').checked;
          if (split) {
            if (impSelectedIndex($('imp-col-debit')) < 0 && impSelectedIndex($('imp-col-credit')) < 0) {
              alert('Pick a Debit and/or Credit column.');
              return;
            }
          } else if (impSelectedIndex($('imp-col-amount')) < 0) {
            alert('Pick an amount column (or switch to Debit/Credit).');
            return;
          }
          impWizardState.previewTxs = buildImportPreviewTransactions();
          if (!impWizardState.previewTxs.length) {
            alert('No importable rows. Check column mapping and that outflows are negative in single-amount mode (or use Debit/Credit).');
            return;
          }
          renderImpPreviewTable(impWizardState.previewTxs);
          setImpStep(3);
        }
      });
    }

    var impBack = $('imp-back');
    if (impBack) {
      impBack.addEventListener('click', function () {
        if (impWizardState.step === 3) setImpStep(2);
        else if (impWizardState.step === 2) setImpStep(1);
      });
    }

    var impCancel = $('imp-cancel');
    if (impCancel) impCancel.addEventListener('click', closeCsvImportModal);

    var impCommit = $('imp-commit');
    if (impCommit) {
      impCommit.addEventListener('click', async function () {
        var preview = impWizardState.previewTxs || [];
        if (!preview.length) return;
        var batchId = uuid();
        var created = [];
        preview.forEach(function (p) {
          var tx = {
            id: uuid(),
            date: p.date,
            description: p.description,
            amount: p.amount,
            category: p.category,
            importBatchId: batchId,
            importSource: 'csv',
            createdAt: new Date().toISOString(),
          };
          if (p.externalId) tx.externalId = p.externalId;
          if (p.rawMemo) tx.rawMemo = p.rawMemo;
          state.transactions.push(tx);
          created.push(tx);
        });
        saveTransactions(state.transactions);
        recomputeAndRender();
        await persistImportedTransactionsThrottled(created);
        saveLastImportBatch(
          batchId,
          created.map(function (t) {
            return t.id;
          })
        );
        refreshUndoImportButtons();
        closeCsvImportModal();
      });
    }

    if (modalImp) {
      modalImp.addEventListener('click', function (ev) {
        if (ev.target === modalImp) closeCsvImportModal();
      });
    }

    var jCancel = $('journal-exp-cancel');
    if (jCancel) jCancel.addEventListener('click', closeJournalExportModal);
    var jDown = $('journal-exp-download');
    if (jDown) {
      jDown.addEventListener('click', function () {
        var a = $('journal-exp-start');
        var e = $('journal-exp-end');
        var startY = a && a.value ? a.value : defaultJournalExportRange().start;
        var endY = e && e.value ? e.value : defaultJournalExportRange().end;
        if (!startY || !endY || startY > endY) {
          alert('Pick a valid start and end date.');
          return;
        }
        var fmtEl = $('journal-exp-format');
        var fmt = fmtEl && fmtEl.value === 'split' ? 'split' : 'simple';
        var lines = buildJournalCsvLines(startY, endY, fmt);
        downloadTextFile('journal-export.csv', lines.join('\n'));
        closeJournalExportModal();
      });
    }
    if (modalJ) {
      modalJ.addEventListener('click', function (ev) {
        if (ev.target === modalJ) closeJournalExportModal();
      });
    }

    refreshUndoImportButtons();
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
        var clientIdRaw = $('expense-client') ? $('expense-client').value : '';
        var expenseClientId = clientIdRaw ? clientIdRaw : null;

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
              clientId: expenseClientId,
            };
            if (recurring) {
              next.recurrenceSeriesId = (prevTx && prevTx.recurrenceSeriesId) ? prevTx.recurrenceSeriesId : uuid();
              next.expenseRecurringLead = true;
              next.recurrence = readExpenseRecurrenceRuleFromUi(date);
              if (prevTx && prevTx.recurrence && prevTx.recurrence.materializeNotBefore) {
                next.recurrence.materializeNotBefore = prevTx.recurrence.materializeNotBefore;
              } else {
                next.recurrence.materializeNotBefore = todayLocalYMD();
              }
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
            var recRule = readExpenseRecurrenceRuleFromUi(date);
            recRule.materializeNotBefore = todayLocalYMD();
            addTransaction({
              id: uuid(),
              date: date,
              title: titleTrim,
              vendor: vendorTrim,
              notes: notesTrim,
              description: desc,
              amount: amount,
              category: cat,
              clientId: expenseClientId,
              recurrenceSeriesId: seriesId,
              expenseRecurringLead: true,
              recurrence: recRule,
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
              clientId: expenseClientId,
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
        var catText = ($('income-category').value || '').trim();
        var notes = $('income-notes').value || '';
        var cat = mapIncomeCategory(catText);
        var desc = source || notes;
        var clientId = $('income-client') ? $('income-client').value : '';
        var projectId = $('income-project') ? $('income-project').value : '';
        var editId = $('income-edit-id') ? $('income-edit-id').value : '';
        if (editId) {
          state.transactions = state.transactions.map(function (tx) {
            if (tx.id !== editId) return tx;
            var next = Object.assign({}, tx, {
              date: date,
              description: desc,
              amount: amount,
              category: cat,
              clientId: clientId || null,
              projectId: projectId || null,
            });
            if (catText) next.incomeCategoryLabel = catText;
            else delete next.incomeCategoryLabel;
            return next;
          });
          saveTransactions(state.transactions);
          recomputeAndRender();
          var incomeUpdated = state.transactions.find(function (t) { return t.id === editId; });
          if (incomeUpdated) persistTransactionToSupabase(incomeUpdated);
        } else {
          var newInc = {
            id: uuid(),
            date: date,
            description: desc,
            amount: amount,
            category: cat,
            clientId: clientId || null,
            projectId: projectId || null,
          };
          if (catText) newInc.incomeCategoryLabel = catText;
          addTransaction(newInc);
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
            return Object.assign({}, inv, {
              id: inv.id,
              incomeTxId: txId,
              number: number,
              dateIssued: issueDate,
              dueDate: dueDate,
              amount: amount,
              status: inv.status || 'sent',
              paidAt: inv.paidAt || null,
            });
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
            clientId: tx.clientId,
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
          (async function () {
            await wfRefreshFromSupabase();
            populateClientIndustryDatalist();
            var hiddenId = $('client-edit-id');
            if (hiddenId) hiddenId.value = client.id;
            $('client-company').value = client.companyName || '';
            $('client-contact').value = client.contactName || '';
            $('client-status').value = client.status || '';
            $('client-industry').value = client.industry || '';
            $('client-email').value = client.email || '';
            $('client-phone').value = client.phone || '';
            $('client-notes').value = client.notes || '';
            if ($('client-salutation')) $('client-salutation').value = client.salutation || '';
            if ($('client-first-name')) $('client-first-name').value = client.firstName || '';
            if ($('client-last-name')) $('client-last-name').value = client.lastName || '';
            if ($('client-title')) $('client-title').value = client.title || '';
            if ($('client-reports-to')) $('client-reports-to').value = client.reportsTo || '';
            if ($('client-description')) $('client-description').value = client.description || '';
            if ($('client-owner')) $('client-owner').value = client.owner || '';
            if ($('client-mailing-country')) $('client-mailing-country').value = client.mailingCountry || '';
            if ($('client-mailing-street')) $('client-mailing-street').value = client.mailingStreet || '';
            if ($('client-mailing-city')) $('client-mailing-city').value = client.mailingCity || '';
            if ($('client-mailing-state')) $('client-mailing-state').value = client.mailingState || '';
            if ($('client-mailing-zip')) $('client-mailing-zip').value = client.mailingZip || '';
            if ($('client-email-opt-out')) $('client-email-opt-out').checked = client.emailOptOut === true;
            if ($('client-birthday')) $('client-birthday').value = client.birthday || '';
            if ($('client-preferred-channel')) $('client-preferred-channel').value = client.preferredChannel || '';
            if ($('client-communication-style')) $('client-communication-style').value = client.communicationStyle || '';
            if ($('client-last-touch')) $('client-last-touch').value = client.lastTouchAt || '';
            if ($('client-next-follow-up')) $('client-next-follow-up').value = client.nextFollowUpAt || '';
            if ($('client-relationship-notes')) $('client-relationship-notes').value = client.relationshipNotes || '';
            var cr = $('client-cust-revenue');
            var cc = $('client-cust-cost');
            if (cr) cr.value = client.custTabRevenue != null ? String(client.custTabRevenue) : '';
            if (cc) cc.value = client.custTabAllocatedCost != null ? String(client.custTabAllocatedCost) : '';
            var retCb = $('client-retainer');
            if (retCb) retCb.checked = client.retainer === true;
            wfFillClientPipelineSelect($('client-pipeline-stage'), client);
            m.classList.add('on');
          })();
          return;
        }

        var meetBtn = ev.target.closest('[data-log-meeting]');
        if (meetBtn) {
          var mid = meetBtn.getAttribute('data-log-meeting');
          var cl = clients.find(function (c) { return c.id === mid; });
          if (!cl) return;
          var notes = window.prompt('Meeting notes (optional):', '') || '';
          (async function () {
            var act = await wfInsertActivity(cl.id, 'meeting', notes, new Date().toISOString());
            if (act) {
              await addCrmEvent('meeting', 'Meeting logged for ' + (cl.companyName || 'client'), { notes: notes, activityId: act.id }, cl.id, 'meeting:' + act.id);
              await runWorkflowDispatch({ kind: 'activity_created', activity: { id: act.id, activity_type: act.activity_type }, client: wfCloneClientForWorkflow(cl) });
              renderPersonableCards();
            } else {
              alert('Could not save meeting (sign in and ensure crm_activities table exists — run workflow_automation.sql).');
            }
          })();
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
          var detBody = $('project-case-study-body');
          if (det && detBody) {
            det.open = false;
            animateRollout(detBody, false, true);
          }
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

        var payBtn = ev.target.closest('[data-income-invoice-pay]');
        if (payBtn) {
          var payTxId = payBtn.getAttribute('data-income-invoice-pay');
          if (!payTxId) return;
          var invPay = getInvoiceByIncomeTxId(payTxId);
          if (!invPay) {
            alert('Create the invoice first.');
            return;
          }
          startStripeCheckoutForInvoice(invPay);
          return;
        }

        var paidBtn = ev.target.closest('[data-income-invoice-paid]');
        if (paidBtn) {
          var paidTxId = paidBtn.getAttribute('data-income-invoice-paid');
          if (!paidTxId) return;
          invoices = invoices.map(function (inv) {
            if (inv.incomeTxId !== paidTxId) return inv;
            return Object.assign({}, inv, {
              status: 'paid',
              paidAt: new Date().toISOString().slice(0, 10),
            });
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
          if (fCat) fCat.value = displayIncomeCategory(tx);
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

  function wireExpensesTableSort() {
    var expTable = $('expenses-table');
    if (!expTable || expTable.getAttribute('data-exp-sort-wired') === '1') return;
    var thead = expTable.querySelector('thead');
    if (!thead) return;
    expTable.setAttribute('data-exp-sort-wired', '1');

    function onHeaderActivate(th) {
      var k = th.getAttribute('data-exp-sort');
      if (!k) return;
      if (expensesTableSort.key === k) {
        expensesTableSort.dir = expensesTableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        expensesTableSort.key = k;
        expensesTableSort.dir = defaultExpensesSortDir(k);
      }
      renderAll();
    }

    thead.addEventListener('click', function (ev) {
      var th = ev.target.closest('th[data-exp-sort]');
      if (!th || !thead.contains(th)) return;
      ev.preventDefault();
      onHeaderActivate(th);
    });

    thead.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      var th = ev.target.closest('th[data-exp-sort]');
      if (!th || !thead.contains(th)) return;
      ev.preventDefault();
      onHeaderActivate(th);
    });
  }

  function userHasEmailPasswordIdentity(user) {
    if (!user) return false;
    function provIsEmail(p) {
      return p != null && String(p).toLowerCase() === 'email';
    }
    if (Array.isArray(user.identities) && user.identities.length) {
      var hit = user.identities.some(function (id) {
        return id && provIsEmail(id.provider);
      });
      if (hit) return true;
    }
    var meta = user.app_metadata;
    if (meta && typeof meta === 'object') {
      if (provIsEmail(meta.provider)) return true;
      if (Array.isArray(meta.providers)) {
        for (var i = 0; i < meta.providers.length; i++) {
          if (provIsEmail(meta.providers[i])) return true;
        }
      }
    }
    return false;
  }

  var PROFILE_AVATAR_STORAGE_KEY = 'bizdash.profileAvatarDataUrl';

  function getStoredProfileAvatarDataUrl() {
    try {
      var raw = localStorage.getItem(PROFILE_AVATAR_STORAGE_KEY) || '';
      if (raw && raw.indexOf('data:image') === 0 && raw.length < 3500000) return raw;
    } catch (_) {}
    return '';
  }

  /**
   * Profile photo: signed URL for `user_metadata.profile_avatar_path` on brand-assets, else legacy localStorage data URL.
   */
  async function resolveProfileAvatarDisplayUrl(user) {
    if (!user) return '';
    if (
      user.user_metadata &&
      user.user_metadata.profile_avatar_path &&
      window.supabaseClient &&
      !isDemoDashboardUser()
    ) {
      var path = String(user.user_metadata.profile_avatar_path).trim();
      if (path) {
        try {
          var res = await window.supabaseClient.storage
            .from('brand-assets')
            .createSignedUrl(path, 60 * 60 * 24);
          if (res && res.data && res.data.signedUrl) return res.data.signedUrl;
        } catch (_) {}
      }
    }
    return getStoredProfileAvatarDataUrl();
  }

  /** Profile panel + sidebar account circle (user avatar). Workspace chip uses org icon from prefs. */
  async function applyProfileAvatarFromUser(user) {
    var resolved =
      arguments.length && user === null ? null : user || window.currentUser || currentUser;
    var displayUrl = resolved ? await resolveProfileAvatarDisplayUrl(resolved) : '';
    var img = document.getElementById('profile-avatar-img');
    var fb = document.getElementById('profile-avatar-fallback');
    if (displayUrl) {
      if (img) {
        img.src = displayUrl;
        img.style.display = 'block';
      }
      if (fb) fb.style.display = 'none';
    } else {
      if (img) {
        img.removeAttribute('src');
        img.style.display = 'none';
      }
      if (fb) {
        fb.style.display = '';
        updateProfileAvatarFallbackLetter();
      }
    }
    var userAv = document.getElementById('user-avatar');
    if (userAv) {
      if (displayUrl) {
        userAv.innerHTML = '';
        var imu = document.createElement('img');
        imu.src = displayUrl;
        imu.alt = '';
        imu.width = 26;
        imu.height = 26;
        imu.style.borderRadius = '50%';
        imu.style.objectFit = 'cover';
        imu.style.display = 'block';
        userAv.appendChild(imu);
      } else {
        userAv.innerHTML = '';
        if (resolved && resolved.email) {
          userAv.textContent = String(resolved.email).charAt(0).toUpperCase();
        } else {
          userAv.textContent = '?';
        }
      }
    }
  }

  function applyWorkspaceChromeProfileAvatar() {
    void applyProfileAvatarFromUser(window.currentUser || currentUser).then(function () {
      return refreshWorkspaceSidebarMonogramFromPrefs();
    });
  }
  window.bizdashRefreshSidebarProfileAvatars = applyWorkspaceChromeProfileAvatar;
  window.bizdashApplyProfileAvatarFromUser = applyProfileAvatarFromUser;

  function syncProfileTimezoneOptionsFromMain() {
    ensurePreferenceTimezoneOptionsBuilt();
    var main = document.getElementById('pref-timezone');
    var prof = document.getElementById('profile-pref-timezone');
    var profIn = document.getElementById('profile-pref-timezone-input');
    if (!main || !prof) return;
    prof.value = main.value;
    if (profIn) profIn.value = prof.value || '';
  }

  function syncPrefsToProfilePanel() {
    var prefs = window.__bizdashPreferences || readPreferencesFromDom();
    applyPreferencesToForm(prefs);
    applyPreferencesRuntime(prefs);
    syncProfileTimezoneOptionsFromMain();
    var profTz = document.getElementById('profile-pref-timezone');
    var mainTz = document.getElementById('pref-timezone');
    if (profTz && mainTz) profTz.value = mainTz.value || prefs.timezone;
    /* Week start: applyPreferencesToForm + syncProfileWeekSelectFromMainCheckbox keep profile select aligned. */
    updateProfileAvatarFallbackLetter();
  }

  function syncProfilePanelToPrefs() {
    var pt = document.getElementById('profile-pref-timezone');
    var pw = document.getElementById('profile-pref-week-start');
    var auto = document.getElementById('pref-timezone-auto');
    var wk = document.getElementById('pref-week-starts-mon');
    var tz = document.getElementById('pref-timezone');
    if (auto) auto.checked = false;
    if (tz && pt) tz.value = pt.value;
    if (wk && pw) wk.checked = pw.value === 'monday';
  }

  function updateProfileAvatarFallbackLetter() {
    var fn = document.getElementById('profile-first-name');
    var em = document.getElementById('profile-primary-email');
    var fb = document.getElementById('profile-avatar-fallback');
    var img = document.getElementById('profile-avatar-img');
    if (img && img.style.display !== 'none' && img.getAttribute('src')) return;
    var ch = (fn && fn.value && String(fn.value).trim()[0]) || (em && em.value && String(em.value)[0]) || '?';
    if (fb) fb.textContent = String(ch).toUpperCase();
  }

  function applyProfileAvatarFromStorage() {
    void applyProfileAvatarFromUser(window.currentUser || currentUser);
  }

  function syncAdvisorChatShellGreeting() {
    var leadEl = document.getElementById('chat-greeting-lead');
    if (!leadEl) return;
    var first = '';
    var fnInp = document.getElementById('profile-first-name');
    if (fnInp && String(fnInp.value || '').trim()) {
      first = String(fnInp.value || '').trim();
    } else {
      var user = window.currentUser;
      if (user && user.user_metadata && typeof user.user_metadata === 'object') {
        var m = user.user_metadata;
        first = m.first_name != null ? String(m.first_name).trim() : '';
        if (!first && m.full_name) {
          var parts = String(m.full_name).trim().split(/\s+/);
          first = parts[0] || '';
        }
      }
    }
    leadEl.textContent = first ? 'Welcome back, ' + first : 'Welcome back';
  }

  window.bizDashSyncAdvisorChatShellGreeting = syncAdvisorChatShellGreeting;

  function hydrateProfileFieldsFromUser(user) {
    var fn = document.getElementById('profile-first-name');
    var ln = document.getElementById('profile-last-name');
    var em = document.getElementById('profile-primary-email');
    if (!fn || !ln) {
      syncAdvisorChatShellGreeting();
      return;
    }
    if (!user) {
      fn.value = '';
      ln.value = '';
      if (em) em.value = '';
      try {
        localStorage.removeItem(PROFILE_AVATAR_STORAGE_KEY);
      } catch (_) {}
      void applyProfileAvatarFromUser(null);
      updateProfileAvatarFallbackLetter();
      syncAdvisorChatShellGreeting();
      return;
    }
    var meta = user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata : {};
    var first = meta.first_name != null ? String(meta.first_name).trim() : '';
    var last = meta.last_name != null ? String(meta.last_name).trim() : '';
    if (!first && !last && meta.full_name) {
      var parts = String(meta.full_name).trim().split(/\s+/);
      first = parts[0] || '';
      last = parts.length > 1 ? parts.slice(1).join(' ') : '';
    }
    fn.value = first;
    ln.value = last;
    if (em) em.value = user.email ? String(user.email) : '';
    void applyProfileAvatarFromUser(user);
    updateProfileAvatarFallbackLetter();
    syncAdvisorChatShellGreeting();
  }

  async function persistProfileUserMetadata() {
    var fnEl = document.getElementById('profile-first-name');
    var lnEl = document.getElementById('profile-last-name');
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || isDemoDashboardUser()) return;
    var fn = fnEl ? String(fnEl.value || '').trim() : '';
    var ln = lnEl ? String(lnEl.value || '').trim() : '';
    try {
      var prev = currentUser.user_metadata && typeof currentUser.user_metadata === 'object' ? currentUser.user_metadata : {};
      var meta = Object.assign({}, prev, { first_name: fn, last_name: ln });
      var upd = await supabase.auth.updateUser({ data: meta });
      if (upd && upd.data && upd.data.user) {
        window.currentUser = upd.data.user;
        currentUser = upd.data.user;
      } else {
        var ref = await supabase.auth.getUser();
        if (ref && ref.data && ref.data.user) {
          window.currentUser = ref.data.user;
          currentUser = ref.data.user;
        }
      }
    } catch (e) {
      console.warn('persistProfileUserMetadata', e);
    }
  }

  function wireProfileSettings() {
    var root = document.getElementById('page-settings');
    if (!root || root.getAttribute('data-profile-wired') === '1') return;
    if (!document.getElementById('profile-first-name')) return;
    root.setAttribute('data-profile-wired', '1');
    ensurePreferenceTimezoneOptionsBuilt();
    syncProfileTimezoneOptionsFromMain();

    var fnInp = document.getElementById('profile-first-name');
    if (fnInp) fnInp.addEventListener('input', updateProfileAvatarFallbackLetter);

    var uploadBtn = document.getElementById('profile-avatar-upload');
    var fileInp = document.getElementById('profile-avatar-input');
    if (uploadBtn && fileInp) {
      uploadBtn.addEventListener('click', function () {
        fileInp.click();
      });
      fileInp.addEventListener('change', async function () {
        var f = fileInp.files && fileInp.files[0];
        if (!f) return;
        if (f.size > 10 * 1024 * 1024) {
          alert('Please choose an image under 10MB.');
          fileInp.value = '';
          return;
        }
        var t = String(f.type || '');
        if (t.indexOf('image/png') !== 0 && t.indexOf('image/jpeg') !== 0 && t.indexOf('image/gif') !== 0) {
          alert('We only support PNG, JPEG, and GIF images.');
          fileInp.value = '';
          return;
        }
        supabase = window.supabaseClient || supabase;
        currentUser = window.currentUser || currentUser;
        if (isDemoDashboardUser()) {
          var r0 = new FileReader();
          r0.onload = function () {
            var data = r0.result ? String(r0.result) : '';
            if (data.length > 3200000) {
              alert('That image is too large. Try a smaller file.');
              fileInp.value = '';
              return;
            }
            try {
              localStorage.setItem(PROFILE_AVATAR_STORAGE_KEY, data);
            } catch (e) {
              alert('Could not save the image (storage full). Try a smaller file.');
              fileInp.value = '';
              return;
            }
            void applyProfileAvatarFromUser(currentUser);
            fileInp.value = '';
          };
          r0.onerror = function () {
            alert('Could not read that file.');
            fileInp.value = '';
          };
          r0.readAsDataURL(f);
          return;
        }
        if (!supabase || !currentUser || !currentUser.id) {
          alert('Sign in to save your photo to your account.');
          fileInp.value = '';
          return;
        }
        try {
          var ext = (String(f.name || '').split('.').pop() || 'png').toLowerCase();
          if (!/^png|jpe?g|gif$/i.test(ext)) ext = 'png';
          var path = String(currentUser.id) + '/profile-avatar.' + ext;
          var up = await supabase.storage.from('brand-assets').upload(path, f, { upsert: true, cacheControl: '3600' });
          if (up.error) throw up.error;
          var prevMeta =
            currentUser.user_metadata && typeof currentUser.user_metadata === 'object' ? currentUser.user_metadata : {};
          var meta = Object.assign({}, prevMeta, { profile_avatar_path: path });
          var upd = await supabase.auth.updateUser({ data: meta });
          if (upd && upd.data && upd.data.user) {
            window.currentUser = upd.data.user;
            currentUser = upd.data.user;
          } else {
            var ref = await supabase.auth.getUser();
            if (ref && ref.data && ref.data.user) {
              window.currentUser = ref.data.user;
              currentUser = ref.data.user;
            }
          }
          try {
            localStorage.removeItem(PROFILE_AVATAR_STORAGE_KEY);
          } catch (_) {}
          await applyProfileAvatarFromUser(window.currentUser);
        } catch (e) {
          console.warn('profile avatar upload', e);
          alert(
            'Could not save your photo to the cloud. Ensure the brand-assets bucket exists and policies allow your user folder, then try again.'
          );
        }
        fileInp.value = '';
      });
    }

    var editEm = document.getElementById('profile-email-edit');
    var manageEm = document.getElementById('settings-btn-account-manage-email');
    if (editEm && manageEm) {
      editEm.addEventListener('click', function () {
        manageEm.click();
      });
    }

    function bumpPrefsFromProfile() {
      syncProfilePanelToPrefs();
      applyPreferencesRuntime(readPreferencesFromDom());
    }
    var ptz = document.getElementById('profile-pref-timezone');
    var pws = document.getElementById('profile-pref-week-start');
    if (ptz) {
      ptz.addEventListener('change', bumpPrefsFromProfile);
    }
    if (pws) {
      pws.addEventListener('change', bumpPrefsFromProfile);
    }
  }

  function syncUpdateAccountSecurityUi(user) {
    var emailEl = $('settings-account-email');
    var emailBtn = $('settings-btn-account-manage-email');
    var passDesc = $('settings-account-password-desc');
    var passBtn = $('settings-btn-account-password');
    var delBtn = $('settings-btn-account-delete');
    if (!emailEl) return;

    if (!window.supabaseClient) {
      emailEl.textContent = 'Cloud sign-in is not available in this build.';
      if (emailBtn) emailBtn.disabled = true;
      if (passDesc) passDesc.textContent = 'Set a password for your account';
      if (passBtn) {
        passBtn.disabled = true;
        passBtn.textContent = 'Add password';
      }
      if (delBtn) delBtn.disabled = true;
      hydrateProfileFieldsFromUser(window.currentUser || currentUser || null);
      return;
    }

    if (!user) {
      emailEl.textContent = 'Sign in to manage your account.';
      if (emailBtn) emailBtn.disabled = true;
      if (passDesc) passDesc.textContent = 'Set a password for your account';
      if (passBtn) {
        passBtn.disabled = true;
        passBtn.textContent = 'Add password';
      }
      if (delBtn) delBtn.disabled = true;
      hydrateProfileFieldsFromUser(null);
      return;
    }

    if (isDemoDashboardUser()) {
      emailEl.textContent = user.email || 'Demo account';
      if (emailBtn) emailBtn.disabled = true;
      if (passDesc) passDesc.textContent = 'Not available in demo preview.';
      if (passBtn) {
        passBtn.disabled = true;
        passBtn.textContent = 'Add password';
      }
      if (delBtn) delBtn.disabled = true;
      hydrateProfileFieldsFromUser(user);
      return;
    }

    emailEl.textContent = user.email || '—';
    if (emailBtn) emailBtn.disabled = false;
    var hasPwd = userHasEmailPasswordIdentity(user);
    if (passDesc) {
      passDesc.textContent = hasPwd
        ? 'Change the password you use with email sign-in.'
        : 'Set a password for your account so you can sign in with email and password.';
    }
    if (passBtn) {
      passBtn.disabled = false;
      passBtn.textContent = hasPwd ? 'Change Password' : 'Add password';
    }
    if (delBtn) delBtn.disabled = false;
    hydrateProfileFieldsFromUser(user);
  }

  function refreshAccountSecurityUiFromServer() {
    var baseUser = window.currentUser || currentUser;
    var supa = window.supabaseClient || supabase;
    if (!supa || !baseUser || isDemoDashboardUser()) {
      syncUpdateAccountSecurityUi(baseUser);
      return;
    }
    supa.auth
      .getUser()
      .then(function (res) {
        var u = res && res.data && res.data.user ? res.data.user : baseUser;
        syncUpdateAccountSecurityUi(u);
      })
      .catch(function () {
        syncUpdateAccountSecurityUi(baseUser);
      });
  }

  function refreshCloudSyncStatus() {
    var el = $('settings-cloud-status');
    var syncBtn = $('settings-btn-cloud-sync');
    var authBtn = $('settings-btn-cloud-auth');
    supabase = window.supabaseClient || supabase;
    var user = window.currentUser || currentUser;
    try {
      if (!el) return;
      if (!window.supabaseClient) {
        el.textContent = 'Cloud: Supabase not loaded';
        if (syncBtn) syncBtn.disabled = true;
        return;
      }
      if (!user) {
        el.textContent = 'Cloud: sign in (gate or below) to sync clients and data across browsers.';
        if (syncBtn) syncBtn.disabled = true;
        if (authBtn) authBtn.textContent = 'Sign in';
        return;
      }
      if (isDemoDashboardUser()) {
        el.textContent = 'Demo mode: sample data only. Tap Exit demo to return to the login screen.';
        if (syncBtn) syncBtn.disabled = true;
        if (authBtn) authBtn.textContent = 'Exit demo';
        return;
      }
      el.textContent = 'Cloud: ' + (user.email || 'Signed in') + ' · ' + (clients && clients.length) + ' client(s) in this workspace';
      if (syncBtn) syncBtn.disabled = false;
      if (authBtn) authBtn.textContent = 'Sign out';
    } finally {
      refreshAccountSecurityUiFromServer();
    }
  }

  function openCloudAuthModal() {
    var m = $('cloudAuthModal');
    if (m) m.classList.add('on');
  }

  function closeCloudAuthModal() {
    var m = $('cloudAuthModal');
    if (m) m.classList.remove('on');
  }

  function wireCloudSyncPanel() {
    refreshCloudSyncStatus();

    var authBtn = $('settings-btn-cloud-auth');
    var syncBtn = $('settings-btn-cloud-sync');

    if (authBtn) {
      authBtn.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        var user = window.currentUser || currentUser;
        if (user && isDemoDashboardUser()) {
          window.currentUser = null;
          currentUser = null;
          setScreenshotNoCloudUpload(false);
          if (typeof window.clearRuntimeDataForAuthChange === 'function') {
            window.clearRuntimeDataForAuthChange(null);
          }
          if (typeof window.__dashboardShowLogin === 'function') {
            window.__dashboardShowLogin();
          }
          refreshCloudSyncStatus();
          return;
        }
        if (user && supabase) {
          try {
            await supabase.auth.signOut();
          } catch (e) {
            console.error('signOut error', e);
          }
          refreshCloudSyncStatus();
          return;
        }
        openCloudAuthModal();
      });
    }

    if (syncBtn) {
      syncBtn.addEventListener('click', async function () {
        if (!window.currentUser) {
          alert('Sign in with the same account you use on your other browser, then tap Sync. Data lives in the cloud per account, not in the browser alone.');
          openCloudAuthModal();
          return;
        }
        var label = syncBtn.textContent;
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing…';
        try {
          await initDataFromSupabase();
          await persistAppSettingsToSupabase();
          refreshCloudSyncStatus();
          syncBtn.textContent = 'Done';
          setTimeout(function () { syncBtn.textContent = label || 'Sync'; }, 1800);
        } catch (e) {
          console.error('Sync error', e);
          alert('Sync failed: ' + ((e && e.message) || String(e)));
          syncBtn.textContent = label || 'Sync';
        } finally {
          refreshCloudSyncStatus();
        }
      });
    }

    var btnCancel = $('btn-cloud-auth-cancel');
    if (btnCancel) btnCancel.addEventListener('click', closeCloudAuthModal);
    var modal = $('cloudAuthModal');
    if (modal) {
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) closeCloudAuthModal();
      });
    }

    var btnSignin = $('btn-cloud-auth-signin');
    if (btnSignin) {
      btnSignin.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        var emailEl = $('cloud-auth-email');
        var passEl = $('cloud-auth-password');
        var email = emailEl && emailEl.value.trim();
        var password = passEl && passEl.value;
        if (!email || !password) {
          alert('Enter email and password.');
          return;
        }
        try {
          var res = await supabase.auth.signInWithPassword({ email: email, password: password });
          if (res.error) {
            alert(res.error.message || 'Sign-in failed.');
            return;
          }
          closeCloudAuthModal();
        } catch (err) {
          console.error('cloud modal signin', err);
          alert('Sign-in failed.');
        }
      });
    }

    var btnSignup = $('btn-cloud-auth-signup');
    if (btnSignup) {
      btnSignup.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        var emailEl = $('cloud-auth-email');
        var passEl = $('cloud-auth-password');
        var email = emailEl && emailEl.value.trim();
        var password = passEl && passEl.value;
        if (!email || !password) {
          alert('Enter email and password.');
          return;
        }
        try {
          var res = await supabase.auth.signUp({ email: email, password: password });
          if (res.error) {
            alert(res.error.message || 'Sign-up failed.');
            return;
          }
          alert('Check your email to confirm your account if required, then sign in.');
        } catch (err) {
          console.error('cloud modal signup', err);
          alert('Sign-up failed.');
        }
      });
    }

    var btnGh = $('btn-cloud-auth-github');
    if (btnGh) {
      btnGh.addEventListener('click', async function () {
        supabase = window.supabaseClient || supabase;
        if (!supabase) return;
        try {
          var redirectTo = window.location.origin + (window.location.pathname || '/') + (window.location.search || '');
          var res = await supabase.auth.signInWithOAuth({
            provider: 'github',
            options: { redirectTo: redirectTo },
          });
          if (res.error) alert(res.error.message || 'GitHub sign-in failed.');
        } catch (err) {
          console.error('cloud modal github', err);
          alert('GitHub sign-in failed.');
        }
      });
    }
  }

  function wireAccountSecuritySettings() {
    if (window.__bizdashAccountSecurityWired) return;
    window.__bizdashAccountSecurityWired = true;

    function showInlineErr(id, msg) {
      var e = $(id);
      if (!e) return;
      if (msg) {
        e.style.display = 'block';
        e.textContent = msg;
      } else {
        e.style.display = 'none';
        e.textContent = '';
      }
    }

    function openMo(id) {
      var m = $(id);
      if (m) m.classList.add('on');
    }
    function closeMo(id) {
      var m = $(id);
      if (m) m.classList.remove('on');
    }

    var manage = $('settings-btn-account-manage-email');
    if (manage) {
      manage.addEventListener('click', function () {
        var user = window.currentUser || currentUser;
        if (!user) {
          openCloudAuthModal();
          return;
        }
        if (isDemoDashboardUser()) return;
        showInlineErr('account-email-modal-err', '');
        var inp = $('account-email-new');
        if (inp) inp.value = '';
        openMo('accountEmailModal');
      });
    }

    var btnEmailCancel = $('btn-account-email-cancel');
    if (btnEmailCancel) {
      btnEmailCancel.addEventListener('click', function () {
        closeMo('accountEmailModal');
      });
    }
    var btnEmailSave = $('btn-account-email-save');
    if (btnEmailSave) {
      btnEmailSave.addEventListener('click', async function () {
        var supa = window.supabaseClient;
        var inp = $('account-email-new');
        var email = inp && String(inp.value || '').trim();
        if (!supa) {
          showInlineErr('account-email-modal-err', 'Sign-in is not configured.');
          return;
        }
        if (!email) {
          showInlineErr('account-email-modal-err', 'Enter an email address.');
          return;
        }
        try {
          var res = await supa.auth.updateUser({ email: email });
          if (res.error) {
            showInlineErr('account-email-modal-err', res.error.message || 'Could not update email.');
            return;
          }
          closeMo('accountEmailModal');
          alert('Check your inbox to confirm the new address if your project requires email verification.');
          refreshAccountSecurityUiFromServer();
        } catch (err) {
          showInlineErr('account-email-modal-err', (err && err.message) || 'Could not update email.');
        }
      });
    }

    var passBtn = $('settings-btn-account-password');
    if (passBtn) {
      passBtn.addEventListener('click', function () {
        var user = window.currentUser || currentUser;
        if (!user) {
          openCloudAuthModal();
          return;
        }
        if (isDemoDashboardUser()) return;
        var hasPwd = userHasEmailPasswordIdentity(user);
        var title = $('account-password-modal-title');
        var hint = $('account-password-modal-hint');
        if (title) title.textContent = hasPwd ? 'Change Password' : 'Set password';
        if (hint) {
          hint.textContent = hasPwd
            ? 'Choose a new password for email sign-in.'
            : 'Choose a strong password. You can still use Google or GitHub sign-in if you have those connected.';
        }
        showInlineErr('account-password-modal-err', '');
        var p1 = $('account-password-new');
        var p2 = $('account-password-confirm');
        if (p1) p1.value = '';
        if (p2) p2.value = '';
        openMo('accountPasswordModal');
      });
    }

    var btnPwCancel = $('btn-account-password-cancel');
    if (btnPwCancel) {
      btnPwCancel.addEventListener('click', function () {
        closeMo('accountPasswordModal');
      });
    }
    var btnPwSave = $('btn-account-password-save');
    if (btnPwSave) {
      btnPwSave.addEventListener('click', async function () {
        var supa = window.supabaseClient;
        var p1 = $('account-password-new');
        var p2 = $('account-password-confirm');
        var pw = p1 && String(p1.value || '');
        var pw2 = p2 && String(p2.value || '');
        if (!supa) {
          showInlineErr('account-password-modal-err', 'Sign-in is not configured.');
          return;
        }
        if (pw.length < 8) {
          showInlineErr('account-password-modal-err', 'Use at least 8 characters.');
          return;
        }
        if (pw !== pw2) {
          showInlineErr('account-password-modal-err', 'Passwords do not match.');
          return;
        }
        try {
          var res = await supa.auth.updateUser({ password: pw });
          if (res.error) {
            showInlineErr('account-password-modal-err', res.error.message || 'Could not update password.');
            return;
          }
          if (res.data && res.data.user) {
            window.currentUser = res.data.user;
            currentUser = res.data.user;
          }
          closeMo('accountPasswordModal');
          alert('Your password was updated.');
          refreshAccountSecurityUiFromServer();
        } catch (err) {
          showInlineErr('account-password-modal-err', (err && err.message) || 'Could not update password.');
        }
      });
    }

    var delOpen = $('settings-btn-account-delete');
    if (delOpen) {
      delOpen.addEventListener('click', function () {
        var user = window.currentUser || currentUser;
        if (!user) {
          openCloudAuthModal();
          return;
        }
        if (isDemoDashboardUser()) {
          alert('Exit demo to manage a real account.');
          return;
        }
        showInlineErr('account-delete-modal-err', '');
        var inp = $('account-delete-confirm-input');
        if (inp) inp.value = '';
        openMo('accountDeleteModal');
      });
    }

    var btnDelCancel = $('btn-account-delete-cancel');
    if (btnDelCancel) {
      btnDelCancel.addEventListener('click', function () {
        closeMo('accountDeleteModal');
      });
    }

    var btnDelGo = $('btn-account-delete-confirm');
    if (btnDelGo) {
      btnDelGo.addEventListener('click', async function () {
        var phrase = String(($('account-delete-confirm-input') && $('account-delete-confirm-input').value) || '').trim();
        if (phrase !== 'DELETE') {
          showInlineErr('account-delete-modal-err', 'Type DELETE to confirm.');
          return;
        }
        var base =
          typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl.trim().replace(/\/$/, '') : '';
        var anon =
          typeof window.__bizdashSupabaseAnonKey === 'string' ? String(window.__bizdashSupabaseAnonKey).trim() : '';
        var supa = window.supabaseClient;
        if (!base || !anon || !supa) {
          showInlineErr('account-delete-modal-err', 'This build is not configured for account deletion.');
          return;
        }
        var sessRes = await supa.auth.getSession();
        var token = sessRes && sessRes.data && sessRes.data.session && sessRes.data.session.access_token;
        if (!token) {
          showInlineErr('account-delete-modal-err', 'Session expired. Sign in again.');
          return;
        }
        btnDelGo.disabled = true;
        try {
          var r = await fetch(base + '/auth/v1/user', {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              apikey: anon,
              Authorization: 'Bearer ' + token,
            },
          });
          if (r.status !== 200 && r.status !== 204) {
            var t = await r.text();
            throw new Error(
              t ||
                'Could not delete this account from the browser (' +
                  r.status +
                  '). Ask your admin to enable user self-deletion or remove the user in Supabase.'
            );
          }
          closeMo('accountDeleteModal');
          try {
            await supa.auth.signOut({ scope: 'local' });
          } catch (_) {}
          if (typeof window.clearRuntimeDataForAuthChange === 'function') {
            window.clearRuntimeDataForAuthChange(null);
          }
          if (typeof window.__dashboardShowLogin === 'function') {
            window.__dashboardShowLogin();
          }
        } catch (err) {
          showInlineErr('account-delete-modal-err', (err && err.message) || 'Delete failed.');
        } finally {
          btnDelGo.disabled = false;
        }
      });
    }
  }

  window.refreshCloudSyncStatus = refreshCloudSyncStatus;

  // ---------- Client form wiring ----------

  function populateClientIndustryDatalist() {
    var dl = document.getElementById('client-industry-list');
    if (!dl) return;
    var seen = {};
    var list = [];
    (clients || []).forEach(function (c) {
      if (!c || !c.industry) return;
      var v = String(c.industry).trim();
      if (!v || seen[v]) return;
      seen[v] = true;
      list.push(v);
    });
    list.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: 'base' }); });
    dl.innerHTML = list.map(function (v) {
      return '<option value="' + esc(v) + '"></option>';
    }).join('');
  }

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
      if ($('client-salutation')) $('client-salutation').value = '';
      if ($('client-first-name')) $('client-first-name').value = '';
      if ($('client-last-name')) $('client-last-name').value = '';
      if ($('client-title')) $('client-title').value = '';
      if ($('client-reports-to')) $('client-reports-to').value = '';
      if ($('client-description')) $('client-description').value = '';
      if ($('client-owner')) $('client-owner').value = '';
      if ($('client-mailing-country')) $('client-mailing-country').value = '';
      if ($('client-mailing-street')) $('client-mailing-street').value = '';
      if ($('client-mailing-city')) $('client-mailing-city').value = '';
      if ($('client-mailing-state')) $('client-mailing-state').value = '';
      if ($('client-mailing-zip')) $('client-mailing-zip').value = '';
      if ($('client-email-opt-out')) $('client-email-opt-out').checked = false;
      if ($('client-birthday')) $('client-birthday').value = '';
      if ($('client-preferred-channel')) $('client-preferred-channel').value = '';
      if ($('client-communication-style')) $('client-communication-style').value = '';
      if ($('client-last-touch')) $('client-last-touch').value = '';
      if ($('client-next-follow-up')) $('client-next-follow-up').value = '';
      if ($('client-relationship-notes')) $('client-relationship-notes').value = '';
      var cr = $('client-cust-revenue');
      var cc = $('client-cust-cost');
      if (cr) cr.value = '';
      if (cc) cc.value = '';
      var retCb = $('client-retainer');
      if (retCb) retCb.checked = false;
      var ps = $('client-pipeline-stage');
      if (ps) ps.innerHTML = '<option value="">— None —</option>';
      populateClientIndustryDatalist();
      m.classList.add('on');
    }

    function closeClientModal() {
      var m = $('clientModal');
      if (m) m.classList.remove('on');
    }

    if (btnAddClient) {
      btnAddClient.addEventListener('click', async function () {
        await wfRefreshFromSupabase();
        openClientModal();
        wfFillClientPipelineSelect($('client-pipeline-stage'), null);
      });
    }
    if (btnClientCancel) btnClientCancel.addEventListener('click', closeClientModal);
    if (btnClientSave) {
      btnClientSave.addEventListener('click', async function () {
        var company = $('client-company').value.trim();
        if (!company) {
          alert('Company name is required.');
          return;
        }
        function val(id) {
          var el = $(id);
          return el ? String(el.value || '').trim() : '';
        }
        var firstName = val('client-first-name');
        var lastName = val('client-last-name');
        var contactName = val('client-contact') || [firstName, lastName].filter(Boolean).join(' ');
        var existingId = $('client-edit-id') ? $('client-edit-id').value : '';
        var retainerChecked = $('client-retainer') && $('client-retainer').checked;
        var emailOptOut = $('client-email-opt-out') && $('client-email-opt-out').checked;
        var client;
        supabase = window.supabaseClient || supabase;
        currentUser = window.currentUser || currentUser;

        function parseCustTabMoney(el) {
          if (!el) return null;
          var s = String(el.value || '').trim();
          if (s === '') return null;
          var n = parseFloat(s);
          return isNaN(n) ? null : Math.max(0, n);
        }
        var custRev = parseCustTabMoney($('client-cust-revenue'));
        var custCost = parseCustTabMoney($('client-cust-cost'));

        var stageSel = $('client-pipeline-stage');
        var stageIdPick = stageSel && stageSel.value ? stageSel.value : '';
        function applyPipelineFieldsFromUi(cl) {
          if (!cl) return;
          if (stageIdPick) {
            var st = wfStages.find(function (s) { return s.id === stageIdPick; });
            if (st) {
              cl.pipelineId = st.pipelineId;
              cl.pipelineStageId = st.id;
              if (!val('client-status')) cl.status = st.label;
            }
          } else {
            cl.pipelineStageId = null;
            cl.pipelineId = null;
          }
        }

        var prevForWf = null;
        if (existingId) {
          var prevRow = clients.find(function (x) { return x.id === existingId; });
          prevForWf = wfCloneClientForWorkflow(prevRow);
        }

        if (existingId) {
          var clientsSnapshot = JSON.stringify(clients);
          clients = clients.map(function (c) {
            if (c.id !== existingId) return c;
            client = {
              id: c.id,
              companyName: company,
              contactName: contactName,
              status: val('client-status'),
              industry: val('client-industry'),
              email: val('client-email'),
              phone: val('client-phone'),
              notes: val('client-notes'),
              birthday: $('client-birthday') ? $('client-birthday').value : '',
              preferredChannel: val('client-preferred-channel'),
              communicationStyle: val('client-communication-style'),
              lastTouchAt: $('client-last-touch') ? $('client-last-touch').value : '',
              nextFollowUpAt: $('client-next-follow-up') ? $('client-next-follow-up').value : '',
              relationshipNotes: val('client-relationship-notes'),
              salutation: val('client-salutation'),
              firstName: firstName,
              lastName: lastName,
              title: val('client-title'),
              reportsTo: val('client-reports-to'),
              description: val('client-description'),
              owner: val('client-owner'),
              accountName: company,
              mailingCountry: val('client-mailing-country'),
              mailingStreet: val('client-mailing-street'),
              mailingCity: val('client-mailing-city'),
              mailingState: val('client-mailing-state'),
              mailingZip: val('client-mailing-zip'),
              emailOptOut: !!emailOptOut,
              totalRevenue: c.totalRevenue || 0,
              createdAt: c.createdAt || Date.now(),
              retainer: !!retainerChecked,
            };
            if (custRev != null) {
              client.custTabRevenue = custRev;
              client.totalRevenue = custRev;
            } else {
              delete client.custTabRevenue;
              var txRev = clientRevenueFromTransactions(client.id);
              client.totalRevenue = txRev > 0 ? txRev : c.totalRevenue || 0;
            }
            if (custCost != null) client.custTabAllocatedCost = custCost;
            else delete client.custTabAllocatedCost;
            applyPipelineFieldsFromUi(client);
            return client;
          });
          saveClients(clients);
          renderClients();
          if (state.computed) renderInsights();
          if (supabase && currentUser && client) {
            var editSync = await persistClientToSupabase(client, 'update');
            if (editSync === 'error') {
              try {
                clients = JSON.parse(clientsSnapshot);
              } catch (_) {}
              saveClients(clients);
              renderClients();
              if (state.computed) renderInsights();
              alert('Could not update this client in the cloud. Your changes were reverted.\n\n' + (persistClientLastError || 'Check the browser console and Supabase RLS rules.'));
              return;
            }
            await runWorkflowDispatch({ kind: 'client_updated', before: prevForWf, after: wfCloneClientForWorkflow(client) });
          }
        } else {
          if (!supabase || !currentUser) {
            alert('You must be signed in to add a client. New clients are saved to your cloud account only.');
            return;
          }
          client = {
            id: uuid(),
            companyName: company,
            contactName: contactName,
            status: val('client-status'),
            industry: val('client-industry'),
            email: val('client-email'),
            phone: val('client-phone'),
            notes: val('client-notes'),
            birthday: $('client-birthday') ? $('client-birthday').value : '',
            preferredChannel: val('client-preferred-channel'),
            communicationStyle: val('client-communication-style'),
            lastTouchAt: $('client-last-touch') ? $('client-last-touch').value : '',
            nextFollowUpAt: $('client-next-follow-up') ? $('client-next-follow-up').value : '',
            relationshipNotes: val('client-relationship-notes'),
            salutation: val('client-salutation'),
            firstName: firstName,
            lastName: lastName,
            title: val('client-title'),
            reportsTo: val('client-reports-to'),
            description: val('client-description'),
            owner: val('client-owner'),
            accountName: company,
            mailingCountry: val('client-mailing-country'),
            mailingStreet: val('client-mailing-street'),
            mailingCity: val('client-mailing-city'),
            mailingState: val('client-mailing-state'),
            mailingZip: val('client-mailing-zip'),
            emailOptOut: !!emailOptOut,
            totalRevenue: custRev != null ? custRev : 0,
            createdAt: Date.now(),
            retainer: !!retainerChecked,
          };
          if (custRev != null) client.custTabRevenue = custRev;
          if (custCost != null) client.custTabAllocatedCost = custCost;
          else delete client.custTabAllocatedCost;
          applyPipelineFieldsFromUi(client);
          var addSync = await persistClientToSupabase(client, 'insert');
          if (addSync === 'skipped') {
            alert('Could not save this client: you are not signed in or your session expired.\n\n' + (persistClientLastError || 'Sign in again and retry.'));
            return;
          }
          if (addSync !== 'ok') {
            alert('Could not save this client to the cloud. Nothing was added.\n\n' + (persistClientLastError || 'Check the browser console and Supabase RLS rules.'));
            return;
          }
          clients.push(client);
          saveClients(clients);
          renderClients();
          if (state.computed) renderInsights();
          await runWorkflowDispatch({ kind: 'client_updated', before: null, after: wfCloneClientForWorkflow(client) });
        }
        if (client) {
          if (client.lastTouchAt) {
            addCrmEvent('touch', 'Last touch updated for ' + (client.companyName || 'client'), { lastTouchAt: client.lastTouchAt }, client.id, 'touch:' + client.id + ':' + client.lastTouchAt);
          }
          if (client.nextFollowUpAt) {
            addCrmEvent('follow_up', 'Follow-up scheduled for ' + (client.companyName || 'client'), { nextFollowUpAt: client.nextFollowUpAt }, client.id, 'followup:' + client.id + ':' + client.nextFollowUpAt);
          }
        }
        refreshCloudSyncStatus();
        populateProjectClientOptions();
        populateIncomeClientOptions();
        closeClientModal();
      });
    }

    window.bizDashOpenClientModalWithDraft = async function (draft) {
      await wfRefreshFromSupabase();
      var d = draft && typeof draft === 'object' ? draft : {};
      var m = $('clientModal');
      if (!m) return;
      var editId = $('client-edit-id');
      if (editId) editId.value = '';
      function setv(id, val) {
        var el = $(id);
        if (el) el.value = val == null ? '' : String(val);
      }
      setv('client-company', d.companyName);
      setv('client-contact', d.contactName);
      setv('client-status', d.status || 'Lead');
      setv('client-industry', d.industry);
      setv('client-email', d.email);
      setv('client-phone', d.phone);
      setv('client-notes', d.notes);
      setv('client-salutation', d.salutation);
      setv('client-first-name', d.firstName);
      setv('client-last-name', d.lastName);
      setv('client-title', d.title);
      setv('client-reports-to', d.reportsTo);
      setv('client-description', d.description);
      setv('client-owner', d.owner);
      setv('client-mailing-country', d.mailingCountry);
      setv('client-mailing-street', d.mailingStreet);
      setv('client-mailing-city', d.mailingCity);
      setv('client-mailing-state', d.mailingState);
      setv('client-mailing-zip', d.mailingZip);
      var optOut = $('client-email-opt-out');
      if (optOut) optOut.checked = !!d.emailOptOut;
      setv('client-birthday', d.birthday);
      setv('client-preferred-channel', d.preferredChannel);
      setv('client-communication-style', d.communicationStyle);
      setv('client-last-touch', d.lastTouchAt);
      setv('client-next-follow-up', d.nextFollowUpAt);
      setv('client-relationship-notes', d.relationshipNotes);
      var cr = $('client-cust-revenue');
      var cc = $('client-cust-cost');
      if (cr) cr.value = '';
      if (cc) cc.value = '';
      var retCb = $('client-retainer');
      if (retCb) retCb.checked = !!d.retainer;
      var stageSel = $('client-pipeline-stage');
      if (stageSel) {
        if (d.pipelineId && d.pipelineStageId) {
          wfFillClientPipelineSelect(stageSel, { pipelineId: d.pipelineId, pipelineStageId: d.pipelineStageId });
        } else {
          wfFillClientPipelineSelect(stageSel, null);
        }
      }
      populateClientIndustryDatalist();
      m.classList.add('on');
    };
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
    var caseStudyDetails = $('project-case-study-details');
    var caseStudyBody = $('project-case-study-body');

    if (caseStudyDetails && caseStudyBody && caseStudyDetails.getAttribute('data-rollout-wired') !== '1') {
      caseStudyDetails.setAttribute('data-rollout-wired', '1');
      animateRollout(caseStudyBody, false, true);
      caseStudyDetails.open = false;
      var caseSummary = caseStudyDetails.querySelector('summary');
      if (caseSummary) {
        caseSummary.addEventListener('click', function (ev) {
          ev.preventDefault();
          var opening = !caseStudyDetails.open;
          if (opening) caseStudyDetails.open = true;
          animateRollout(caseStudyBody, opening, false);
          if (!opening) {
            window.setTimeout(function () {
              caseStudyDetails.open = false;
            }, 380);
          }
        });
      }
    }

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
      var detBody = $('project-case-study-body');
      if (det && detBody) {
        det.open = false;
        animateRollout(detBody, false, true);
      }
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
        persistAppSettingsToSupabase({ includeDashboard: false });
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
        persistAppSettingsToSupabase({ includeDashboard: false });
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
      // Re-scope budgets to the active account (in-memory `budgets` can still hold demo values after View Demo).
      budgets = loadBudgets();

      // Start from local cache so we can migrate/backfill if remote is empty.
      state.transactions = omitLocallyDeletedTransactions(loadTransactions());
      clients = loadClients();
      projects = loadProjects();
      invoices = loadInvoices();
      campaigns = loadCampaigns();
      timesheetEntries = loadTimesheetEntries();
      projectStatuses = loadStatuses();
      normalizeLocalIdsForSupabase();

      if (supabase && currentUser && getCurrentOrgId() && !isDemoDashboardUser()) {
        var remoteTxs = await fetchTransactionsFromSupabase();
        var remoteClients = await fetchClientsFromSupabase();

        // One-time backfill: if remote is empty but local has data, upload local records.
        if (!isScreenshotNoCloudUpload() && !remoteTxs.length && state.transactions.length) {
          await uploadTransactionsToSupabase(state.transactions);
          remoteTxs = await fetchTransactionsFromSupabase();
        }
        if (!isScreenshotNoCloudUpload() && !remoteClients.length && clients.length) {
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
        if (!isScreenshotNoCloudUpload() && localOnlyClients.length) {
          await uploadClientsToSupabase(localOnlyClients);
          remoteClients = await fetchClientsFromSupabase();
          clients = mergeClientsPreserveRetainer(clients, remoteClients);
        }

        var remoteProjects = await fetchProjectsFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteProjects.length && projects.length) {
          await uploadProjectsToSupabase(projects);
          remoteProjects = await fetchProjectsFromSupabase();
        }
        if (remoteProjects.length) {
          projects = mergeRemoteWithLocalOrphans(projects, remoteProjects, function (x) { return x; });
        }

        var remoteInvoices = await fetchInvoicesFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteInvoices.length && invoices.length) {
          await uploadInvoicesToSupabase(invoices);
          remoteInvoices = await fetchInvoicesFromSupabase();
        }
        if (remoteInvoices.length) {
          invoices = mergeRemoteWithLocalOrphans(invoices, remoteInvoices, function (x) { return x; });
        }

        var remoteCampaigns = await fetchCampaignsFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteCampaigns.length && campaigns.length) {
          await uploadCampaignsToSupabase(campaigns);
          remoteCampaigns = await fetchCampaignsFromSupabase();
        }
        if (remoteCampaigns.length) {
          campaigns = mergeRemoteWithLocalOrphans(campaigns, remoteCampaigns, function (x) { return x; });
        }

        var remoteTimesheet = await fetchTimesheetEntriesFromSupabase();
        if (!isScreenshotNoCloudUpload() && !remoteTimesheet.length && timesheetEntries.length) {
          await uploadTimesheetEntriesToSupabase(timesheetEntries);
          remoteTimesheet = await fetchTimesheetEntriesFromSupabase();
        }
        if (remoteTimesheet.length) {
          timesheetEntries = mergeRemoteWithLocalOrphans(timesheetEntries, remoteTimesheet, function (x) { return x; });
        }
        crmEvents = await fetchCrmEventsFromSupabase();
        weeklySummaries = await fetchWeeklySummariesFromSupabase();

        var settingsRow = await fetchAppSettingsFromSupabase();
        var rawUiPayload = await fetchUserUiPreferencesPayload();
        userUiPrefsCache = normalizeUserUiPayload(rawUiPayload);
        var orgDash =
          settingsRow && settingsRow.dashboard_settings && typeof settingsRow.dashboard_settings === 'object'
            ? settingsRow.dashboard_settings
            : null;
        var orgLegacyPrefs = orgDash && orgDash.preferences ? orgDash.preferences : null;
        if (
          (userUiPrefsCache.preferences == null || userUiPrefsCache.preferences === undefined) &&
          orgLegacyPrefs
        ) {
          userUiPrefsCache.preferences = normalizePreferences(orgLegacyPrefs);
          schedulePersistUserUiPreferences();
        }
        if (userUiPrefsCache.preferences != null && userUiPrefsCache.preferences !== undefined) {
          applyPreferencesToForm(userUiPrefsCache.preferences);
          applyPreferencesRuntime(userUiPrefsCache.preferences);
        }
        var oidForUi = getCurrentOrgId();
        if (oidForUi && userUiPrefsCache.orgs && userUiPrefsCache.orgs[oidForUi]) {
          applyUserUiOrgSliceToRuntime(oidForUi, userUiPrefsCache.orgs[oidForUi]);
        } else if (oidForUi && typeof window.bizDashReloadCustomersColumnPrefs === 'function') {
          window.bizDashReloadCustomersColumnPrefs();
        }
        applySidebarNavVisibility();
        if (settingsRow && settingsRow.dashboard_settings) {
          await applyDashboardSettingsFromCloud(settingsRow.dashboard_settings);
        }
        if (userUiPrefsCache && userUiPrefsCache.preferences != null && userUiPrefsCache.preferences !== undefined) {
          applyPreferencesRuntime(userUiPrefsCache.preferences);
        }
        if (settingsRow && Array.isArray(settingsRow.project_statuses) && settingsRow.project_statuses.length) {
          projectStatuses = settingsRow.project_statuses.map(function (s) { return String(s); }).filter(Boolean);
          saveStatuses(projectStatuses);
        } else if (!isScreenshotNoCloudUpload()) {
          await persistAppSettingsToSupabase();
        }

        // Cache in localStorage so existing browser keeps a copy.
        saveTransactions(state.transactions);
        saveClients(clients);
        saveProjects(projects);
        saveInvoices(invoices);
        saveCampaigns(campaigns);
        saveTimesheetEntries(timesheetEntries);
      } else {
        ensureUserUiPrefsCache();
        applySidebarNavVisibility();
      }

      await wfRefreshFromSupabase();

      expandRecurringExpenseInstances();

      // Ensure dropdowns reflect latest clients/projects.
      populateProjectClientOptions();
      populateIncomeClientOptions();
      populateProjectStatusOptions();

      state.computed = compute(state.filter);
      renderAll();
      renderProjects();
      refreshCloudSyncStatus();
    } catch (err) {
      console.error('initDataFromSupabase error', err);
      // Fallback in case anything goes wrong.
      state.transactions = omitLocallyDeletedTransactions(loadTransactions());
      clients = loadClients();
      projects = loadProjects();
      invoices = loadInvoices();
      campaigns = loadCampaigns();
      timesheetEntries = loadTimesheetEntries();
      projectStatuses = loadStatuses();
      crmEvents = [];
      weeklySummaries = [];
      expandRecurringExpenseInstances();
      state.computed = compute(state.filter);
      renderAll();
      renderProjects();
      refreshCloudSyncStatus();
      ensureUserUiPrefsCache();
      applySidebarNavVisibility();
    }
  }

  /**
   * Fills local dashboard state for screenshots / “View Demo”. Sets session flag so sync does not
   * backfill mock rows to Supabase for signed-in users who load mock from settings.
   */
  function loadScreenshotMockData() {
    setScreenshotNoCloudUpload(true);

    function pad2(n) {
      return String(n).padStart(2, '0');
    }
    function ymdOffset(daysAgo) {
      var d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    var specs = [
      { co: 'Aurora Analytics', contact: 'Morgan Chen', email: 'morgan@aurora.example', phone: '(415) 555-0142', status: 'Retainer', industry: 'SaaS', ret: true, notes: 'Primary analytics retainer.' },
      { co: 'Brightline Health', contact: 'Sam Rivera', email: 'sam@brightline.example', phone: '(206) 555-0198', status: 'Retainer', industry: 'Healthcare', ret: true, notes: '' },
      { co: 'Copper Kettle Co.', contact: 'Alex Kim', email: 'alex@copperkettle.example', phone: '(512) 555-0101', status: 'Active', industry: 'Hospitality', ret: false, notes: 'Seasonal campaigns.' },
      { co: 'Driftwood Studio', contact: 'Riley Ng', email: 'riley@driftwood.example', phone: '(503) 555-0122', status: 'Retainer', industry: 'Design', ret: true, notes: '' },
      { co: 'Evergreen Supply', contact: 'Casey Park', email: 'casey@evergreen.example', phone: '(303) 555-0144', status: 'Active', industry: 'Retail', ret: false, notes: '' },
      { co: 'Falcon Mobility', contact: 'Jordan Blake', email: 'jordan@falcon.example', phone: '(617) 555-0166', status: 'Pipeline', industry: 'Mobility', ret: false, notes: 'Pilot Q1.' },
      { co: 'Greenleaf Farms', contact: 'Taylor Moss', email: 'taylor@greenleaf.example', phone: '(406) 555-0188', status: 'Active', industry: 'Agriculture', ret: false, notes: '' },
      { co: 'Harborlight Capital', contact: 'Morgan Diaz', email: 'morgan.h@harborlight.example', phone: '(212) 555-0199', status: 'Retainer', industry: 'Finance', ret: true, notes: '' },
      { co: 'Inkwell Publishing', contact: 'Jamie Frost', email: 'jamie@inkwell.example', phone: '(718) 555-0200', status: 'On hold', industry: 'Media', ret: false, notes: '' },
      { co: 'Juniper Learning', contact: 'Quinn Patel', email: 'quinn@juniper.example', phone: '(650) 555-0211', status: 'Active', industry: 'EdTech', ret: false, notes: '' },
      { co: 'Kindred Robotics', contact: 'Reese Lopez', email: 'reese@kindred.example', phone: '(408) 555-0222', status: 'Pipeline', industry: 'Robotics', ret: false, notes: '' },
      { co: 'Lumen Architecture', contact: 'Skyler Fox', email: 'skyler@lumenarch.example', phone: '(312) 555-0233', status: 'Active', industry: 'Architecture', ret: false, notes: '' },
    ];

    var t0 = Date.now();
    clients = specs.map(function (s, i) {
      return {
        id: uuid(),
        companyName: s.co,
        contactName: s.contact,
        status: s.status,
        industry: s.industry,
        email: s.email,
        phone: s.phone,
        notes: s.notes,
        birthday: '',
        communicationStyle: i % 3 === 0 ? 'Direct' : i % 3 === 1 ? 'Collaborative' : 'Async',
        preferredChannel: i % 2 === 0 ? 'Email' : 'Slack',
        lastTouchAt: ymdOffset(3 + (i % 5)),
        nextFollowUpAt: ymdOffset(-7 - i),
        relationshipNotes: i % 4 === 0 ? 'Champion: legal approved SOW renewal.' : '',
        totalRevenue: 12000 + i * 4200,
        createdAt: new Date(t0 - (120 - i * 7) * 86400000).toISOString(),
        retainer: s.ret === true,
        custTabRevenue: 8000 + i * 900,
        custTabAllocatedCost: 2000 + i * 400,
      };
    });

    var now = Date.now();
    projects = [
      { id: uuid(), clientId: clients[0].id, name: 'Analytics refresh & dashboards', status: 'In progress', type: 'Retainer', startDate: ymdOffset(60), dueDate: ymdOffset(-5), value: 42000, description: 'BI dashboards and weekly KPI pack.', notes: '', satisfaction: 9, archived: false, createdAt: now - 86400000 * 55, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[1].id, name: 'Member portal v2', status: 'In progress', type: 'Project', startDate: ymdOffset(45), dueDate: ymdOffset(20), value: 68000, description: 'Accessibility and performance pass.', notes: '', satisfaction: null, archived: false, createdAt: now - 86400000 * 40, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[2].id, name: 'Loyalty program launch', status: 'Complete', type: 'Campaign', startDate: ymdOffset(90), dueDate: ymdOffset(25), value: 18500, description: 'Email and in-store signage.', notes: 'Delivered on time.', satisfaction: 10, archived: false, createdAt: now - 86400000 * 88, caseStudyPublished: true, caseStudyChallenge: 'Low repeat visits.', caseStudyStrategy: [{ title: 'Approach', body: 'Segmented offers.' }], caseStudyResults: [{ metric: 'Repeat rate', value: '+18%' }], caseStudyCategory: 'Hospitality' },
      { id: uuid(), clientId: clients[3].id, name: 'Brand system 2026', status: 'In progress', type: 'Retainer', startDate: ymdOffset(30), dueDate: ymdOffset(45), value: 24000, description: 'Typography and component library.', notes: '', satisfaction: 8, archived: false, createdAt: now - 86400000 * 28, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[4].id, name: 'Inventory forecasting', status: 'Blocked', type: 'Sprint', startDate: ymdOffset(20), dueDate: ymdOffset(5), value: 12000, description: 'Waiting on ERP export format.', notes: '', satisfaction: null, archived: false, createdAt: now - 86400000 * 18, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[5].id, name: 'Fleet dashboard MVP', status: 'Not started', type: 'MVP', startDate: ymdOffset(10), dueDate: ymdOffset(55), value: 95000, description: 'Phase 0 discovery.', notes: '', satisfaction: null, archived: false, createdAt: now - 86400000 * 8, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[7].id, name: 'LP reporting templates', status: 'Complete', type: 'Project', startDate: ymdOffset(75), dueDate: ymdOffset(40), value: 31000, description: 'Quarterly LP pack automation.', notes: '', satisfaction: 9, archived: false, createdAt: now - 86400000 * 70, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
      { id: uuid(), clientId: clients[9].id, name: 'Course CMS migration', status: 'In progress', type: 'Project', startDate: ymdOffset(14), dueDate: ymdOffset(30), value: 52000, description: 'Headless CMS and SSO.', notes: '', satisfaction: 8, archived: false, createdAt: now - 86400000 * 12, caseStudyPublished: false, caseStudyChallenge: '', caseStudyStrategy: [], caseStudyResults: [], caseStudyCategory: '' },
    ];

    var txs = [];
    function addTx(o) {
      txs.push({
        id: uuid(),
        date: o.d,
        category: o.c,
        amount: o.a,
        description: o.desc || '',
        note: o.note || o.desc || '',
        clientId: o.cid || null,
        projectId: o.pid || null,
        otherLabel: o.ol || '',
        otherType: o.ot || '',
        source: o.src || '',
        createdAt: new Date().toISOString(),
      });
    }

    var i;
    var p;
    for (i = 0; i < 95; i += 3) {
      if (i % 9 === 0) {
        addTx({ d: ymdOffset(i), c: 'svc', a: 4800 + (i % 7) * 200, desc: 'Services invoice', cid: clients[i % clients.length].id, pid: projects[i % projects.length].id });
      }
      if (i % 11 === 2) {
        addTx({ d: ymdOffset(i), c: 'ret', a: 6200 + (i % 5) * 150, desc: 'Monthly retainer', cid: clients[(i + 1) % clients.length].id });
      }
      if (i % 5 === 1) addTx({ d: ymdOffset(i), c: 'lab', a: 2100 + (i % 4) * 180, desc: 'Contract labor', note: 'Design + engineering' });
      if (i % 6 === 3) addTx({ d: ymdOffset(i), c: 'sw', a: 180 + (i % 3) * 40, desc: 'SaaS subscriptions', note: 'Figma, Linear, hosting' });
      if (i % 8 === 4) addTx({ d: ymdOffset(i), c: 'ads', a: 950 + (i % 5) * 120, desc: 'Paid search and social' });
      if (i % 10 === 6) addTx({ d: ymdOffset(i), c: 'oth', a: 320 + (i % 4) * 55, desc: 'Travel and meals', ol: 'Travel', ot: 'One-time' });
    }
    addTx({ d: ymdOffset(1), c: 'own', a: 15000, desc: 'Owner capital contribution', note: 'Operating buffer' });

    state.transactions = txs;

    var incomeForInvoices = txs.filter(function (t) { return t.category === 'svc' && t.clientId; }).slice(0, 4);
    invoices = incomeForInvoices.map(function (t, idx) {
      return {
        id: uuid(),
        incomeTxId: t.id,
        number: 'INV-' + String(2400 + idx).padStart(4, '0'),
        dateIssued: t.date,
        dueDate: ymdOffset(-20 + idx * 5),
        amount: t.amount,
        status: idx === 0 ? 'paid' : idx === 1 ? 'sent' : 'sent',
        paidAt: idx === 0 ? ymdOffset(2) : null,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
        stripeCustomerId: null,
        stripeStatus: null,
      };
    });

    campaigns = [
      normalizeCampaign({ id: uuid(), name: 'Spring webinar series', channel: 'LinkedIn + email', startDate: ymdOffset(40), notes: 'MQL goal 120.', pipelineValue: 45000, status: CAMPAIGN_STATUS_PIPELINE, createdAt: now - 86400000 * 35 }),
      normalizeCampaign({ id: uuid(), name: 'Partner co-marketing', channel: 'Events', startDate: ymdOffset(25), notes: 'Two field events.', pipelineValue: 28000, status: CAMPAIGN_STATUS_PIPELINE, createdAt: now - 86400000 * 20 }),
      normalizeCampaign({ id: uuid(), name: 'Brand refresh launch', channel: 'Organic + PR', startDate: ymdOffset(70), notes: 'Case study push.', pipelineValue: 0, status: CAMPAIGN_STATUS_WON, createdAt: now - 86400000 * 65 }),
      normalizeCampaign({ id: uuid(), name: 'Legacy nurture pilot', channel: 'Email', startDate: ymdOffset(90), notes: 'Sunset Q4.', pipelineValue: 8000, status: CAMPAIGN_STATUS_LOST, createdAt: now - 86400000 * 85 }),
    ];

    timesheetEntries = [];
    for (p = 0; p < 5; p++) {
      timesheetEntries.push({
        id: uuid(),
        date: ymdOffset(p),
        account: 'Client delivery',
        project: projects[p % projects.length].name,
        task: p % 2 === 0 ? 'Implementation' : 'Review',
        activityCode: 'BILL',
        minutes: 240 + p * 45,
        billable: true,
        notes: 'Screenshot sample entry',
        externalNote: '',
        weekdays: [],
        createdAt: new Date().toISOString(),
      });
    }

    crmEvents = [
      { id: uuid(), clientId: clients[0].id, kind: 'note', title: 'QBR scheduled', details: {}, eventAt: new Date(now - 86400000 * 2).toISOString() },
      { id: uuid(), clientId: clients[2].id, kind: 'note', title: 'Sent revised SOW', details: {}, eventAt: new Date(now - 86400000 * 5).toISOString() },
      { id: uuid(), clientId: clients[5].id, kind: 'note', title: 'Discovery call — budget confirmed', details: {}, eventAt: new Date(now - 86400000 * 8).toISOString() },
    ];
    weeklySummaries = [];

    budgets = { lab: 8500, sw: 950, ads: 2200, oth: 650 };
    saveBudgets(budgets);

    normalizeLocalIdsForSupabase();
    saveClients(clients);
    saveProjects(projects);
    saveTransactions(state.transactions);
    saveInvoices(invoices);
    saveCampaigns(campaigns);
    saveTimesheetEntries(timesheetEntries);

    var sn = $('setting-name');
    if (sn) sn.value = 'Northwind Creative Studio';
    var so = $('setting-owner');
    if (so) so.value = 'Alex Morgan';
    var spe = $('setting-period');
    if (spe) spe.value = 'Q1 2026';
    ['lab', 'sw', 'ads', 'oth'].forEach(function (k) {
      var el = document.getElementById('budget-input-' + k);
      if (el && budgets[k] > 0) el.value = budgets[k];
    });

    expandRecurringExpenseInstances();
    populateProjectClientOptions();
    populateIncomeClientOptions();
    populateProjectStatusOptions();
    state.computed = compute(state.filter);
    renderAll();
    renderProjects();
    refreshCloudSyncStatus();
  }

  function resumeScreenshotCloudUpload() {
    if (!isScreenshotNoCloudUpload()) {
      alert('Screenshot upload pause is not active.');
      return;
    }
    if (!confirm('Resume automatic cloud upload? Sign-in and Sync will behave normally again. Local demo data stays until you replace or clear it. If your cloud account is empty, the next Sync may upload what is in this browser.')) return;
    setScreenshotNoCloudUpload(false);
    refreshCloudSyncStatus();
    if (window.currentUser && window.supabaseClient) {
      alert('Upload pause is off. Use Sync if you want to merge with your account.');
    }
  }

  /** Clear settings inputs that demo mode writes so a real account never inherits sample business text. */
  function resetSettingsFormForAccountHandoff() {
    function setEl(id, v) {
      var el = document.getElementById(id);
      if (el) el.value = v != null ? String(v) : '';
    }
    ['setting-name', 'setting-owner', 'setting-email', 'setting-phone', 'setting-address', 'setting-period'].forEach(function (id) {
      setEl(id, '');
    });
    setEl('profile-first-name', '');
    setEl('profile-last-name', '');
    try {
      localStorage.removeItem(PROFILE_AVATAR_STORAGE_KEY);
    } catch (_) {}
    applyWorkspaceChromeProfileAvatar();
    setEl('setting-terms', '30');
    setEl('setting-tax', '0');
    var cur = document.getElementById('setting-currency');
    if (cur) cur.value = 'USD';
    var fis = document.getElementById('setting-fiscal');
    if (fis) fis.value = 'January';
    // Preserve current branding until account-specific settings are loaded.
    ['setting-logo-light', 'setting-logo-dark'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.type === 'file') el.value = '';
    });
    applyPreferencesToForm(getDefaultPreferences());
    applyPreferencesRuntime(getDefaultPreferences());
  }

  function destroyAllWorkspaceCharts() {
    function kill(ch) {
      if (ch && window.Chart && typeof ch.destroy === 'function') {
        try {
          ch.destroy();
        } catch (_) {}
      }
    }
    kill(expenseChart);
    expenseChart = null;
    kill(revExpChart);
    revExpChart = null;
    kill(projTypeChart);
    projTypeChart = null;
    kill(projMonthlyChart);
    projMonthlyChart = null;
    kill(revTrendChart);
    revTrendChart = null;
    kill(verticalChart);
    verticalChart = null;
    kill(leadSourceChart);
    leadSourceChart = null;
    kill(spendTrendChart);
    spendTrendChart = null;
    kill(insTrendChart);
    insTrendChart = null;
    kill(retTrendChart);
    retTrendChart = null;
  }

  function clearRuntimeDataForAuthChange(nextUser) {
    clearUserUiPrefsCache();
    currentUser = nextUser || null;
    window.currentUser = currentUser;
    if (!nextUser) {
      window.currentOrganizationId = null;
      window.currentOrganizationSlug = null;
      window.currentOrganizationRole = null;
      window.currentOrganizationDisplayName = null;
    }
    if (!nextUser || nextUser.id !== DEMO_DASHBOARD_USER_ID) {
      setScreenshotNoCloudUpload(false);
    }
    customersColumnPrefs = loadCustomersColumnPrefs();
    renderCustomersColumnsPanel();
    if (!isDemoDashboardUser()) {
      resetSettingsFormForAccountHandoff();
    }
    destroyAllWorkspaceCharts();
    budgets = loadBudgets();
    refreshSettingsBudgetInputsFromState();
    wfPipelines = [];
    wfStages = [];
    wfRules = [];
    wfTasks = [];
    advisorContactContext = null;
    state.transactions = [];
    clients = [];
    projects = [];
    invoices = [];
    campaigns = [];
    timesheetEntries = [];
    crmEvents = [];
    weeklySummaries = [];
    state.computed = compute(state.filter);
    renderAll();
    renderProjects();
    refreshCloudSyncStatus();
    closeListTemplatesModal();
    closeListPreviewModal();
    closeListDetailView();
    if (listsFeatureWired) {
      renderListsSidebar();
      renderListsPageGrid();
      renderChatsSidebar();
    }
    if (typeof window.refreshSidebarWorkspaceChrome === 'function') {
      window.refreshSidebarWorkspaceChrome();
    }
  }

  window.bizDashSetAdvisorContactContext = function (obj) {
    advisorContactContext = normalizeAdvisorContactContext(obj);
  };
  window.bizDashGetAdvisorContactContext = function () {
    return advisorContactContext ? Object.assign({}, advisorContactContext) : null;
  };

  function resolveAdvisorClientRef(draft) {
    var d = draft || {};
    var cid = String(d.clientId || d.client_id || '').trim();
    if (cid) {
      if (!isUuidForDb(cid)) {
        return { client: null, error: 'Invalid client id.' };
      }
      var byId = (clients || []).find(function (x) {
        return x && x.id === cid;
      });
      if (byId) return { client: byId, error: null };
      return { client: null, error: 'No client with that id in this workspace.' };
    }
    var name = String(d.clientName || d.companyName || '').trim().toLowerCase();
    if (!name) return { client: null, error: null };
    var exact = (clients || []).find(function (x) {
      return x && String(x.companyName || '').trim().toLowerCase() === name;
    });
    if (exact) return { client: exact, error: null };
    var partial = (clients || []).find(function (x) {
      return x && String(x.companyName || '').toLowerCase().indexOf(name) !== -1;
    });
    if (partial) return { client: partial, error: null };
    return { client: null, error: 'No client matched "' + name + '".' };
  }

  window.bizDashGetClientsDigestForAdvisor = function () {
    var out = [];
    (clients || []).forEach(function (c) {
      if (!c || out.length >= 30) return;
      out.push({
        id: c.id,
        companyName: String(c.companyName || '').slice(0, 120),
        email: String(c.email || '').slice(0, 160),
      });
    });
    return out;
  };

  /**
   * Create a workspace task from an Advisor-confirmed proposal (assignee = current user).
   * @returns {Promise<{ok:boolean, task?:object, error?:string}>}
   */
  window.bizDashCreateTaskFromAdvisor = async function (draft) {
    draft = draft || {};
    var title = String(draft.title || '').trim();
    if (!title) return { ok: false, error: 'Task title is required.' };
    if (isDemoDashboardUser()) return { ok: false, error: 'Sign in to create tasks.' };
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    var orgId = getCurrentOrgId();
    if (!supabase || !currentUser || !orgId) {
      return { ok: false, error: 'Sign in and open a workspace to save tasks.' };
    }
    var body = String(draft.body || '').trim().slice(0, 8000);
    var dueAt = null;
    var ymd = String(draft.dueYmd || draft.due_ymd || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(ymd)) {
      var d = new Date(ymd + 'T12:00:00');
      if (!isNaN(d.getTime())) dueAt = d.toISOString();
    }
    var clientId = null;
    if (draft.clientId || draft.client_id || draft.clientName || draft.companyName) {
      var tr = resolveAdvisorClientRef(draft);
      if (!tr.client) return { ok: false, error: tr.error || 'Could not find that client.' };
      clientId = tr.client.id;
    }
    var row = {
      id: uuid(),
      user_id: currentUser.id,
      organization_id: orgId,
      title: title.slice(0, 500),
      body: body,
      status: 'open',
      due_at: dueAt,
      client_id: clientId,
      campaign_id: null,
      created_by: 'user',
      workflow_run_id: null,
      assigned_to_email: null,
    };
    var ins = await supabase.from('workspace_tasks').insert(row);
    if (ins.error) return { ok: false, error: formatSupabaseErr(ins.error) };
    await wfRefreshFromSupabase();
    try {
      renderTasksPage();
    } catch (e) {
      console.warn('renderTasksPage', e);
    }
    return { ok: true, task: mapWorkspaceTaskRow(row) };
  };

  /**
   * Append a timestamped note to a client from an Advisor-confirmed proposal.
   * @returns {Promise<{ok:boolean, client?:object, error?:string}>}
   */
  window.bizDashAppendClientNoteFromAdvisor = async function (draft) {
    draft = draft || {};
    var note = String(draft.note || '').trim();
    if (!note) return { ok: false, error: 'Note text is required.' };
    if (isDemoDashboardUser()) return { ok: false, error: 'Sign in to save notes.' };
    var r = resolveAdvisorClientRef(draft);
    if (!r.client) return { ok: false, error: r.error || 'Pick a client (id or company name from the digest).' };
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser || !getCurrentOrgId()) {
      return { ok: false, error: 'Sign in and open a workspace.' };
    }
    var stamp = new Date().toISOString().slice(0, 10);
    var prev = String(r.client.notes || '').trim();
    var sep = prev ? '\n\n' : '';
    var next = Object.assign({}, r.client, {
      notes: prev + sep + '— Advisor note (' + stamp + ')\n' + note,
    });
    var u = await persistClientToSupabase(next, 'update');
    if (u === 'skipped') return { ok: false, error: persistClientLastError || 'Could not save.' };
    if (u !== 'ok') return { ok: false, error: persistClientLastError || 'Update failed.' };
    clients = (clients || []).map(function (c) {
      return c.id === next.id ? next : c;
    });
    saveClients(clients);
    renderClients();
    return { ok: true, client: next };
  };

  /**
   * One-click insert from Advisor CRM proposal (user must confirm in Advisor UI before calling).
   * @returns {Promise<{ok:boolean, client?:object, error?:string}>}
   */
  window.bizDashCreateClientFromDraft = async function (draft) {
    var client = buildNewClientObjectFromDraft(draft);
    if (!client) {
      return { ok: false, error: 'Company name is required.' };
    }
    supabase = window.supabaseClient || supabase;
    currentUser = window.currentUser || currentUser;
    if (!supabase || !currentUser) {
      return { ok: false, error: 'You must be signed in to add a client.' };
    }
    var addSync = await persistClientToSupabase(client, 'insert');
    if (addSync === 'skipped') {
      return { ok: false, error: persistClientLastError || 'Could not save (session or demo mode).' };
    }
    if (addSync !== 'ok') {
      return { ok: false, error: persistClientLastError || 'Could not save to the cloud.' };
    }
    clients.push(client);
    saveClients(clients);
    renderClients();
    if (state.computed) renderInsights();
    await runWorkflowDispatch({ kind: 'client_updated', before: null, after: wfCloneClientForWorkflow(client) });
    if (client.lastTouchAt) {
      addCrmEvent('touch', 'Last touch updated for ' + (client.companyName || 'client'), { lastTouchAt: client.lastTouchAt }, client.id, 'touch:' + client.id + ':' + client.lastTouchAt);
    }
    if (client.nextFollowUpAt) {
      addCrmEvent('follow_up', 'Follow-up scheduled for ' + (client.companyName || 'client'), { nextFollowUpAt: client.nextFollowUpAt }, client.id, 'followup:' + client.id + ':' + client.nextFollowUpAt);
    }
    refreshCloudSyncStatus();
    populateProjectClientOptions();
    populateIncomeClientOptions();
    return { ok: true, client: client };
  };

  /**
   * Upload an image to private brand-assets storage. First path segment must be auth.uid()
   * or an organization UUID the user can write (see brand_assets_org_rls.sql).
   * @returns {{ signedUrl: string, path: string }}
   */
  window.bizdashUploadBrandAssetFile = async function (file, folderFirstSegment, namePrefix) {
    if (!file || !window.supabaseClient || !window.currentUser || !window.currentUser.id) {
      return { signedUrl: '', path: '' };
    }
    var supa = window.supabaseClient;
    var seg = String(folderFirstSegment || '').trim();
    var prefix = String(namePrefix || 'file').replace(/[^a-z0-9-]/gi, '-').slice(0, 32);
    if (!seg || !prefix) return { signedUrl: '', path: '' };
    var ext = (String(file.name || '').split('.').pop() || 'png').toLowerCase();
    if (!/^png|jpe?g|webp|gif$/i.test(ext)) ext = 'png';
    var path = seg + '/' + prefix + '-' + Date.now() + '.' + ext;
    var upload = await supa.storage.from('brand-assets').upload(path, file, { upsert: true, cacheControl: '3600' });
    if (upload.error) throw upload.error;
    var signed = await supa.storage.from('brand-assets').createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signed.error) throw signed.error;
    var signedUrl = signed.data && signed.data.signedUrl ? String(signed.data.signedUrl) : '';
    return { signedUrl: signedUrl, path: path };
  };

  /**
   * Called after first-time workspace setup (org name + slug) to sync Settings fields,
   * accent, optional tagline / role, and persist dashboard_settings to Supabase.
   */
  window.bizdashApplyWorkspaceBrandingFromOnboarding = async function (payload) {
    payload = payload || {};
    function gid(id) {
      return document.getElementById(id);
    }
    var nm = gid('setting-name');
    var ow = gid('setting-owner');
    var orr = gid('setting-owner-role');
    var tg = gid('setting-tagline');
    var ac = gid('setting-accent');
    var ach = gid('setting-accent-hex');
    if (nm && payload.businessName != null) nm.value = String(payload.businessName);
    if (ow && payload.owner != null) ow.value = String(payload.owner);
    if (orr && payload.ownerRole != null) orr.value = String(payload.ownerRole);
    if (tg && payload.tagline != null) tg.value = String(payload.tagline);
    if (payload.accent) {
      var hex = normalizeHexColor(payload.accent, '#e8501a');
      if (ac) ac.value = hex;
      if (ach) ach.value = hex;
      syncAccentPresetSwatches(hex);
      applyAccentBranding(hex);
    }
    var tagOut = gid('dash-brand-tagline');
    if (tagOut) {
      var tgs = payload.tagline != null ? String(payload.tagline).trim() : '';
      if (tgs) {
        tagOut.textContent = tgs;
        tagOut.style.display = 'block';
      } else {
        tagOut.textContent = '';
        tagOut.style.display = 'none';
      }
    }
    await persistAppSettingsToSupabase({ includeDashboard: true });
  };

  // Expose so supabase-auth.js can reset state on auth transitions and trigger reload.
  function reloadCustomersColumnPrefsForCurrentStorageScope() {
    customersColumnPrefs = loadCustomersColumnPrefs();
    renderCustomersColumnsPanel();
    applyCustomersColumnVisibility();
  }
  window.bizDashReloadCustomersColumnPrefs = reloadCustomersColumnPrefsForCurrentStorageScope;
  window.bizDashPersistUserUiPrefsForOrgLeaving = persistUserUiPrefsForOrgLeaving;
  window.bizDashApplyUserUiPrefsForOrg = function (orgId) {
    orgId = orgId && String(orgId).trim() ? String(orgId).trim() : null;
    if (!orgId) return;
    ensureUserUiPrefsCache();
    var slice = userUiPrefsCache.orgs && userUiPrefsCache.orgs[orgId] ? userUiPrefsCache.orgs[orgId] : null;
    if (!slice || typeof slice !== 'object') return;
    var hasData =
      (slice.customersColumns && typeof slice.customersColumns === 'object') ||
      (slice.incomePower && typeof slice.incomePower === 'object') ||
      slice.incomeTrendRange === '30d' ||
      slice.incomeTrendRange === '90d' ||
      slice.incomeTrendRange === 'ytd' ||
      slice.incomeTrendRange === 'all';
    if (!hasData) return;
    applyUserUiOrgSliceToRuntime(orgId, slice);
  };
  window.clearRuntimeDataForAuthChange = clearRuntimeDataForAuthChange;
  window.initDataFromSupabase = initDataFromSupabase;
  window.loadScreenshotMockData = loadScreenshotMockData;
  window.resumeScreenshotCloudUpload = resumeScreenshotCloudUpload;
  window.setBizdashScreenshotNoCloud = setScreenshotNoCloudUpload;

  /**
   * Read-only ledger rollups for the in-dashboard assistant (same rules as compute(): categories svc/ret = revenue, lab/sw/ads/oth = expense, own excluded).
   * @returns {object|null} null if range is invalid
   */
  window.bizDashLedgerSummaryRange = function (startYmd, endYmd) {
    if (!startYmd || !endYmd) return null;
    var c = computeForYmdRange(startYmd, endYmd);
    return {
      startYmd: startYmd,
      endYmd: endYmd,
      expenseTotal: c.expenseTotal,
      revenueTotal: c.revenueTotal,
      netProfit: c.netProfit,
      grossProfit: c.grossProfit,
      grossMarginPct: c.grossMarginPct,
      cogsTotal: c.cogsTotal,
      expenseByCat: {
        lab: c.expenseByCat.lab,
        sw: c.expenseByCat.sw,
        ads: c.expenseByCat.ads,
        oth: c.expenseByCat.oth,
      },
      revenueByCat: { svc: c.revenueByCat.svc, ret: c.revenueByCat.ret },
      expenseFixedTotal: c.expenseFixedTotal,
      expenseVariableTotal: c.expenseVariableTotal,
      transactionCount: c.txs.length,
    };
  };

  window.bizDashLedgerSummaryAll = function () {
    var c = compute({ mode: 'all', start: null, end: null });
    return {
      expenseTotal: c.expenseTotal,
      revenueTotal: c.revenueTotal,
      netProfit: c.netProfit,
      grossProfit: c.grossProfit,
      grossMarginPct: c.grossMarginPct,
      cogsTotal: c.cogsTotal,
      expenseByCat: {
        lab: c.expenseByCat.lab,
        sw: c.expenseByCat.sw,
        ads: c.expenseByCat.ads,
        oth: c.expenseByCat.oth,
      },
      revenueByCat: { svc: c.revenueByCat.svc, ret: c.revenueByCat.ret },
      expenseFixedTotal: c.expenseFixedTotal,
      expenseVariableTotal: c.expenseVariableTotal,
      transactionCount: c.txs.length,
    };
  };

  function wireTeamPage() {
    var teamWired = false;
    function buildInviteShareUrl(result) {
      var token = result && result.token ? String(result.token) : '';
      if (token) {
        return (window.location.origin || '') + '/?invite=' + encodeURIComponent(token);
      }
      return result && result.inviteUrl ? String(result.inviteUrl) : '';
    }
    function roleLabel(r) {
      if (r === 'member') return 'Employee';
      if (r === 'viewer') return 'Viewer';
      if (!r) return '—';
      return String(r).charAt(0).toUpperCase() + String(r).slice(1);
    }
    function teamMemberRowsHtml(members, canManage, myRole) {
      return (members || [])
        .map(function (m) {
          var email = m.email || m.user_id || '—';
          var uid = m.user_id;
          var isSelf = window.currentUser && window.currentUser.id === uid;
          var row = '<tr><td>' + esc(email) + '</td><td>' + esc(roleLabel(m.role)) + '</td>';
          if (canManage) {
            var roleOpts = myRole === 'owner' ? ['owner', 'admin', 'member', 'viewer'] : ['admin', 'member', 'viewer'];
            var sel = roleOpts
              .map(function (r) {
                return '<option value="' + esc(r) + '"' + (m.role === r ? ' selected' : '') + '>' + esc(roleLabel(r)) + '</option>';
              })
              .join('');
            row +=
              '<td><select class="fi team-role-select" data-user-id="' +
              esc(uid) +
              '" style="min-width:130px;font-size:12px;">' +
              sel +
              '</select> ';
            row += isSelf
              ? '<span style="color:var(--text3);font-size:11px;">You</span></td>'
              : '<button type="button" class="btn team-remove-btn" data-user-id="' +
                esc(uid) +
                '" style="font-size:11px;padding:4px 8px;">Remove</button></td>';
          }
          row += '</tr>';
          return row;
        })
        .join('');
    }
    function syncSettingsPeopleFromTeamState(members, canManage, myRole, hintLine) {
      var cnt = document.getElementById('settings-people-members-count');
      var stBody = document.getElementById('settings-people-members-tbody');
      var sh = document.getElementById('settings-people-members-hint');
      var tha = document.getElementById('settings-people-th-actions');
      if (cnt) cnt.textContent = String((members && members.length) || 0);
      if (stBody) stBody.innerHTML = teamMemberRowsHtml(members || [], canManage, myRole);
      if (sh) sh.textContent = hintLine || '';
      if (tha) tha.style.display = canManage ? '' : 'none';
    }
    /** Supabase FunctionsFetchError = fetch never completed (not a 4xx/5xx from the function). */
    function formatTeamInvokeError(err) {
      if (!err) return 'Request failed';
      var msg = err.message || 'Request failed';
      if (err.name === 'FunctionsHttpError' && err.context && typeof err.context.status === 'number') {
        if (err.context.status === 401) {
          return 'Session expired or not accepted by the server. Sign in again, then reopen My team.';
        }
        return msg + ' (HTTP ' + String(err.context.status) + ')';
      }
      if (err.name === 'FunctionsFetchError') {
        var inner =
          err.context && typeof err.context === 'object' && err.context.message != null
            ? String(err.context.message)
            : err.context != null && typeof err.context !== 'object'
              ? String(err.context)
              : '';
        var suffix =
          ' Usually: deploy `organization-team` to this Supabase project (`supabase functions deploy organization-team`), or open DevTools → Network and inspect …/functions/v1/organization-team.';
        return inner && inner !== msg ? msg + ' — ' + inner + '.' + suffix : msg + '.' + suffix;
      }
      return msg;
    }
    /**
     * SupabaseClient's fetch wrapper uses auth.getSession() for Bearer — that can lag GoTrue.
     * Passing Authorization on invoke() pins a token; fetch will not replace it, so it must
     * be fresh. refreshSession() returns the new access_token from the server.
     */
    async function bearerForTeamEdge(supabase) {
      try {
        var ref = await supabase.auth.refreshSession();
        if (ref && ref.error) return null;
        var s = ref && ref.data && ref.data.session;
        if (s && s.access_token) return s.access_token;
        var g = await supabase.auth.getSession();
        s = g && g.data && g.data.session;
        return s && s.access_token ? s.access_token : null;
      } catch (_) {
        return null;
      }
    }
    /** Avoid supabase.functions.invoke: bundled fetch wrapper can omit Authorization (gateway UNAUTHORIZED_NO_AUTH_HEADER). */
    async function invokeOrganizationTeamRaw(supabase, orgId, body, accessToken) {
      var base = (
        (supabase && supabase.supabaseUrl ? String(supabase.supabaseUrl) : '') ||
        (typeof window.__bizdashSupabaseUrl === 'string' ? window.__bizdashSupabaseUrl : '')
      ).replace(/\/$/, '');
      var anon =
        (supabase && supabase.supabaseKey ? String(supabase.supabaseKey) : '') ||
        (typeof window.__bizdashSupabaseAnonKey === 'string' ? window.__bizdashSupabaseAnonKey : '');
      if (!base || !anon) return { ok: false, status: 0, data: null, errText: 'Missing Supabase URL or key on client.' };
      var url = base + '/functions/v1/organization-team';
      var res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + accessToken,
          apikey: anon,
        },
        body: JSON.stringify(Object.assign({ organizationId: orgId }, body)),
      });
      var text = await res.text();
      var data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = { error: text || 'Invalid JSON from server.' };
      }
      return { ok: res.ok, status: res.status, data: data, errText: text };
    }
    async function invokeTeam(body) {
      var supabase = window.supabaseClient;
      if (!supabase) return { error: 'Sign in to manage the team.' };
      var orgId = typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
      if (!orgId) return { error: 'No workspace selected.' };
      try {
        var token = await bearerForTeamEdge(supabase);
        if (!token) return { error: 'Session expired. Sign in again.' };
        var raw = await invokeOrganizationTeamRaw(supabase, orgId, body, token);
        if (!raw.ok && raw.status === 401) {
          token = await bearerForTeamEdge(supabase);
          if (token) raw = await invokeOrganizationTeamRaw(supabase, orgId, body, token);
        }
        if (!raw.ok) {
          var apiErr =
            raw.data && typeof raw.data === 'object'
              ? raw.data.error || raw.data.message || raw.data.msg
              : null;
          var pseudo = {
            name: 'FunctionsHttpError',
            message: apiErr ? String(apiErr) : 'Request failed',
            context: { status: raw.status || 0 },
          };
          return { error: formatTeamInvokeError(pseudo) };
        }
        return raw.data && typeof raw.data === 'object' ? raw.data : {};
      } catch (e) {
        return { error: formatTeamInvokeError(e) };
      }
    }
    async function refreshTeamPage() {
      var orgId = typeof getCurrentOrgId === 'function' ? getCurrentOrgId() : null;
      var hint = document.getElementById('team-page-hint');
      var tbody = document.getElementById('team-members-body');
      var thActions = document.getElementById('team-th-actions');
      var inviteCard = document.getElementById('team-invite-card');
      var pendingCard = document.getElementById('team-pending-invites-card');
      if (!tbody || !hint) return;
      if (!orgId) {
        hint.textContent = 'Open a workspace URL (path starts with your org slug) to view the team.';
        tbody.innerHTML = '';
        syncSettingsPeopleFromTeamState([], false, '', '');
        if (inviteCard) inviteCard.style.display = 'none';
        if (pendingCard) pendingCard.style.display = 'none';
        return;
      }
      var out = await invokeTeam({ action: 'list' });
      if (out.error) {
        hint.textContent = String(out.error);
        tbody.innerHTML = '';
        syncSettingsPeopleFromTeamState([], false, '', String(out.error));
        if (inviteCard) inviteCard.style.display = 'none';
        if (pendingCard) pendingCard.style.display = 'none';
        return;
      }
      var canManage = !!out.canManage;
      var myRole = out.yourRole || '';
      var hintLine = canManage
        ? 'Change roles or remove people from this workspace. Only owners can assign the Owner role.'
        : 'Only workspace admins (Owner or Admin) can change roles or send invites.';
      hint.textContent = hintLine;
      if (thActions) thActions.style.display = canManage ? '' : 'none';
      if (inviteCard) inviteCard.style.display = canManage ? 'block' : 'none';
      var members = out.members || [];
      tbody.innerHTML = teamMemberRowsHtml(members, canManage, myRole);
      syncSettingsPeopleFromTeamState(members, canManage, myRole, hintLine);

      if (canManage && pendingCard) {
        var pi = await invokeTeam({ action: 'pending_invites' });
        var pb = document.getElementById('team-pending-invites-body');
        if (!pi.error && pi.invitations && pi.invitations.length && pb) {
          pendingCard.style.display = 'block';
          pb.innerHTML = pi.invitations
            .map(function (inv) {
              return (
                '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);">' +
                '<span>' +
                esc(inv.email) +
                ' · ' +
                esc(roleLabel(inv.role)) +
                ' · expires ' +
                esc(String(inv.expires_at || '').slice(0, 10)) +
                '</span>' +
                '<button type="button" class="btn team-revoke-invite" data-invite-id="' +
                esc(inv.id) +
                '" style="font-size:11px;">Revoke</button></div>'
              );
            })
            .join('');
        } else {
          pendingCard.style.display = 'none';
          if (pb) pb.innerHTML = '';
        }
      } else if (pendingCard) {
        pendingCard.style.display = 'none';
      }

      if (!teamWired) {
        teamWired = true;
        var btnInv = document.getElementById('team-btn-create-invite');
        var btnAdd = document.getElementById('team-btn-add-existing');
        if (btnInv) {
          btnInv.addEventListener('click', async function () {
            var emEl = document.getElementById('team-invite-email');
            var roleEl = document.getElementById('team-invite-role');
            var resEl = document.getElementById('team-invite-result');
            var email = emEl && emEl.value ? String(emEl.value).trim() : '';
            var role = roleEl && roleEl.value ? roleEl.value : 'member';
            if (!email) {
              alert('Enter an email address.');
              return;
            }
            var r = await invokeTeam({ action: 'invite', email: email, role: role });
            if (r.error) {
              alert(r.error);
              return;
            }
            if (resEl) {
              var shareUrl = buildInviteShareUrl(r);
              if (shareUrl) window.__bizdashLastInviteShareUrl = shareUrl;
              resEl.style.display = 'block';
              resEl.textContent = shareUrl ? 'Share this link: ' + shareUrl : 'Invite created.';
            }
            if (emEl) emEl.value = '';
            await refreshTeamPage();
          });
        }
        if (btnAdd) {
          btnAdd.addEventListener('click', async function () {
            var emEl = document.getElementById('team-invite-email');
            var roleEl = document.getElementById('team-invite-role');
            var email = emEl && emEl.value ? String(emEl.value).trim() : '';
            var role = roleEl && roleEl.value ? roleEl.value : 'member';
            if (!email) {
              alert('Enter an email address.');
              return;
            }
            var r = await invokeTeam({ action: 'add', email: email, role: role });
            if (r.error) {
              alert(r.error);
              return;
            }
            alert('User added to this workspace.');
            if (emEl) emEl.value = '';
            await refreshTeamPage();
          });
        }
        function wireTeamMemberTable(host) {
          if (!host || host.getAttribute('data-team-table-wired') === '1') return;
          host.setAttribute('data-team-table-wired', '1');
          host.addEventListener('change', async function (ev) {
            var t = ev.target;
            if (!t || !t.classList || !t.classList.contains('team-role-select')) return;
            var uid = t.getAttribute('data-user-id');
            var role = t.value;
            var r = await invokeTeam({ action: 'update_role', userId: uid, role: role });
            if (r.error) {
              alert(r.error);
              await refreshTeamPage();
              return;
            }
          });
          host.addEventListener('click', async function (ev) {
            var t = ev.target;
            if (!t || !t.closest) return;
            var removeBtn = t.closest('.team-remove-btn');
            if (!removeBtn) return;
            var uid = removeBtn.getAttribute('data-user-id');
            if (!uid) return;
            if (
              !confirm(
                'Are you sure you want to remove this person from the workspace? They will lose access immediately.'
              )
            ) {
              return;
            }
            var r = await invokeTeam({ action: 'remove', userId: uid });
            if (r.error) {
              alert(r.error);
              await refreshTeamPage();
              return;
            }
            if (r.ok === false) {
              alert(r.message || 'Could not remove this member.');
              await refreshTeamPage();
              return;
            }
            await refreshTeamPage();
          });
        }
        wireTeamMemberTable(tbody);
        wireTeamMemberTable(document.getElementById('settings-people-members-tbody'));
        var pendingHost = document.getElementById('team-pending-invites-body');
        if (pendingHost) {
          pendingHost.addEventListener('click', async function (ev) {
            var t = ev.target;
            if (!t || !t.classList || !t.classList.contains('team-revoke-invite')) return;
            var id = t.getAttribute('data-invite-id');
            if (!id || !confirm('Revoke this invitation?')) return;
            var r = await invokeTeam({ action: 'revoke_invite', inviteId: id });
            if (r.error) {
              alert(r.error);
              return;
            }
            await refreshTeamPage();
          });
        }
      }
    }
    window.bizdashInvokeTeam = invokeTeam;
    window.refreshTeamPage = refreshTeamPage;
  }

  var __bizdashLucideIconNames = null;
  var __bizdashLucideIconFetchPromise = null;

  function loadLucideIconNamesFromIconify() {
    if (__bizdashLucideIconNames) return Promise.resolve(__bizdashLucideIconNames);
    if (!__bizdashLucideIconFetchPromise) {
      __bizdashLucideIconFetchPromise = fetch('https://api.iconify.design/collection?prefix=lucide')
        .then(function (res) {
          if (!res.ok) throw new Error(String(res.status));
          return res.json();
        })
        .then(function (j) {
          var arr = [];
          if (j && Array.isArray(j.uncategorized)) {
            arr = j.uncategorized.filter(Boolean).map(function (x) {
              return String(x).toLowerCase();
            });
          }
          arr.sort();
          __bizdashLucideIconNames = arr;
          return arr;
        })
        .catch(function (err) {
          console.error('loadLucideIconNamesFromIconify', err);
          __bizdashLucideIconNames = [];
          return [];
        });
    }
    return __bizdashLucideIconFetchPromise;
  }

  function wireWorkspaceIconPickerModal() {
    var root = document.getElementById('workspaceIconPickerModal');
    if (!root || root.getAttribute('data-ws-icon-mo-wired') === '1') return;
    root.setAttribute('data-ws-icon-mo-wired', '1');
    var search = document.getElementById('ws-icon-picker-search');
    var grid = document.getElementById('ws-icon-picker-grid');
    var statusEl = document.getElementById('ws-icon-picker-status');
    var closeBtn = document.getElementById('ws-icon-picker-close');
    var pasteEmoji = document.getElementById('ws-icon-picker-paste-emoji');
    var debTimer = null;

    function renderIconGrid(allNames, q) {
      if (!grid) return;
      q = String(q || '').trim().toLowerCase();
      var list = allNames;
      if (q) {
        list = allNames.filter(function (n) {
          return n.indexOf(q) !== -1;
        });
      } else {
        list = allNames.slice(0, 100);
      }
      var max = 200;
      if (list.length > max) list = list.slice(0, max);
      grid.innerHTML = '';
      list.forEach(function (name) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ws-icon-picker-cell';
        btn.setAttribute('role', 'listitem');
        btn.setAttribute('aria-label', 'Icon ' + name);
        btn.setAttribute('data-lucide-icon', name);
        var img = document.createElement('img');
        img.alt = '';
        img.loading = 'lazy';
        img.width = 22;
        img.height = 22;
        img.src = lucideIconifySvgImgSrc(name);
        btn.appendChild(img);
        grid.appendChild(btn);
      });
      if (statusEl) {
        if (!allNames.length) {
          statusEl.textContent = 'Could not load icons. Check your connection and try again.';
        } else if (!list.length) {
          statusEl.textContent = 'No matches. Try a different search.';
        } else {
          statusEl.textContent =
            'Showing ' +
            list.length +
            (q ? ' match' + (list.length === 1 ? '' : 'es') : ' icons') +
            (q ? '' : ' · type to filter');
        }
      }
    }

    function setOpen(on) {
      root.classList.toggle('on', !!on);
      root.setAttribute('aria-hidden', on ? 'false' : 'true');
      if (on) {
        if (grid) grid.innerHTML = '';
        if (statusEl) statusEl.textContent = 'Loading icons…';
        if (search) {
          search.value = '';
          window.setTimeout(function () {
            try {
              search.focus();
            } catch (_) {}
          }, 30);
        }
        loadLucideIconNamesFromIconify().then(function (names) {
          renderIconGrid(names, '');
        });
      }
    }

    root.addEventListener('click', function (ev) {
      if (ev.target === root) setOpen(false);
    });
    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        setOpen(false);
      });
    }
    if (pasteEmoji) {
      pasteEmoji.addEventListener('click', async function () {
        var raw = window.prompt('Paste an emoji for this workspace (one character recommended)', '🙂');
        if (raw == null) return;
        var t = String(raw || '').trim().slice(0, 10);
        if (!t) return;
        var ur = document.getElementById('setting-ws-icon-url-value');
        var em = document.getElementById('setting-ws-icon-emoji-value');
        var ic = document.getElementById('setting-ws-icon-iconify-value');
        if (ur) ur.value = '';
        if (ic) ic.value = '';
        if (em) em.value = t;
        await renderWorkspaceIconPreview();
        setOpen(false);
        var rPe = window.currentOrganizationRole || '';
        if (rPe === 'owner' || rPe === 'admin') {
          await persistAppSettingsToSupabase({ includeDashboard: true });
        }
      });
    }
    if (grid) {
      grid.addEventListener('click', async function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('[data-lucide-icon]') : null;
        if (!btn) return;
        var name = btn.getAttribute('data-lucide-icon');
        if (!name) return;
        var ur = document.getElementById('setting-ws-icon-url-value');
        var em = document.getElementById('setting-ws-icon-emoji-value');
        var ic = document.getElementById('setting-ws-icon-iconify-value');
        if (ur) ur.value = '';
        if (em) em.value = '';
        if (ic) ic.value = 'lucide:' + name;
        await renderWorkspaceIconPreview();
        setOpen(false);
        var rGrid = window.currentOrganizationRole || '';
        if (rGrid === 'owner' || rGrid === 'admin') {
          await persistAppSettingsToSupabase({ includeDashboard: true });
        }
      });
    }
    if (search) {
      search.addEventListener('input', function () {
        if (debTimer) clearTimeout(debTimer);
        debTimer = setTimeout(function () {
          debTimer = null;
          var names = __bizdashLucideIconNames;
          if (!names || !names.length) {
            loadLucideIconNamesFromIconify().then(function (n) {
              renderIconGrid(n, search.value);
            });
          } else {
            renderIconGrid(names, search.value);
          }
        }, 120);
      });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!root.classList.contains('on')) return;
      setOpen(false);
    });

    window.__bizdashOpenWorkspaceIconPicker = function () {
      var r = window.currentOrganizationRole || '';
      if (r !== 'owner' && r !== 'admin') return;
      setOpen(true);
    };
  }

  function wireWorkspaceSettingsPanel() {
    var root = document.getElementById('page-settings');
    if (!root || root.getAttribute('data-workspace-settings-wired') === '1') return;
    root.setAttribute('data-workspace-settings-wired', '1');

    window.bizdashWorkspacePrefs = window.bizdashWorkspacePrefs || defaultWorkspacePrefs();
    wireWorkspaceIconPickerModal();

    function downloadBlob(filename, blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function exportWorkspaceContentJson() {
      var oid = getCurrentOrgId();
      var payload = {
        exportedAt: new Date().toISOString(),
        organizationId: oid || null,
        clients: clients || [],
        transactions: state && state.transactions ? state.transactions : [],
        projects: projects || [],
        invoices: invoices || [],
        campaigns: campaigns || [],
        timesheetEntries: timesheetEntries || [],
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      var slug = (window.currentOrganizationSlug || 'workspace').replace(/[^\w.-]+/g, '_');
      downloadBlob('workspace-export-' + slug + '.json', blob);
    }

    async function exportMembersCsv() {
      var fn = typeof window.bizdashInvokeTeam === 'function' ? window.bizdashInvokeTeam : null;
      if (!fn) {
        alert('Team features are still loading. Try again in a moment.');
        return;
      }
      var out = await fn({ action: 'list' });
      if (out.error) {
        alert(out.error);
        return;
      }
      var rows = out.members || [];
      var lines = ['email,role,user_id'];
      rows.forEach(function (m) {
        var em = String(m.email || '').replace(/"/g, '""');
        var role = String(m.role || '').replace(/"/g, '""');
        var uid = String(m.user_id || '').replace(/"/g, '""');
        lines.push('"' + em + '","' + role + '","' + uid + '"');
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      var slug = (window.currentOrganizationSlug || 'members').replace(/[^\w.-]+/g, '_');
      downloadBlob('workspace-members-' + slug + '.csv', blob);
    }

    var iconHit = document.getElementById('setting-ws-icon-hit');
    var iconFile = document.getElementById('setting-ws-icon-file');
    if (iconHit && iconFile) {
      iconHit.addEventListener('click', function () {
        if (iconHit.disabled) return;
        iconFile.click();
      });
      iconFile.addEventListener('change', async function () {
        var memRole = window.currentOrganizationRole || '';
        if (memRole !== 'owner' && memRole !== 'admin') {
          iconFile.value = '';
          return;
        }
        if (!iconFile.files || !iconFile.files.length) return;
        var file = iconFile.files[0];
        if (!file || String(file.type || '').indexOf('image/') !== 0) {
          alert('Choose an image file.');
          return;
        }
        try {
          var seg = getCurrentOrgId() || (window.currentUser && window.currentUser.id);
          var up =
            typeof window.bizdashUploadBrandAssetFile === 'function'
              ? await window.bizdashUploadBrandAssetFile(file, seg, 'workspace-icon')
              : null;
          var url = up && up.signedUrl ? String(up.signedUrl) : '';
          if (!url) throw new Error('Upload failed');
          var ur = document.getElementById('setting-ws-icon-url-value');
          var em = document.getElementById('setting-ws-icon-emoji-value');
          var ic = document.getElementById('setting-ws-icon-iconify-value');
          if (em) em.value = '';
          if (ic) ic.value = '';
          if (ur) ur.value = url;
          await renderWorkspaceIconPreview();
          iconFile.value = '';
          var rUp = window.currentOrganizationRole || '';
          if (rUp === 'owner' || rUp === 'admin') {
            await persistAppSettingsToSupabase({ includeDashboard: true });
          }
        } catch (err) {
          console.warn(err);
          alert('Icon upload failed. Check brand-assets storage policies.');
        }
      });
    }

    var emojiBtn = document.getElementById('setting-ws-icon-emoji-btn');
    if (emojiBtn) {
      emojiBtn.addEventListener('click', function () {
        if (typeof window.__bizdashOpenWorkspaceIconPicker === 'function') {
          window.__bizdashOpenWorkspaceIconPicker();
        }
      });
    }

    var clearBtn = document.getElementById('setting-ws-icon-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async function () {
        var cr = window.currentOrganizationRole || '';
        if (cr !== 'owner' && cr !== 'admin') return;
        var ur = document.getElementById('setting-ws-icon-url-value');
        var em = document.getElementById('setting-ws-icon-emoji-value');
        var ic = document.getElementById('setting-ws-icon-iconify-value');
        if (ur) ur.value = '';
        if (em) em.value = '';
        if (ic) ic.value = '';
        await renderWorkspaceIconPreview();
        var rClr = window.currentOrganizationRole || '';
        if (rClr === 'owner' || rClr === 'admin') {
          await persistAppSettingsToSupabase({ includeDashboard: true });
        }
      });
    }

    var exContent = document.getElementById('btn-ws-export-content');
    if (exContent) {
      exContent.addEventListener('click', function () {
        if (!getCurrentOrgId()) {
          alert('Open a workspace URL to export.');
          return;
        }
        exportWorkspaceContentJson();
      });
    }

    var exMembers = document.getElementById('btn-ws-export-members');
    if (exMembers) {
      exMembers.addEventListener('click', function () {
        exportMembersCsv();
      });
    }

    var copyBtn = document.getElementById('btn-ws-copy-org-id');
    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        var oid = getCurrentOrgId();
        if (!oid) {
          alert('No workspace ID in this session.');
          return;
        }
        try {
          await navigator.clipboard.writeText(String(oid));
          var orig = copyBtn.textContent;
          copyBtn.textContent = 'Copied';
          window.setTimeout(function () {
            copyBtn.textContent = orig;
          }, 1200);
        } catch (_) {
          window.prompt('Copy workspace ID:', String(oid));
        }
      });
    }

    var delBtn = document.getElementById('btn-ws-delete-workspace');
    if (delBtn) {
      delBtn.addEventListener('click', async function () {
        if ((window.currentOrganizationRole || '') !== 'owner') {
          alert('Only the workspace owner can delete this workspace.');
          return;
        }
        var oid = getCurrentOrgId();
        if (!oid) return;
        var nm = document.getElementById('setting-ws-name');
        var label = nm && nm.value ? String(nm.value).trim() : 'this workspace';
        if (
          !confirm(
            'Permanently delete ' +
              label +
              '? This removes all workspace data for everyone. This cannot be undone.'
          )
        ) {
          return;
        }
        supabase = window.supabaseClient || supabase;
        if (!supabase) return;
        try {
          var rpc = await supabase.rpc('delete_workspace_as_owner', { p_org_id: oid });
          if (rpc.error) {
            console.error(rpc.error);
            alert(
              String(rpc.error.message || rpc.error).indexOf('schema cache') !== -1 ||
                String(rpc.error.message || '').indexOf('function') !== -1
                ? 'Delete is not available until the delete_workspace_as_owner RPC is deployed. See supabase/delete_workspace_organization.sql.'
                : 'Could not delete workspace: ' + (rpc.error.message || rpc.error)
            );
            return;
          }
          var payload = rpc.data;
          if (payload && typeof payload === 'object' && payload.ok === false) {
            alert(payload.error ? String(payload.error) : 'Could not delete workspace.');
            return;
          }
          alert('Workspace deleted. You will be redirected.');
          window.location.href = '/';
        } catch (err) {
          console.error(err);
          alert('Delete failed.');
        }
      });
    }

    var nameEl = document.getElementById('setting-ws-name');
    if (nameEl) {
      nameEl.addEventListener('input', function () {
        var exportDesc = document.getElementById('setting-ws-export-content-desc');
        if (exportDesc) {
          var nm = String(nameEl.value || '').trim() || 'this workspace';
          exportDesc.textContent =
            'Export clients, transactions, projects, invoices, campaigns, and timesheet entries for ' +
            nm +
            ' as JSON.';
        }
      });
    }

    updateWorkspaceIconAdminUi();
  }

  // ---------- Workspace lists (sidebar + templates modals; localStorage test) ----------
  var listsFeatureWired = false;
  var listsUi = { selectedTplId: null, activeCat: 'content', search: '' };

  var LIST_CATEGORIES = [
    { id: 'content', label: 'Content' },
    { id: 'operations', label: 'Operations' },
    { id: 'sales', label: 'Sales' },
  ];

  var LIST_TEMPLATES = [
    {
      id: 'tpl-content',
      category: 'content',
      emoji: '🎨',
      title: 'Content co-creation',
      dataType: 'People',
      desc:
        'Manage your content pipeline and streamline outreach to co-creators. Organize podcasts, interviews, and published pieces.',
      tags: [
        { label: 'Content', tone: 'amber' },
        { label: 'PR', tone: 'mint' },
      ],
      columns: [
        { id: 'c1', name: 'Person' },
        { id: 'c2', name: 'Content piece' },
        { id: 'c3', name: 'Topics' },
      ],
      rows: [
        { c1: 'Steven Walsh', c2: 'Blogpost', c3: 'Startups' },
        { c1: 'Lori Simpson', c2: 'Customer Story', c3: 'Investing' },
        { c1: 'Alex Kim', c2: 'Tutorial', c3: 'Product' },
      ],
    },
    {
      id: 'tpl-editorial',
      category: 'content',
      emoji: '📝',
      title: 'Editorial calendar',
      dataType: 'People',
      desc: 'Track drafts, reviews, and publish dates across channels in one lightweight list.',
      tags: [{ label: 'Content', tone: 'amber' }],
      columns: [
        { id: 'c1', name: 'Title' },
        { id: 'c2', name: 'Channel' },
        { id: 'c3', name: 'Status' },
      ],
      rows: [
        { c1: 'Q2 launch post', c2: 'Blog', c3: 'Draft' },
        { c1: 'Customer webinar', c2: 'Email', c3: 'Scheduled' },
      ],
    },
    {
      id: 'tpl-rollout',
      category: 'operations',
      emoji: '🚀',
      title: 'Weekly rollout checklist',
      dataType: 'Tasks',
      desc: 'Ship checklist for releases: owners, blockers, and sign-off in one view.',
      tags: [{ label: 'Operations', tone: 'blue' }],
      columns: [
        { id: 'c1', name: 'Task' },
        { id: 'c2', name: 'Owner' },
        { id: 'c3', name: 'Status' },
      ],
      rows: [
        { c1: 'Freeze dependencies', c2: 'Eng', c3: 'Done' },
        { c1: 'Staging smoke test', c2: 'QA', c3: 'In progress' },
        { c1: 'Announce in Slack', c2: 'PM', c3: 'Todo' },
      ],
    },
    {
      id: 'tpl-pipeline',
      category: 'sales',
      emoji: '📈',
      title: 'Deal pipeline',
      dataType: 'Companies',
      desc: 'Lightweight pipeline: company, stage, and amount for quick reviews.',
      tags: [{ label: 'Sales', tone: 'blue' }],
      columns: [
        { id: 'c1', name: 'Company' },
        { id: 'c2', name: 'Stage' },
        { id: 'c3', name: 'Amount' },
      ],
      rows: [
        { c1: 'Northwind', c2: 'Proposal', c3: '$24k' },
        { c1: 'Acme Co', c2: 'Discovery', c3: '$8k' },
        { c1: 'Contoso', c2: 'Closed won', c3: '$42k' },
      ],
    },
  ];

  function listsStorageKey() {
    var u = window.currentUser && window.currentUser.id ? String(window.currentUser.id) : 'guest';
    var o = window.currentOrganizationId ? String(window.currentOrganizationId) : 'noorg';
    return 'bizdash:' + u + ':' + o + ':workspace-lists:v1';
  }

  function loadWorkspaceLists() {
    try {
      var raw = localStorage.getItem(listsStorageKey());
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveWorkspaceLists(arr) {
    try {
      localStorage.setItem(listsStorageKey(), JSON.stringify(arr || []));
    } catch (_) {}
  }

  function escList(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function newListId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'L' + Date.now() + Math.random().toString(36).slice(2, 9);
  }

  function findListTemplate(id) {
    var tid = String(id || '');
    for (var i = 0; i < LIST_TEMPLATES.length; i++) {
      if (LIST_TEMPLATES[i].id === tid) return LIST_TEMPLATES[i];
    }
    return null;
  }

  function listInstanceFromTemplate(tpl) {
    return {
      id: newListId(),
      title: tpl.title,
      templateId: tpl.id,
      category: tpl.category,
      dataType: tpl.dataType,
      columns: JSON.parse(JSON.stringify(tpl.columns)),
      rows: JSON.parse(JSON.stringify(tpl.rows)),
    };
  }

  function blankWorkspaceList(title) {
    return {
      id: newListId(),
      title: title || 'Untitled list',
      templateId: null,
      category: 'operations',
      dataType: 'Rows',
      columns: [
        { id: 'c1', name: 'Name' },
        { id: 'c2', name: 'Notes' },
      ],
      rows: [
        { c1: '', c2: '' },
        { c1: '', c2: '' },
      ],
    };
  }

  function pushWorkspaceList(L) {
    var arr = loadWorkspaceLists();
    arr.unshift(L);
    saveWorkspaceLists(arr);
    renderListsSidebar();
    renderListsPageGrid();
  }

  function renderListsSidebar() {
    var host = document.getElementById('lists-sb-items');
    if (!host) return;
    var lists = loadWorkspaceLists();
    if (!lists.length) {
      host.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:4px 10px;">No saved lists</div>';
      return;
    }
    host.innerHTML = lists
      .slice(0, 8)
      .map(function (L) {
        return (
          '<button type="button" class="lists-sb-item" data-list-id="' +
          escList(L.id) +
          '">' +
          escList(L.title) +
          '</button>'
        );
      })
      .join('');
    host.querySelectorAll('.lists-sb-item').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-list-id');
        openListDetailView(id);
        window.nav('lists', document.querySelector('.ni[data-nav="lists"]'));
        document.body.classList.remove('mobile-nav-open');
      });
    });
  }

  var ADVISOR_CHAT_TURNS_CAP = 48;

  function chatsStorageKey() {
    var u = window.currentUser && window.currentUser.id ? String(window.currentUser.id) : 'guest';
    var o = getCurrentOrgId() ? String(getCurrentOrgId()) : 'noorg';
    return 'bizdash:' + u + ':' + o + ':advisor-chats:v1';
  }

  function loadWorkspaceChats() {
    try {
      var raw = localStorage.getItem(chatsStorageKey());
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (_) {
      return [];
    }
  }

  function saveWorkspaceChats(arr) {
    try {
      localStorage.setItem(chatsStorageKey(), JSON.stringify(arr || []));
    } catch (_) {}
  }

  function newAdvisorChatId() {
    return typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'C' + Date.now() + Math.random().toString(36).slice(2, 9);
  }

  function findWorkspaceChatById(arr, id) {
    var tid = String(id || '');
    for (var i = 0; i < arr.length; i++) {
      if (String(arr[i].id) === tid) return arr[i];
    }
    return null;
  }

  function trimAdvisorTurns(turns) {
    var t = Array.isArray(turns) ? turns.slice() : [];
    while (t.length > ADVISOR_CHAT_TURNS_CAP) t.shift();
    return t;
  }

  function renderChatsSidebar() {
    var host = document.getElementById('chats-sb-items');
    if (!host) return;
    var chats = loadWorkspaceChats();
    if (!chats.length) {
      host.innerHTML = '<div style="font-size:11px;color:var(--text3);padding:4px 10px;">No saved chats</div>';
      return;
    }
    host.innerHTML = chats
      .slice(0, 8)
      .map(function (C) {
        return (
          '<button type="button" class="lists-sb-item" data-advisor-chat-id="' +
          escList(C.id) +
          '">' +
          escList(C.title || 'Chat') +
          '</button>'
        );
      })
      .join('');
    host.querySelectorAll('[data-advisor-chat-id]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-advisor-chat-id');
        openAdvisorThreadFromSidebar(id);
      });
    });
  }

  function openAdvisorThreadFromSidebar(threadId) {
    var chats = loadWorkspaceChats();
    var L = findWorkspaceChatById(chats, threadId);
    if (!L || !Array.isArray(L.turns) || !L.turns.length) return;
    try {
      sessionStorage.setItem('advisor-active-thread', String(threadId));
      sessionStorage.setItem('advisor-pending-replay', JSON.stringify(L.turns));
    } catch (_) {}
    window.nav('chat', document.querySelector('.ni[data-nav="chat"]'));
    document.body.classList.remove('mobile-nav-open');
  }

  window.bizDashStartNewAdvisorSidebarThread = function () {
    try {
      sessionStorage.removeItem('advisor-active-thread');
      sessionStorage.removeItem('advisor-pending-replay');
    } catch (_) {}
    if (typeof window.resetAdvisorChatForNewThread === 'function') {
      window.resetAdvisorChatForNewThread();
    }
  };

  window.bizDashAdvisorChatOnUserMessage = function (userLine) {
    var line = String(userLine || '').trim();
    if (!line) return;
    var chats = loadWorkspaceChats();
    var tid = null;
    try {
      tid = sessionStorage.getItem('advisor-active-thread');
    } catch (_) {}
    if (!tid) {
      tid = newAdvisorChatId();
      try {
        sessionStorage.setItem('advisor-active-thread', tid);
      } catch (_) {}
      var title = line.length > 52 ? line.slice(0, 52) + '…' : line;
      chats.unshift({
        id: tid,
        title: title,
        updatedAt: new Date().toISOString(),
        turns: [{ role: 'user', text: line }],
      });
    } else {
      var row = findWorkspaceChatById(chats, tid);
      if (!row) {
        var t2 = line.length > 52 ? line.slice(0, 52) + '…' : line;
        chats.unshift({
          id: tid,
          title: t2,
          updatedAt: new Date().toISOString(),
          turns: [{ role: 'user', text: line }],
        });
      } else {
        row.turns = trimAdvisorTurns((row.turns || []).concat([{ role: 'user', text: line }]));
        row.updatedAt = new Date().toISOString();
        if (!row.title || row.title === 'New chat') {
          row.title = line.length > 52 ? line.slice(0, 52) + '…' : line;
        }
      }
    }
    saveWorkspaceChats(chats);
    renderChatsSidebar();
  };

  window.bizDashAdvisorChatOnAssistantMessage = function (plainText) {
    var txt = String(plainText || '').trim();
    if (!txt) return;
    var tid = null;
    try {
      tid = sessionStorage.getItem('advisor-active-thread');
    } catch (_) {}
    if (!tid) return;
    var chats = loadWorkspaceChats();
    var row = findWorkspaceChatById(chats, tid);
    if (!row) return;
    row.turns = trimAdvisorTurns((row.turns || []).concat([{ role: 'asst', text: txt }]));
    row.updatedAt = new Date().toISOString();
    saveWorkspaceChats(chats);
    renderChatsSidebar();
  };

  function renderListsPageGrid() {
    var grid = document.getElementById('lists-grid');
    var empty = document.getElementById('lists-empty-hint');
    if (!grid || !empty) return;
    var lists = loadWorkspaceLists();
    if (!lists.length) {
      empty.style.display = 'block';
      grid.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = lists
      .map(function (L) {
        return (
          '<div class="card list-card" data-list-id="' +
          escList(L.id) +
          '" style="cursor:pointer;padding:16px;border-radius:10px;">' +
          '<div style="font-weight:600;font-size:15px;margin-bottom:6px;">' +
          escList(L.title) +
          '</div>' +
          '<div style="font-size:12px;color:var(--text3);">' +
          escList(L.dataType || 'List') +
          ' · ' +
          (L.rows || []).length +
          ' rows</div></div>'
        );
      })
      .join('');
    grid.querySelectorAll('.list-card').forEach(function (card) {
      card.addEventListener('click', function () {
        openListDetailView(card.getAttribute('data-list-id'));
      });
    });
  }

  function openListDetailView(listId) {
    var lists = loadWorkspaceLists();
    var L = null;
    for (var i = 0; i < lists.length; i++) {
      if (String(lists[i].id) === String(listId)) L = lists[i];
    }
    var main = document.getElementById('lists-view-main');
    var det = document.getElementById('lists-view-detail');
    var title = document.getElementById('lists-detail-title');
    var sub = document.getElementById('lists-detail-sub');
    var wrap = document.getElementById('lists-detail-table-wrap');
    if (!L || !main || !det || !wrap) return;
    main.style.display = 'none';
    det.style.display = 'block';
    if (title) title.textContent = L.title;
    if (sub) sub.textContent = (L.dataType || 'List') + (L.templateId ? ' · from template' : '');
    var cols = L.columns || [];
    var thead =
      '<tr>' +
      cols
        .map(function (c) {
          return '<th>' + escList(c.name) + '</th>';
        })
        .join('') +
      '</tr>';
    var rows = L.rows || [];
    var tb = rows
      .map(function (r) {
        return (
          '<tr>' +
          cols
            .map(function (c) {
              return '<td>' + escList(r[c.id] != null ? r[c.id] : '') + '</td>';
            })
            .join('') +
          '</tr>'
        );
      })
      .join('');
    wrap.innerHTML = '<table class="dt"><thead>' + thead + '</thead><tbody>' + tb + '</tbody></table>';
    det.setAttribute('data-active-list', L.id);
  }

  function closeListDetailView() {
    var main = document.getElementById('lists-view-main');
    var det = document.getElementById('lists-view-detail');
    if (main) main.style.display = 'block';
    if (det) {
      det.style.display = 'none';
      det.removeAttribute('data-active-list');
    }
    renderListsPageGrid();
  }

  function openListTemplatesModal() {
    listsUi.selectedTplId = null;
    listsUi.activeCat = LIST_CATEGORIES[0].id;
    listsUi.search = '';
    var q = document.getElementById('list-tmpl-search');
    if (q) q.value = '';
    var modal = document.getElementById('listTemplatesModal');
    if (modal) {
      modal.classList.add('on');
      modal.setAttribute('aria-hidden', 'false');
    }
    renderListTemplateCategories();
    renderListTemplateCards();
    syncListPreviewButton();
  }

  function closeListTemplatesModal() {
    var modal = document.getElementById('listTemplatesModal');
    if (modal) {
      modal.classList.remove('on');
      modal.setAttribute('aria-hidden', 'true');
    }
  }

  function renderListTemplateCategories() {
    var host = document.getElementById('list-tmpl-cats');
    if (!host) return;
    host.innerHTML = LIST_CATEGORIES.map(function (c) {
      return (
        '<button type="button" class="list-tmpl-cat' +
        (c.id === listsUi.activeCat ? ' on' : '') +
        '" data-cat="' +
        escList(c.id) +
        '"><span class="dot" aria-hidden="true"></span>' +
        escList(c.label) +
        '</button>'
      );
    }).join('');
    host.querySelectorAll('.list-tmpl-cat').forEach(function (btn) {
      btn.addEventListener('click', function () {
        listsUi.activeCat = btn.getAttribute('data-cat') || 'content';
        renderListTemplateCategories();
        renderListTemplateCards();
      });
    });
  }

  function filteredListTemplates() {
    var q = (listsUi.search || '').toLowerCase().trim();
    return LIST_TEMPLATES.filter(function (t) {
      if (t.category !== listsUi.activeCat) return false;
      if (!q) return true;
      return (
        (t.title && t.title.toLowerCase().indexOf(q) !== -1) ||
        (t.desc && t.desc.toLowerCase().indexOf(q) !== -1)
      );
    });
  }

  function renderListTemplateCards() {
    var host = document.getElementById('list-tmpl-cards');
    if (!host) return;
    var arr = filteredListTemplates();
    if (!arr.length) {
      host.innerHTML = '<p style="font-size:13px;color:#94a3b8;padding:12px;">No templates in this category.</p>';
      return;
    }
    host.innerHTML = arr
      .map(function (t) {
        var tags = (t.tags || [])
          .map(function (g) {
            var bg = '#93c5fd33';
            if (g.tone === 'mint') bg = 'rgba(110,231,183,0.25)';
            if (g.tone === 'amber') bg = 'rgba(252,211,77,0.35)';
            return (
              '<span class="list-tmpl-tag" style="background:' +
              bg +
              ';color:#334155;">' +
              escList(g.label) +
              '</span>'
            );
          })
          .join('');
        return (
          '<button type="button" class="list-tmpl-card' +
          (t.id === listsUi.selectedTplId ? ' on' : '') +
          '" data-tpl="' +
          escList(t.id) +
          '"><div class="list-tmpl-thumb" aria-hidden="true">' +
          escList(t.emoji || '📋') +
          '</div><div><div class="list-tmpl-card-title">' +
          escList(t.title) +
          '<span class="list-tmpl-badge">◎ ' +
          escList(t.dataType) +
          '</span></div><p class="list-tmpl-desc">' +
          escList(t.desc) +
          '</p><div class="list-tmpl-tags">' +
          tags +
          '</div></div></button>'
        );
      })
      .join('');
    host.querySelectorAll('.list-tmpl-card').forEach(function (btn) {
      btn.addEventListener('click', function () {
        listsUi.selectedTplId = btn.getAttribute('data-tpl');
        renderListTemplateCards();
        syncListPreviewButton();
      });
    });
  }

  function syncListPreviewButton() {
    var b = document.getElementById('list-tmpl-preview');
    if (b) b.disabled = !listsUi.selectedTplId;
  }

  function openListPreviewModal(tplId) {
    var tpl = findListTemplate(tplId);
    if (!tpl) return;
    var modal = document.getElementById('listPreviewModal');
    var ti = document.getElementById('list-prev-title');
    var ent = document.getElementById('list-prev-entity');
    var desc = document.getElementById('list-prev-desc');
    var thead = document.getElementById('list-prev-thead');
    var tbody = document.getElementById('list-prev-tbody');
    var attrs = document.getElementById('list-prev-attrs');
    if (ti) ti.textContent = (tpl.emoji ? tpl.emoji + ' ' : '') + tpl.title;
    if (ent) ent.textContent = tpl.dataType || 'List';
    if (desc) desc.textContent = tpl.desc || '';
    if (thead) {
      thead.innerHTML =
        '<tr>' +
        tpl.columns
          .map(function (c) {
            return '<th>' + escList(c.name) + '</th>';
          })
          .join('') +
        '</tr>';
    }
    if (tbody) {
      tbody.innerHTML = (tpl.rows || [])
        .map(function (r) {
          return (
            '<tr>' +
            tpl.columns
              .map(function (c) {
                return '<td>' + escList(r[c.id] != null ? r[c.id] : '') + '</td>';
              })
              .join('') +
            '</tr>'
          );
        })
        .join('');
    }
    if (attrs) {
      attrs.textContent = 'Columns: ' + tpl.columns.map(function (c) { return c.name; }).join(', ');
    }
    if (modal) {
      modal.classList.add('on');
      modal.setAttribute('aria-hidden', 'false');
      modal.setAttribute('data-tpl', tplId);
    }
  }

  function closeListPreviewModal() {
    var modal = document.getElementById('listPreviewModal');
    if (modal) {
      modal.classList.remove('on');
      modal.setAttribute('aria-hidden', 'true');
      modal.removeAttribute('data-tpl');
    }
  }

  function wireListsFeature() {
    if (listsFeatureWired) return;
    listsFeatureWired = true;

    var wrap = document.getElementById('lists-sb-wrap');
    var toggle = document.getElementById('lists-sb-toggle');
    if (toggle && wrap) {
      toggle.addEventListener('click', function () {
        wrap.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', wrap.classList.contains('collapsed') ? 'false' : 'true');
      });
    }

    function bindNew(id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', openListTemplatesModal);
    }
    bindNew('lists-btn-sidebar-new');
    bindNew('lists-btn-page-new');

    var browse = document.getElementById('lists-sb-browse');
    if (browse) {
      browse.addEventListener('click', function () {
        window.nav('lists', document.querySelector('.ni[data-nav="lists"]'));
        document.body.classList.remove('mobile-nav-open');
      });
    }

    var chatsWrap = document.getElementById('chats-sb-wrap');
    var chatsToggle = document.getElementById('chats-sb-toggle');
    if (chatsToggle && chatsWrap) {
      chatsToggle.addEventListener('click', function () {
        chatsWrap.classList.toggle('collapsed');
        chatsToggle.setAttribute('aria-expanded', chatsWrap.classList.contains('collapsed') ? 'false' : 'true');
      });
    }
    var chatsNew = document.getElementById('chats-btn-sidebar-new');
    if (chatsNew) {
      chatsNew.addEventListener('click', function () {
        if (typeof window.bizDashStartNewAdvisorSidebarThread === 'function') {
          window.bizDashStartNewAdvisorSidebarThread();
        }
        window.nav('chat', document.querySelector('.ni[data-nav="chat"]'));
        document.body.classList.remove('mobile-nav-open');
      });
    }
    var chatsBrowse = document.getElementById('chats-sb-browse');
    if (chatsBrowse) {
      chatsBrowse.addEventListener('click', function () {
        window.nav('chat', document.querySelector('.ni[data-nav="chat"]'));
        document.body.classList.remove('mobile-nav-open');
      });
    }

    var closeT = document.getElementById('list-tmpl-close');
    if (closeT) closeT.addEventListener('click', closeListTemplatesModal);
    var scratch = document.getElementById('list-tmpl-scratch');
    if (scratch) {
      scratch.addEventListener('click', function () {
        closeListTemplatesModal();
        var name = window.prompt('Name your list', 'Untitled list');
        if (name === null) return;
        pushWorkspaceList(blankWorkspaceList(String(name).trim() || 'Untitled list'));
        window.nav('lists', document.querySelector('.ni[data-nav="lists"]'));
        var first = loadWorkspaceLists()[0];
        if (first) openListDetailView(first.id);
      });
    }
    var prevBtn = document.getElementById('list-tmpl-preview');
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (!listsUi.selectedTplId) return;
        openListPreviewModal(listsUi.selectedTplId);
      });
    }
    var tModal = document.getElementById('listTemplatesModal');
    if (tModal) {
      tModal.addEventListener('click', function (ev) {
        if (ev.target === tModal) closeListTemplatesModal();
      });
    }

    var search = document.getElementById('list-tmpl-search');
    if (search) {
      search.addEventListener('input', function () {
        listsUi.search = search.value;
        renderListTemplateCards();
      });
    }

    var prevClose = document.getElementById('list-prev-close');
    if (prevClose) prevClose.addEventListener('click', closeListPreviewModal);
    var prevBack = document.getElementById('list-prev-back');
    if (prevBack) prevBack.addEventListener('click', closeListPreviewModal);
    var pModal = document.getElementById('listPreviewModal');
    if (pModal) {
      pModal.addEventListener('click', function (ev) {
        if (ev.target === pModal) closeListPreviewModal();
      });
    }
    var useTpl = document.getElementById('list-prev-use');
    if (useTpl) {
      useTpl.addEventListener('click', function () {
        var modal = document.getElementById('listPreviewModal');
        var tid = modal && modal.getAttribute('data-tpl');
        if (!tid) return;
        var tpl = findListTemplate(tid);
        closeListPreviewModal();
        closeListTemplatesModal();
        if (tpl) pushWorkspaceList(listInstanceFromTemplate(tpl));
        window.nav('lists', document.querySelector('.ni[data-nav="lists"]'));
        var first = loadWorkspaceLists()[0];
        if (first) openListDetailView(first.id);
      });
    }

    var backLists = document.getElementById('lists-btn-back');
    if (backLists) backLists.addEventListener('click', closeListDetailView);

    document.addEventListener('keydown', function (ev) {
      var m = document.getElementById('listTemplatesModal');
      if (m && m.classList.contains('on') && ev.key === 'Escape') closeListTemplatesModal();
      var p = document.getElementById('listPreviewModal');
      if (p && p.classList.contains('on') && ev.key === 'Escape') closeListPreviewModal();
    });

    renderListsSidebar();
    renderListsPageGrid();
    renderChatsSidebar();
  }

  // ---------- Sidebar top chrome (workspace label + quick actions / search pills) ----------
  var sidebarChromeWired = false;

  function parseTenantSlugForChrome() {
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

  function workspaceSidebarFallbackLetter() {
    var slug = window.currentOrganizationSlug || parseTenantSlugForChrome();
    var dn = window.currentOrganizationDisplayName && String(window.currentOrganizationDisplayName).trim();
    var letterSource = dn || slug || '';
    return letterSource ? String(letterSource).trim().charAt(0).toUpperCase() : '?';
  }

  async function refreshWorkspaceSidebarMonogramFromPrefs() {
    var ws = mergeWorkspacePrefs({}, window.bizdashWorkspacePrefs || defaultWorkspacePrefs());
    var url = ws.workspaceIconUrl != null ? String(ws.workspaceIconUrl).trim() : '';
    var iconify = parseWorkspaceIconIconify(ws.workspaceIconIconify != null ? String(ws.workspaceIconIconify) : '');
    var emo = ws.workspaceIconEmoji != null ? String(ws.workspaceIconEmoji).trim() : '';
    var pairs = [
      ['sb-ws-avatar-img', 'sb-ws-mono-letter'],
      ['sb-menu-ws-avatar-img', 'sb-menu-ws-mono-letter'],
    ];
    var fbLetter = workspaceSidebarFallbackLetter();
    for (var i = 0; i < pairs.length; i += 1) {
      var im = document.getElementById(pairs[i][0]);
      var le = document.getElementById(pairs[i][1]);
      if (!im || !le) continue;
      le.classList.remove('sb-ws-mono-emoji');
      if (url) {
        var resolved = await resolveBrandLogoStorageUrl(url);
        im.src = resolved || url;
        im.alt = '';
        im.style.display = 'block';
        le.style.display = 'none';
      } else if (iconify) {
        var nm = iconify.slice('lucide:'.length);
        im.src = lucideIconifySvgImgSrc(nm);
        im.alt = '';
        im.style.display = 'block';
        le.style.display = 'none';
      } else if (emo) {
        im.removeAttribute('src');
        im.style.display = 'none';
        le.style.display = '';
        le.textContent = emo.slice(0, 10);
        le.classList.add('sb-ws-mono-emoji');
      } else {
        im.removeAttribute('src');
        im.style.display = 'none';
        le.style.display = '';
        le.textContent = fbLetter;
      }
    }
  }
  window.bizdashRefreshWorkspaceSidebarMonogram = refreshWorkspaceSidebarMonogramFromPrefs;

  function refreshSidebarWorkspaceChrome() {
    var slug = window.currentOrganizationSlug || parseTenantSlugForChrome();
    var labelEl = document.getElementById('sb-ws-label');
    var letterEl = document.getElementById('sb-ws-mono-letter');
    var dn = window.currentOrganizationDisplayName && String(window.currentOrganizationDisplayName).trim();
    var display = dn || (slug ? String(slug) : 'Workspace');
    var letterSource = dn || slug || '';
    var letter = letterSource ? String(letterSource).trim().charAt(0).toUpperCase() : '?';
    if (labelEl) labelEl.textContent = display;
    if (letterEl) letterEl.textContent = letter;
    var menuLetter = document.getElementById('sb-menu-ws-mono-letter');
    var menuLabel = document.getElementById('sb-menu-ws-label');
    if (menuLetter) menuLetter.textContent = letter;
    if (menuLabel) menuLabel.textContent = display;
    applyWorkspaceChromeProfileAvatar();
  }

  var sidebarChromeMenuOpen = false;

  function positionSidebarChromeMenu() {
    var btn = document.getElementById('btn-sb-chrome-menu');
    var pop = document.getElementById('sb-chrome-menu-pop');
    if (!btn || !pop || !pop.classList.contains('on')) return;
    var r = btn.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    var w = pr.width;
    var h = pr.height;
    var margin = 6;
    var left = r.left;
    var top = r.bottom + margin;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - margin);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function openSidebarChromeMenu() {
    var pop = document.getElementById('sb-chrome-menu-pop');
    var bd = document.getElementById('sb-chrome-menu-backdrop');
    var btn = document.getElementById('btn-sb-chrome-menu');
    if (!pop || !btn) return;
    refreshSidebarWorkspaceChrome();
    pop.classList.add('on');
    if (bd) bd.classList.add('on');
    btn.setAttribute('aria-expanded', 'true');
    sidebarChromeMenuOpen = true;
    positionSidebarChromeMenu();
  }

  function closeSidebarChromeMenu() {
    var pop = document.getElementById('sb-chrome-menu-pop');
    var bd = document.getElementById('sb-chrome-menu-backdrop');
    var btn = document.getElementById('btn-sb-chrome-menu');
    if (pop) pop.classList.remove('on');
    if (bd) bd.classList.remove('on');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    sidebarChromeMenuOpen = false;
  }

  window.closeSidebarChromeMenu = closeSidebarChromeMenu;
  window.openSidebarChromeMenu = openSidebarChromeMenu;

  function wireSidebarChrome() {
    if (sidebarChromeWired) return;
    sidebarChromeWired = true;
    window.refreshSidebarWorkspaceChrome = refreshSidebarWorkspaceChrome;

    refreshSidebarWorkspaceChrome();

    var profileHit = document.getElementById('sb-user-go-profile');
    if (profileHit && profileHit.getAttribute('data-wired-profile-hit') !== '1') {
      profileHit.setAttribute('data-wired-profile-hit', '1');
      profileHit.addEventListener('click', function () {
        if (typeof window.nav !== 'function') return;
        var ni = document.querySelector('.ni[data-nav="settings"]');
        window.nav('settings', ni);
        window.requestAnimationFrame(function () {
          var tab = document.getElementById('settings-nav-profile');
          if (tab) tab.click();
        });
      });
    }

    var wsBtn = document.getElementById('btn-sb-workspace-switch');
    if (wsBtn) {
      wsBtn.addEventListener('click', function () {
        if (typeof window.openWorkspaceSwitcherModal === 'function') window.openWorkspaceSwitcherModal();
      });
    }

    var kbdQa = document.getElementById('sb-chrome-kbd-qa');
    try {
      var mac =
        /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ||
        (typeof navigator.userAgent === 'string' && navigator.userAgent.includes('Mac OS'));
      if (kbdQa) kbdQa.textContent = mac ? '⌘K' : 'Ctrl+K';
    } catch (_) {}

    var chromeBtn = document.getElementById('btn-sb-chrome-menu');
    var backdrop = document.getElementById('sb-chrome-menu-backdrop');
    var pop = document.getElementById('sb-chrome-menu-pop');
    if (chromeBtn) {
      chromeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (typeof window.openQuickActionsModal === 'function') {
          window.openQuickActionsModal();
        }
      });
    }
    if (backdrop) {
      backdrop.addEventListener('click', function () {
        closeSidebarChromeMenu();
      });
    }
    function chromeMenuSignOut() {
      var sb = window.supabaseClient;
      if (sb && sb.auth) {
        sb.auth.signOut().finally(function () {
          if (typeof window.__dashboardShowLogin === 'function') window.__dashboardShowLogin();
        });
      } else if (typeof window.__dashboardShowLogin === 'function') {
        window.__dashboardShowLogin();
      }
    }
    if (pop) {
      pop.addEventListener('click', function (ev) {
        var row = ev.target.closest('[data-chrome-act]');
        if (!row) return;
        var act = row.getAttribute('data-chrome-act');
        closeSidebarChromeMenu();
        document.body.classList.remove('mobile-nav-open');
        if (act === 'new-ws') {
          if (typeof window.openWorkspaceSwitcherModal === 'function') window.openWorkspaceSwitcherModal();
        } else if (act === 'account-settings' || act === 'workspace-settings' || act === 'apps') {
          if (typeof window.nav === 'function') window.nav('settings', null);
        } else if (act === 'invite-team') {
          if (typeof window.nav === 'function') window.nav('team', null);
        } else if (act === 'refer-team') {
          try {
            var shareUrl = window.location.href || '';
            if (typeof window.prompt === 'function') {
              window.prompt('Copy your workspace link to share with another team:', shareUrl);
            }
          } catch (_) {}
        } else if (act === 'search-commands') {
          if (typeof window.openQuickActionsModal === 'function') window.openQuickActionsModal();
        } else if (act === 'sign-out') {
          chromeMenuSignOut();
        }
      });
    }
    window.addEventListener('resize', function () {
      if (sidebarChromeMenuOpen) positionSidebarChromeMenu();
    });
    document.addEventListener(
      'keydown',
      function (ev) {
        if (sidebarChromeMenuOpen && ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closeSidebarChromeMenu();
        }
      },
      true
    );
  }

  // ---------- Quick actions (command palette; dashboard-only entries) ----------
  var quickActionsWired = false;
  var qaSelectedIndex = 0;
  var qaFiltered = [];

  function qaEsc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function qaNavItem(pageId) {
    return document.querySelector('.ni[data-nav="' + pageId + '"]');
  }

  function qaGo(pageId) {
    var el = qaNavItem(pageId);
    window.nav(pageId, el);
    document.body.classList.remove('mobile-nav-open');
    closeQuickActionsModal();
  }

  function qaClickById(btnId) {
    var el = document.getElementById(btnId);
    if (el && !el.disabled) el.click();
    closeQuickActionsModal();
  }

  function qaMarketingNavVisible() {
    var el = document.querySelector('.ni.nav-public-facing[data-nav="marketing"]');
    if (!el) return false;
    return el.offsetParent !== null && window.getComputedStyle(el).display !== 'none';
  }

  function buildQuickActionDefs() {
    var defs = [
      {
        id: 'search-clients',
        label: 'Search clients',
        keys: '/',
        kw: 'search find customers clients crm people',
        run: function () {
          qaGo('customers');
          window.setTimeout(function () {
            var inp = document.getElementById('customers-search');
            if (inp) {
              inp.focus();
              inp.select();
            }
          }, 100);
        },
      },
      {
        id: 'chrome-menu',
        label: 'Workspace & account menu',
        keys: '',
        kw: 'sign out logout invite workspace settings new workspace team share link account',
        run: function () {
          closeQuickActionsModal();
          window.setTimeout(function () {
            if (typeof window.openSidebarChromeMenu === 'function') window.openSidebarChromeMenu();
          }, 10);
        },
      },
      { id: 'go-dash', label: 'Go to Dashboard', keys: '', kw: 'home performance kpi', run: function () { qaGo('dashboard'); } },
      { id: 'go-cust', label: 'Go to Customers', keys: '', kw: 'clients pipeline', run: function () { qaGo('customers'); } },
      { id: 'go-tasks', label: 'Go to Tasks', keys: '', kw: 'todo workflow', run: function () { qaGo('tasks'); } },
      { id: 'go-eml', label: 'Go to Emails', keys: '', kw: 'mail inbox drafts gmail compose', run: function () { qaGo('emails'); } },
      { id: 'go-inc', label: 'Go to Income', keys: '', kw: 'revenue invoices ar', run: function () { qaGo('revenue'); } },
      { id: 'go-exp', label: 'Go to Expenses', keys: '', kw: 'spend budget vendors', run: function () { qaGo('expenses'); } },
      { id: 'go-ts', label: 'Go to Timesheet', keys: '', kw: 'hours time', run: function () { qaGo('timesheet'); } },
      { id: 'go-lists', label: 'Browse all lists', keys: '', kw: 'lists templates', run: function () { qaGo('lists'); } },
      {
        id: 'new-list',
        label: 'New list…',
        keys: '',
        kw: 'template lists create',
        run: function () {
          closeQuickActionsModal();
          openListTemplatesModal();
        },
      },
      { id: 'go-perf', label: 'Go to Performance (Projects)', keys: '', kw: 'projects delivery', run: function () { qaGo('performance'); } },
      { id: 'go-ret', label: 'Go to Retention', keys: '', kw: 'churn', run: function () { qaGo('retention'); } },
      { id: 'go-ins', label: 'Go to Insights', keys: '', kw: 'analytics forecast', run: function () { qaGo('insights'); } },
      { id: 'go-adv', label: 'Open Advisor', keys: '', kw: 'ai chat copilot assistant', run: function () { qaGo('chat'); } },
      { id: 'go-team', label: 'Go to Your team', keys: '', kw: 'invite members', run: function () { qaGo('team'); } },
      { id: 'go-set', label: 'Open Settings', keys: '', kw: 'preferences profile branding mail calendar gmail google connections stripe', run: function () { qaGo('settings'); } },
      {
        id: 'workspaces',
        label: 'Switch workspace…',
        keys: '',
        kw: 'org organization url slug',
        run: function () {
          closeQuickActionsModal();
          if (typeof window.openWorkspaceSwitcherModal === 'function') window.openWorkspaceSwitcherModal();
        },
      },
      {
        id: 'add-tx',
        label: 'Add transaction',
        keys: '',
        kw: 'ledger log income expense line',
        run: function () {
          qaGo('dashboard');
          window.setTimeout(function () { qaClickById('btn-open-transaction'); }, 120);
        },
      },
      {
        id: 'upd-tot',
        label: 'Update totals',
        keys: '',
        kw: 'manual dashboard input',
        run: function () {
          qaGo('dashboard');
          window.setTimeout(function () { qaClickById('btn-open-input'); }, 120);
        },
      },
      {
        id: 'csv-im',
        label: 'Import transaction CSV',
        keys: '',
        kw: 'upload import',
        run: function () {
          qaGo('dashboard');
          window.setTimeout(function () { qaClickById('btn-csv-import-open'); }, 120);
        },
      },
      {
        id: 'csv-ex',
        label: 'Export journal CSV',
        keys: '',
        kw: 'download export',
        run: function () {
          qaGo('dashboard');
          window.setTimeout(function () { qaClickById('btn-journal-export-open'); }, 120);
        },
      },
      {
        id: 'dash-recap',
        label: 'View latest summary (Personable CRM)',
        keys: '',
        kw: 'recap crm personable dashboard summary',
        run: function () {
          qaGo('dashboard');
          window.setTimeout(function () {
            var sec = document.getElementById('crm-latest-summary-section');
            if (sec) sec.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }, 120);
        },
      },
      { id: 'add-cl', label: 'Add client', keys: '', kw: 'new customer company', run: function () { qaGo('customers'); window.setTimeout(function () { qaClickById('btn-add-client'); }, 100); } },
      { id: 'add-in', label: 'Add income', keys: '', kw: 'invoice payment', run: function () { qaGo('revenue'); window.setTimeout(function () { qaClickById('btn-add-income'); }, 100); } },
      { id: 'add-ex', label: 'Add expense', keys: '', kw: 'cost vendor', run: function () { qaGo('expenses'); window.setTimeout(function () { qaClickById('btn-add-expense'); }, 100); } },
      { id: 'add-tm', label: 'Add time entry', keys: '', kw: 'timesheet hours', run: function () { qaGo('timesheet'); window.setTimeout(function () { qaClickById('btn-add-time'); }, 100); } },
      {
        id: 'new-task',
        label: 'New task',
        keys: '',
        kw: 'workflow tasks',
        run: function () {
          qaGo('tasks');
          window.setTimeout(function () {
            var b = document.getElementById('btn-tasks-new') || document.getElementById('btn-tasks-new-empty');
            if (b && !b.disabled) b.click();
          }, 120);
        },
      },
      {
        id: 'add-proj',
        label: 'Add project',
        keys: '',
        kw: 'projects performance',
        run: function () {
          qaGo('performance');
          window.setTimeout(function () { qaClickById('btn-add-project'); }, 120);
        },
      },
      {
        id: 'manage-st',
        label: 'Manage project statuses',
        keys: '',
        kw: 'status labels pipeline',
        run: function () {
          qaGo('performance');
          window.setTimeout(function () { qaClickById('btn-manage-statuses'); }, 120);
        },
      },
    ];
    if (qaMarketingNavVisible()) {
      var ins = defs.findIndex(function (d) {
        return d.id === 'go-adv';
      });
      if (ins < 0) ins = defs.length;
      defs.splice(
        ins,
        0,
        {
          id: 'go-mkt',
          label: 'Go to Marketing',
          keys: '',
          kw: 'campaigns pipeline leads',
          run: function () {
            qaGo('marketing');
          },
        },
        {
          id: 'new-camp',
          label: 'New campaign',
          keys: '',
          kw: 'marketing campaign',
          run: function () {
            qaGo('marketing');
            window.setTimeout(function () {
              qaClickById('btn-new-campaign');
            }, 120);
          },
        }
      );
    }
    return defs;
  }

  function closeQuickActionsModal() {
    var m = document.getElementById('quickActionsModal');
    if (m) {
      m.classList.remove('on');
      m.setAttribute('aria-hidden', 'true');
    }
    var cb = document.getElementById('btn-sb-chrome-menu');
    if (cb) cb.setAttribute('aria-expanded', 'false');
  }

  function renderQuickActionsList() {
    var host = document.getElementById('qa-list');
    var inp = document.getElementById('qa-search');
    if (!host) return;
    var q = inp && inp.value ? String(inp.value).toLowerCase().trim() : '';
    var defs = buildQuickActionDefs();
    qaFiltered = !q
      ? defs
      : defs.filter(function (d) {
          var blob = (d.label + ' ' + (d.kw || '') + ' ' + (d.id || '')).toLowerCase();
          return blob.indexOf(q) !== -1;
        });
    if (qaSelectedIndex >= qaFiltered.length) qaSelectedIndex = Math.max(0, qaFiltered.length - 1);
    if (qaSelectedIndex < 0) qaSelectedIndex = 0;
    host.innerHTML = qaFiltered
      .map(function (d, i) {
        var kbd = d.keys ? '<span class="qa-kbd">' + qaEsc(d.keys) + '</span>' : '';
        return (
          '<button type="button" role="option" class="qa-row' +
          (i === qaSelectedIndex ? ' on' : '') +
          '" data-qa-idx="' +
          i +
          '">' +
          '<span class="qa-row-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></span>' +
          '<span class="qa-row-lbl">' +
          qaEsc(d.label) +
          '</span>' +
          kbd +
          '</button>'
        );
      })
      .join('');
    host.querySelectorAll('.qa-row').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-qa-idx'), 10);
        if (!isNaN(idx)) {
          qaSelectedIndex = idx;
          qaRunSelected();
        }
      });
    });
    var sel = host.querySelector('.qa-row.on');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function qaRunSelected() {
    var d = qaFiltered[qaSelectedIndex];
    if (!d || typeof d.run !== 'function') return;
    try {
      d.run();
    } catch (e) {
      console.warn('quick action', e);
    }
  }

  function openQuickActionsModal(opts) {
    opts = opts || {};
    if (typeof window.closeSidebarChromeMenu === 'function') window.closeSidebarChromeMenu();
    var m = document.getElementById('quickActionsModal');
    if (!m) return;
    qaSelectedIndex = 0;
    var inp = document.getElementById('qa-search');
    if (inp && opts.preserveQuery !== true) inp.value = '';
    m.classList.add('on');
    m.setAttribute('aria-hidden', 'false');
    var cb = document.getElementById('btn-sb-chrome-menu');
    if (cb) cb.setAttribute('aria-expanded', 'true');
    renderQuickActionsList();
    window.setTimeout(function () {
      if (inp) inp.focus();
    }, 30);
  }

  function qaIsTypingContext(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    if (t === 'textarea' || t === 'select') return true;
    if (t === 'input') {
      var typ = (el.type || '').toLowerCase();
      if (typ === 'checkbox' || typ === 'radio' || typ === 'button' || typ === 'submit') return false;
      return true;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function wireQuickActionsPalette() {
    if (quickActionsWired) return;
    quickActionsWired = true;

    window.openQuickActionsModal = openQuickActionsModal;
    window.closeQuickActionsModal = closeQuickActionsModal;

    var qaKbdMeta = document.getElementById('qa-search-meta-kbd');
    if (qaKbdMeta) {
      try {
        var macQa =
          /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ||
          (typeof navigator.userAgent === 'string' && navigator.userAgent.includes('Mac OS'));
        qaKbdMeta.textContent = macQa ? '⌘K' : 'Ctrl+K';
      } catch (_) {}
    }

    var m = document.getElementById('quickActionsModal');
    if (m) {
      m.addEventListener('click', function (ev) {
        if (ev.target === m) closeQuickActionsModal();
      });
    }
    var runBtn = document.getElementById('qa-run');
    if (runBtn) runBtn.addEventListener('click', qaRunSelected);
    var qIn = document.getElementById('qa-search');
    if (qIn) {
      qIn.addEventListener('input', function () {
        qaSelectedIndex = 0;
        renderQuickActionsList();
      });
      qIn.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          qaRunSelected();
        }
      });
    }

    document.addEventListener('keydown', function (ev) {
      var modal = document.getElementById('quickActionsModal');
      var open = modal && modal.classList.contains('on');
      if (open && ev.key === 'Escape') {
        ev.preventDefault();
        closeQuickActionsModal();
        return;
      }
      if (open && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
        ev.preventDefault();
        if (ev.key === 'ArrowDown') qaSelectedIndex = Math.min(qaFiltered.length - 1, qaSelectedIndex + 1);
        else qaSelectedIndex = Math.max(0, qaSelectedIndex - 1);
        renderQuickActionsList();
        return;
      }
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
        if (open) {
          ev.preventDefault();
          closeQuickActionsModal();
          return;
        }
        if (qaIsTypingContext(ev.target)) return;
        ev.preventDefault();
        openQuickActionsModal();
        return;
      }
      if (!open && ev.key === '/' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        if (qaIsTypingContext(ev.target)) return;
        ev.preventDefault();
        openQuickActionsModal();
        var inp2 = document.getElementById('qa-search');
        if (inp2) {
          window.setTimeout(function () {
            inp2.focus();
          }, 0);
        }
      }
    });
  }

  function wireReferEarnSettingsUi() {
    var root = document.getElementById('page-settings');
    if (!root || root.getAttribute('data-refer-earn-wired') === '1') return;
    if (!document.getElementById('settings-refer-url')) return;
    root.setAttribute('data-refer-earn-wired', '1');

    function compassReferralToken() {
      var slug = typeof window.currentOrganizationSlug === 'string' ? window.currentOrganizationSlug.trim() : '';
      var oid = typeof getCurrentOrgId === 'function' ? String(getCurrentOrgId() || '') : '';
      var uid = window.currentUser && window.currentUser.id ? String(window.currentUser.id) : '';
      var seed = slug + '|' + oid + '|' + uid;
      var h = 2166136261;
      for (var i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      }
      var pos = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      var out = '';
      var x = Math.abs(h | 0);
      for (var j = 0; j < 22; j++) {
        out += pos.charAt(x % 62);
        x = Math.floor(x / 62) + j * 31;
        if (x < 1) x = (h ^ j * 17) >>> 0;
      }
      return out.slice(0, 7) + '-' + out.slice(7, 15) + out.slice(15, 22);
    }

    function compassReferralUrl() {
      return 'https://compass.com/?r=' + encodeURIComponent(compassReferralToken());
    }

    function compassReferralMessage(url) {
      return (
        "Hey, we've been using Compass for our team. If you want to check it out, here's my link to get 10% off your first year: " +
        url
      );
    }

    function refreshReferEarnPanel() {
      var url = compassReferralUrl();
      var inp = document.getElementById('settings-refer-url');
      var msgEl = document.getElementById('settings-refer-message-text');
      if (inp) inp.value = url;
      if (msgEl) msgEl.textContent = compassReferralMessage(url);
    }
    window.refreshReferEarnPanel = refreshReferEarnPanel;

    root.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.id === 'settings-refer-learn') {
        ev.preventDefault();
        alert(
          'Compass rewards: when someone starts a paid workspace through your referral link, you can earn account credit. Program details will be published before billing goes live—share your link to give teams 10% off their first year.'
        );
      }
    });

    var terms = document.getElementById('settings-refer-terms-btn');
    if (terms) {
      terms.addEventListener('click', function () {
        alert(
          'Compass referral terms: the 10% first-year discount applies to new workspaces that sign up through a valid referral link and take a qualifying paid plan. Referrer rewards follow Compass program rules. Full Terms & Conditions will be posted before charges apply.'
        );
      });
    }

    var copyLink = document.getElementById('settings-refer-copy-link');
    var copyMsg = document.getElementById('settings-refer-copy-message');
    var copyLinkHtml = copyLink ? copyLink.innerHTML : '';
    var copyMsgHtml = copyMsg ? copyMsg.innerHTML : '';

    if (copyLink) {
      copyLink.addEventListener('click', async function () {
        var inp = document.getElementById('settings-refer-url');
        var text = inp && inp.value ? String(inp.value).trim() : compassReferralUrl();
        try {
          await navigator.clipboard.writeText(text);
          copyLink.textContent = 'Copied!';
          setTimeout(function () {
            copyLink.innerHTML = copyLinkHtml;
          }, 1500);
        } catch (_) {
          prompt('Copy this link:', text);
        }
      });
    }

    if (copyMsg) {
      copyMsg.addEventListener('click', async function () {
        refreshReferEarnPanel();
        var msgEl = document.getElementById('settings-refer-message-text');
        var text = msgEl ? msgEl.textContent || '' : '';
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          copyMsg.textContent = 'Copied!';
          setTimeout(function () {
            copyMsg.innerHTML = copyMsgHtml;
          }, 1500);
        } catch (_) {
          prompt('Copy this message:', text);
        }
      });
    }

    refreshReferEarnPanel();
  }

  function wirePeopleSettingsUi() {
    var root = document.getElementById('page-settings');
    if (!root || root.getAttribute('data-people-ui-wired') === '1') return;
    if (!document.getElementById('settings-people-tab-guests')) return;
    root.setAttribute('data-people-ui-wired', '1');

    function goTeam() {
      var t = document.querySelector('.ni[data-nav="team"]');
      if (typeof window.nav === 'function') window.nav('team', t || null);
    }

    root.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.id === 'settings-people-learn-inline') {
        ev.preventDefault();
        goTeam();
      }
    });

    var dir = document.getElementById('settings-people-directory-link');
    if (dir) {
      dir.addEventListener('click', function (ev) {
        ev.preventDefault();
        goTeam();
      });
    }

    var regen = document.getElementById('settings-people-regen-link');
    if (regen) {
      regen.addEventListener('click', function (ev) {
        ev.preventDefault();
        goTeam();
      });
    }

    var invToggle = document.getElementById('settings-people-invite-enabled');
    var LS_KEY = 'bizdash.settings.inviteLinkEnabled';
    if (invToggle) {
      var saved = localStorage.getItem(LS_KEY);
      if (saved === '0') invToggle.checked = false;
      invToggle.addEventListener('change', function () {
        localStorage.setItem(LS_KEY, invToggle.checked ? '1' : '0');
      });
    }

    var copyBtn = document.getElementById('settings-people-copy-link');
    if (copyBtn) {
      copyBtn.addEventListener('click', async function () {
        if (invToggle && !invToggle.checked) {
          alert('Turn on the invite link toggle to copy a shareable link.');
          return;
        }
        var u = typeof window.__bizdashLastInviteShareUrl === 'string' ? window.__bizdashLastInviteShareUrl.trim() : '';
        if (!u) {
          alert(
            'No invite link yet. On Your team, enter an email and choose Create invite link—then you can copy that URL here.'
          );
          return;
        }
        try {
          await navigator.clipboard.writeText(u);
          var orig = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(function () {
            copyBtn.textContent = orig;
          }, 1500);
        } catch (_) {
          prompt('Copy this link:', u);
        }
      });
    }

    var pills = root.querySelectorAll('.settings-people-pill[data-people-sub]');
    var subGuests = document.getElementById('settings-people-sub-guests');
    var subMembers = document.getElementById('settings-people-sub-members');
    var subGroups = document.getElementById('settings-people-sub-groups');
    var subContacts = document.getElementById('settings-people-sub-contacts');
    var subs = { guests: subGuests, members: subMembers, groups: subGroups, contacts: subContacts };
    pills.forEach(function (p) {
      p.addEventListener('click', function () {
        var id = p.getAttribute('data-people-sub');
        pills.forEach(function (x) {
          var on = x === p;
          x.classList.toggle('on', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        Object.keys(subs).forEach(function (k) {
          var el = subs[k];
          if (el) el.hidden = k !== id;
        });
      });
    });

    var searchBtn = document.getElementById('settings-people-search-trigger');
    var searchWrap = document.getElementById('settings-people-search-wrap');
    var searchInp = document.getElementById('settings-people-search-input');
    if (searchBtn && searchWrap) {
      searchBtn.addEventListener('click', function () {
        var hidden =
          searchWrap.style.display === 'none' ||
          (searchWrap.style.display === '' && window.getComputedStyle(searchWrap).display === 'none');
        searchWrap.style.display = hidden ? 'block' : 'none';
        var memTab = document.getElementById('settings-people-tab-members');
        if (memTab) memTab.click();
        if (hidden && searchInp) searchInp.focus();
      });
    }
    if (searchInp) {
      searchInp.addEventListener('input', function () {
        var q = (searchInp.value || '').trim().toLowerCase();
        var stBody = document.getElementById('settings-people-members-tbody');
        if (!stBody) return;
        stBody.querySelectorAll('tr').forEach(function (tr) {
          var txt = tr.textContent || '';
          tr.style.display = !q || txt.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
        });
      });
    }

    var addBtn = document.getElementById('settings-people-add-main');
    var menu = document.getElementById('settings-people-add-menu');
    if (addBtn && menu) {
      addBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var next = menu.hasAttribute('hidden');
        if (next) menu.removeAttribute('hidden');
        else menu.setAttribute('hidden', '');
        addBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
      });
      menu.querySelectorAll('.settings-people-menu-item').forEach(function (item) {
        item.addEventListener('click', function (ev) {
          ev.preventDefault();
          menu.setAttribute('hidden', '');
          addBtn.setAttribute('aria-expanded', 'false');
          goTeam();
        });
      });
      document.addEventListener('click', function (ev) {
        if (!menu.hasAttribute('hidden') && addBtn && !addBtn.contains(ev.target) && !menu.contains(ev.target)) {
          menu.setAttribute('hidden', '');
          addBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    var imp = document.getElementById('settings-people-import-contacts');
    if (imp) imp.addEventListener('click', function () { goTeam(); });

    var openFromContacts = document.getElementById('settings-people-open-team-from-contacts');
    if (openFromContacts) openFromContacts.addEventListener('click', function () { goTeam(); });
  }

  /** Click dimmed backdrop (the `.mo` root) to close any open modal without running Save actions. */
  function wireModalBackdropDismissAll() {
    if (window.__bizdashModalBackdropDismissWired) return;
    window.__bizdashModalBackdropDismissWired = true;
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains('mo') || !t.classList.contains('on')) return;
      if (t.getAttribute('data-no-backdrop-dismiss') === 'true') return;
      var id = t.id || '';
      if (id === 'quickActionsModal') {
        closeQuickActionsModal();
        return;
      }
      if (id === 'listTemplatesModal') {
        closeListTemplatesModal();
        return;
      }
      if (id === 'listPreviewModal') {
        closeListPreviewModal();
        return;
      }
      if (id === 'eml-compose-modal') {
        if (typeof window.__bizdashCloseEmlComposeModal === 'function') window.__bizdashCloseEmlComposeModal();
        return;
      }
      if (id === 'invoiceEditFullModal') {
        closeFullInvoiceEditor();
        return;
      }
      t.classList.remove('on');
      if (t.hasAttribute('aria-hidden')) {
        t.setAttribute('aria-hidden', 'true');
      }
    });
  }

  function init() {
    state.filter = { mode: 'all', start: null, end: null };
    wireTransactionForm();
    wireCsvImportAndJournalExport();
    wireIncomeExpenseForms();
    wireTimesheet();
    wireDeleteHandlers();
    wireExpensesTableSort();
    wireClientForm();
    wireInvoiceModal();
    wireInvoiceFullEditor();
    wireInvoicePreviewModal();
    wireProjectsAndStatuses();
    wireFilter();
    wireCustomersColumnsPicker();
    wireIncomePowerTable();
    wireSpendingReport();
    wireSettingsSave();
    wireSettingsShell();
    wireReferEarnSettingsUi();
    wirePeopleSettingsUi();
    wireProfileSettings();
    wireAccountSecuritySettings();
    wireGoogleOAuthInSettings();
    updateGoogleOAuthRedirectHint();
    wireStripeConnectInSettings();
    wirePersonableActions();
    wireCloudSyncPanel();
    wireMarketingCampaign();
    wireWorkflowAutomation();
    if (typeof window.wireDashboardAssistant === 'function') {
      window.wireDashboardAssistant();
    }
    wireTeamPage();
    wireWorkspaceSettingsPanel();
    wireTasksTab();
    wireEmailsPage();
    wireListsFeature();
    wireQuickActionsPalette();
    wireSidebarChrome();
    wireModalBackdropDismissAll();

    // Simple page navigation wiring to replace the original bundle's nav().
    // Exposed globally so existing onclick="nav('dashboard', this)" continues to work.
    window.nav = function (pageId, el) {
      document.body.classList.remove('mobile-nav-open');

      var appShell = document.getElementById('app-shell');
      if (appShell) appShell.classList.toggle('settings-route', pageId === 'settings');

      // Switch visible page
      var pages = document.querySelectorAll('.pg');
      pages.forEach(function (pg) {
        pg.classList.remove('on');
      });
      var target = document.getElementById('page-' + pageId);
      if (target) target.classList.add('on');
      stagePageMotion(target);
      if (pageId !== 'chat') {
        var chatPg = document.getElementById('page-chat');
        if (chatPg) {
          chatPg.classList.remove('chat-compose-docked');
          chatPg.classList.remove('chat-advisor-centered');
        }
      }
      if (pageId === 'chat') {
        if (typeof window.bizDashSyncAdvisorChatShellGreeting === 'function') {
          window.bizDashSyncAdvisorChatShellGreeting();
        }
        var didReplay = false;
        try {
          var rawReplay = sessionStorage.getItem('advisor-pending-replay');
          if (rawReplay) {
            sessionStorage.removeItem('advisor-pending-replay');
            var turns = JSON.parse(rawReplay);
            if (Array.isArray(turns) && turns.length && typeof window.replayAdvisorChatTurns === 'function') {
              didReplay = true;
              window.setTimeout(function () {
                window.replayAdvisorChatTurns(turns);
              }, 60);
            }
          }
        } catch (_) {}
        if (!didReplay && typeof window.seedDashboardChatWelcome === 'function') {
          window.seedDashboardChatWelcome();
        }
        if (typeof window.bizDashSyncAdvisorComposerLayout === 'function') {
          window.setTimeout(function () {
            window.bizDashSyncAdvisorComposerLayout();
          }, didReplay ? 140 : 0);
        }
      }

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
          tasks: 'Tasks',
          emails: 'Emails',
          revenue: 'Income',
          expenses: 'Expenses',
          timesheet: 'Timesheet',
          performance: 'Projects',
          retention: 'Retention',
          insights: 'Insights',
          marketing: 'Marketing',
          chat: 'Advisor',
          team: 'Your team',
          settings: 'Settings',
          lists: 'Lists',
        };
        mobileTitle.textContent = titles[pageId] || 'Dashboard';
      }
      if (pageId === 'team' && typeof window.refreshTeamPage === 'function') {
        window.refreshTeamPage();
      }
      if (pageId === 'lists') {
        closeListDetailView();
        renderListsSidebar();
        renderListsPageGrid();
      }
      if (pageId === 'tasks') {
        wfRefreshFromSupabase()
          .then(function () {
            return tasksTabRefreshMembers();
          })
          .then(function () {
            renderTasksPage();
          });
      }
      if (pageId === 'settings') {
        wfRefreshFromSupabase().then(function () {
          renderAutomationSettings();
        });
      }
    };

    consumeStripeSettingsReturnFromUrl();
    consumeOAuthReturnFromUrl();

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') document.body.classList.remove('mobile-nav-open');
    });

    stagePageMotion(document.querySelector('.pg.on'));

    // Load data only when session is already present (auth calls init after login from showApp).
    // Do not run while signed in but workspace id is still resolving — otherwise the first init
    // completes without org, skips remote fetch, and the user can stay on empty local state.
    if (typeof initDataFromSupabase === 'function' && window.currentUser && window.supabaseClient) {
      var demoUid = window.DEMO_DASHBOARD_USER_ID || '00000000-0000-4000-8000-000000000001';
      var isDemoUser = window.currentUser.id === demoUid;
      var orgReady =
        typeof window.bizDashGetCurrentOrgId === 'function' ? window.bizDashGetCurrentOrgId() : window.currentOrganizationId;
      if (isDemoUser || (orgReady && String(orgReady).trim())) {
        initDataFromSupabase();
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
