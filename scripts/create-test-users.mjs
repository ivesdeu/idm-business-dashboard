/**
 * Creates two confirmed users for local/testing login.
 * Requires SUPABASE_SERVICE_ROLE_KEY in .env (Dashboard → Settings → API → service_role — never expose in client code or commit).
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnv() {
  const p = join(root, '.env');
  if (!existsSync(p)) {
    console.error('Missing .env in project root.');
    process.exit(1);
  }
  const raw = readFileSync(p, 'utf8');
  const out = {};
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const env = loadEnv();
const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRole) {
  console.error(
    'Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.\n' +
      'Get the service role key from Supabase → Project Settings → API (service_role — secret).'
  );
  process.exit(1);
}

const supabase = createClient(url, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const USERS = [
  { email: 'dashboard.user1@example.com', password: 'IdmDash2026!User1' },
  { email: 'dashboard.user2@example.com', password: 'IdmDash2026!User2' },
];

for (const { email, password } of USERS) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    if (error.message?.includes('already been registered') || error.code === 'email_exists') {
      console.log(`Skip (exists): ${email}`);
    } else {
      console.error(`Failed ${email}:`, error.message);
      process.exit(1);
    }
  } else {
    console.log(`Created: ${email} (id: ${data.user?.id})`);
  }
}

console.log('\nYou can sign in at the dashboard gate with:');
for (const { email, password } of USERS) {
  console.log(`  ${email} / ${password}`);
}
