#!/usr/bin/env node
/**
 * Dynamic tenant-isolation probes (anon key + user JWT only).
 * Prerequisites: two Auth users in two different organizations; migrations applied.
 *
 * Usage: npm run test:tenant-isolation
 * See docs/TENANT_ISOLATION_TEST_RUNBOOK.md
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnvFile() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnvFile();

/**
 * Defaults from vite.config.mjs (linked IDM Dashboard, anon key is public).
 * Override per-project by setting VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
 * (or SUPABASE_URL / SUPABASE_ANON_KEY) in .env.
 */
const DEFAULT_SUPABASE_URL = 'https://ausivxesedagohjlthiy.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF1c2l2eGVzZWRhZ29oamx0aGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUwNTU3MTEsImV4cCI6MjA5MDYzMTcxMX0.H5PRdJVXCq8_9CbB12F6xFzy0ljqz1-aiVZmguErLxk';

const supabaseUrl =
  process.env.SUPABASE_URL?.trim() ||
  process.env.VITE_SUPABASE_URL?.trim() ||
  DEFAULT_SUPABASE_URL;
const anonKey =
  process.env.SUPABASE_ANON_KEY?.trim() ||
  process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  DEFAULT_SUPABASE_ANON_KEY;
const usingDefaults =
  !process.env.SUPABASE_URL?.trim() &&
  !process.env.VITE_SUPABASE_URL?.trim();

const userAEmail = process.env.TENANT_TEST_USER_A_EMAIL?.trim() || '';
const userAPassword = process.env.TENANT_TEST_USER_A_PASSWORD?.trim() || '';
const userBEmail = process.env.TENANT_TEST_USER_B_EMAIL?.trim() || '';
const userBPassword = process.env.TENANT_TEST_USER_B_PASSWORD?.trim() || '';
let orgAId = process.env.TENANT_TEST_ORG_A_ID?.trim() || '';
let orgBId = process.env.TENANT_TEST_ORG_B_ID?.trim() || '';

const edgeBase =
  process.env.TENANT_TEST_EDGE_URL?.trim() ||
  (supabaseUrl ? `${supabaseUrl.replace(/\/$/, '')}/functions/v1` : '');

const results = [];
let failCount = 0;
let skipCount = 0;

function pass(id, detail = '') {
  results.push({ id, status: 'PASS', detail });
  console.log(`PASS  ${id}${detail ? ` — ${detail}` : ''}`);
}

function fail(id, detail = '') {
  results.push({ id, status: 'FAIL', detail });
  console.error(`FAIL  ${id}${detail ? ` — ${detail}` : ''}`);
  failCount += 1;
}

function skip(id, detail = '') {
  results.push({ id, status: 'SKIP', detail });
  console.log(`SKIP  ${id}${detail ? ` — ${detail}` : ''}`);
  skipCount += 1;
}

function assert(condition, id, detail) {
  if (condition) pass(id, detail);
  else fail(id, detail);
}

async function signIn(email, password) {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    throw new Error(error?.message || 'sign-in failed');
  }
  return {
    client: createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    userId: data.user.id,
    accessToken: data.session.access_token,
  };
}

async function resolveOrgId(userClient, userId, preferred) {
  if (preferred) return preferred;
  const { data, error } = await userClient.rpc('my_organizations');
  if (error) throw new Error(`my_organizations: ${error.message}`);
  const rows = Array.isArray(data) ? data : [];
  const owned = rows.find((r) => r.role === 'owner') || rows[0];
  if (!owned?.id) throw new Error('no organization membership');
  return String(owned.id);
}

async function probeTableIsolation(table, orgA, orgB, clientA, clientB, seedFn) {
  const tag = table;
  const seed = await seedFn(clientA, orgA);
  if (!seed?.id) {
    fail(`${tag}.seed`, 'could not create seed row in OrgA');
    return;
  }
  pass(`${tag}.seed`, `id=${seed.id}`);

  const { data: crossSelect, error: selErr } = await clientB
    .from(table)
    .select('id')
    .eq('organization_id', orgA)
    .eq('id', seed.id);
  if (selErr) {
    fail(`${tag}.crossSelect`, selErr.message);
  } else {
    assert(
      !crossSelect?.length,
      `${tag}.crossSelect`,
      crossSelect?.length ? `leaked ${crossSelect.length} row(s)` : '0 rows',
    );
  }

  const crossInsertBody = seed.crossInsertBody(orgB);
  const { data: insData, error: insErr } = await clientB.from(table).insert(crossInsertBody).select('id');
  const insertBlocked =
    !!insErr ||
    !insData?.length ||
    (insData[0]?.organization_id && insData[0].organization_id !== orgB);
  assert(
    insertBlocked,
    `${tag}.crossInsert`,
    insErr ? insErr.message : insData?.length ? 'row inserted into wrong org' : 'blocked',
  );

  const { data: updData, error: updErr } = await clientB
    .from(table)
    .update(seed.updatePatch || { company_name: 'pwned-by-B' })
    .eq('id', seed.id)
    .select('id');
  const updateBlocked = !!updErr || !updData?.length;
  assert(
    updateBlocked,
    `${tag}.crossUpdate`,
    updErr ? updErr.message : updData?.length ? 'updated foreign row' : '0 rows updated',
  );

  const { data: delData, error: delErr } = await clientB
    .from(table)
    .delete()
    .eq('id', seed.id)
    .select('id');
  const deleteBlocked = !!delErr || !delData?.length;
  assert(
    deleteBlocked,
    `${tag}.crossDelete`,
    delErr ? delErr.message : delData?.length ? 'deleted foreign row' : '0 rows deleted',
  );

  if (seed.cleanup) await seed.cleanup(clientA);
}

function grepDistForSecrets() {
  const distDir = join(ROOT, 'dist');
  if (!existsSync(distDir)) {
    skip('bundle.noServiceRole', 'dist/ missing — run npm run build first');
    return;
  }
  const needles = ['service_role', 'SUPABASE_SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE_KEY'];
  const hits = [];

  function walk(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (/\.(js|css|html|map)$/i.test(name.name)) {
        try {
          const text = readFileSync(p, 'utf8');
          for (const n of needles) {
            if (text.includes(n)) hits.push(`${p}:${n}`);
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(distDir);
  assert(!hits.length, 'bundle.noServiceRole', hits.length ? hits.slice(0, 3).join('; ') : 'clean');
}

async function main() {
  console.log('Tenant isolation dynamic test\n');
  console.log(`Target: ${supabaseUrl}${usingDefaults ? '  (defaults from vite.config.mjs)' : ''}\n`);

  const missing = [];
  if (!userAEmail) missing.push('TENANT_TEST_USER_A_EMAIL');
  if (!userAPassword) missing.push('TENANT_TEST_USER_A_PASSWORD');
  if (!userBEmail) missing.push('TENANT_TEST_USER_B_EMAIL');
  if (!userBPassword) missing.push('TENANT_TEST_USER_B_PASSWORD');
  if (missing.length) {
    console.error('Missing required env vars in .env:');
    for (const k of missing) console.error(`  - ${k}`);
    console.error('\nNext steps:');
    console.error('  1. Create two test users in Supabase Auth (Dashboard > Authentication > Users).');
    console.error('  2. Make each user the owner of a different organization (sign up through');
    console.error('     the dashboard at /signup, or insert into organizations + organization_members).');
    console.error('  3. Add the four TENANT_TEST_* vars to .env (see .env.example).');
    console.error('  4. Re-run: npm run test:tenant-isolation');
    console.error('\nSee docs/TENANT_ISOLATION_TEST_RUNBOOK.md for the full runbook.');
    process.exit(2);
  }

  let sessionA;
  let sessionB;
  try {
    sessionA = await signIn(userAEmail, userAPassword);
    sessionB = await signIn(userBEmail, userBPassword);
    pass('auth.signIn', 'both users authenticated');
  } catch (e) {
    fail('auth.signIn', e.message);
    printSummary();
    process.exit(1);
  }

  try {
    orgAId = await resolveOrgId(sessionA.client, sessionA.userId, orgAId);
    orgBId = await resolveOrgId(sessionB.client, sessionB.userId, orgBId);
    pass('auth.resolveOrgs', `OrgA=${orgAId.slice(0, 8)}… OrgB=${orgBId.slice(0, 8)}…`);
  } catch (e) {
    fail('auth.resolveOrgs', e.message);
    printSummary();
    process.exit(1);
  }

  if (orgAId === orgBId) {
    fail('auth.distinctOrgs', 'User A and B resolved to the same organization_id');
    printSummary();
    process.exit(1);
  }
  pass('auth.distinctOrgs');

  await probeTableIsolation(
    'clients',
    orgAId,
    orgBId,
    sessionA.client,
    sessionB.client,
    async (client, orgId) => {
      const id = randomUUID();
      const { data, error } = await client
        .from('clients')
        .insert({
          id,
          user_id: sessionA.userId,
          organization_id: orgId,
          company_name: `tenant-test-${Date.now()}`,
          contact_name: 'Isolation Test',
        })
        .select('id')
        .single();
      if (error) return null;
      return {
        id: data.id,
        crossInsertBody: (orgB) => ({
          id: randomUUID(),
          user_id: sessionB.userId,
          organization_id: orgAId,
          company_name: 'cross-org-insert',
        }),
        updatePatch: { company_name: 'pwned-by-B' },
        cleanup: async (c) => {
          await c.from('clients').delete().eq('id', id);
        },
      };
    },
  );

  await probeTableIsolation(
    'transactions',
    orgAId,
    orgBId,
    sessionA.client,
    sessionB.client,
    async (client, orgId) => {
      const id = randomUUID();
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await client
        .from('transactions')
        .insert({
          id,
          user_id: sessionA.userId,
          organization_id: orgId,
          date: today,
          category: 'svc',
          amount: 1,
          description: 'tenant-isolation-test',
        })
        .select('id')
        .single();
      if (error) return null;
      return {
        id: data.id,
        crossInsertBody: () => ({
          id: randomUUID(),
          user_id: sessionB.userId,
          organization_id: orgAId,
          date: today,
          category: 'svc',
          amount: 2,
          description: 'cross-org',
        }),
        updatePatch: { description: 'pwned-by-B' },
        cleanup: async (c) => {
          await c.from('transactions').delete().eq('id', id);
        },
      };
    },
  );

  await probeTableIsolation(
    'workspace_lists',
    orgAId,
    orgBId,
    sessionA.client,
    sessionB.client,
    async (client, orgId) => {
      const listId = randomUUID();
      const { data, error } = await client
        .from('workspace_lists')
        .insert({
          organization_id: orgId,
          list_id: listId,
          title: 'tenant-isolation-test',
          payload: { id: listId, title: 'tenant-isolation-test', rows: [], columns: [] },
        })
        .select('id, list_id')
        .single();
      if (error) return null;
      const rowPk = data.id;
      return {
        id: rowPk,
        crossInsertBody: () => ({
          organization_id: orgAId,
          list_id: randomUUID(),
          title: 'cross-org-list',
          payload: {},
        }),
        updatePatch: { title: 'pwned-by-B' },
        cleanup: async (c) => {
          await c.from('workspace_lists').delete().eq('id', rowPk);
        },
      };
    },
  );

  await probeTableIsolation(
    'meeting_notes',
    orgAId,
    orgBId,
    sessionA.client,
    sessionB.client,
    async (client, orgId) => {
      const { data, error } = await client
        .from('meeting_notes')
        .insert({
          organization_id: orgId,
          title: `tenant-test-mn-${Date.now()}`,
        })
        .select('id')
        .single();
      if (error) return null;
      return {
        id: data.id,
        crossInsertBody: () => ({
          organization_id: orgAId,
          title: 'cross-org-meeting',
        }),
        updatePatch: { title: 'pwned-by-B' },
        cleanup: async (c) => {
          await c.from('meeting_notes').delete().eq('id', data.id);
        },
      };
    },
  );

  let clientAId = null;
  const clientSeed = await sessionA.client
    .from('clients')
    .insert({
      id: randomUUID(),
      user_id: sessionA.userId,
      organization_id: orgAId,
      company_name: `tenant-test-mn-${Date.now()}`,
    })
    .select('id')
    .single();
  if (clientSeed.error) {
    fail('meeting_notes.seedClient', clientSeed.error.message);
  } else {
    clientAId = clientSeed.data.id;
    const { error: mnErr } = await sessionB.from('meeting_notes').insert({
      organization_id: orgBId,
      contact_id: clientAId,
      title: 'cross-org fk test',
    });
    assert(
      !!mnErr,
      'meeting_notes.crossOrgFk',
      mnErr ? mnErr.message : 'insert succeeded (should be blocked)',
    );
    await sessionA.client.from('clients').delete().eq('id', clientAId);
  }

  const { data: icData, error: icErr } = await sessionB
    .from('integration_credentials')
    .select('id')
    .limit(5);
  if (icErr) {
    pass('integration_credentials.noLeak', `query error (no data leak): ${icErr.code || icErr.message}`);
  } else {
    assert(
      !icData?.length,
      'integration_credentials.empty',
      icData?.length ? `leaked ${icData.length} row(s)` : '0 rows',
    );
  }

  if (edgeBase) {
    try {
      const res = await fetch(`${edgeBase}/gmail-send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionA.accessToken}`,
          'Content-Type': 'application/json',
          apikey: anonKey,
        },
        body: JSON.stringify({
          organization_id: orgBId,
          to: 'test@example.com',
          subject: 'tenant isolation probe',
          body: 'should be denied',
        }),
      });
      assert(
        res.status === 403,
        'edge.gmailSendOrgSpoof',
        `status ${res.status}`,
      );
    } catch (e) {
      skip('edge.gmailSendOrgSpoof', e.message || 'fetch failed — is gmail-send deployed?');
    }
  } else {
    skip('edge.gmailSendOrgSpoof', 'no edge URL');
  }

  skip('viewer.writeDenied', 'manual: invite B to OrgA as viewer, then re-run UPDATE probe');

  grepDistForSecrets();

  printSummary();
  process.exit(failCount > 0 ? 1 : 0);
}

function printSummary() {
  console.log('\n--- Summary ---');
  const passN = results.filter((r) => r.status === 'PASS').length;
  const failN = results.filter((r) => r.status === 'FAIL').length;
  const skipN = results.filter((r) => r.status === 'SKIP').length;
  console.log(`PASS: ${passN}  FAIL: ${failN}  SKIP: ${skipN}`);
  if (failN > 0) {
    console.log('\nFailed:');
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      console.log(`  - ${r.id}: ${r.detail}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
