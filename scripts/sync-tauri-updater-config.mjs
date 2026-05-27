#!/usr/bin/env node
/**
 * Inject updater pubkey + production update endpoint into src-tauri/tauri.conf.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const confPath = join(root, 'src-tauri/tauri.conf.json');
const pubPath = join(root, 'src-tauri/bizdash.key.pub');

function extractMinisignPubkey(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fromLine = lines.find((l) => l.startsWith('RW'));
  if (fromLine) return fromLine;
  const match = text.match(/RW[A-Za-z0-9+/]+=*/);
  return match ? match[0] : '';
}

function readPubkey() {
  const fromEnv = process.env.TAURI_UPDATER_PUBKEY?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(pubPath)) return '';
  const raw = readFileSync(pubPath, 'utf8').trim();
  const plain = extractMinisignPubkey(raw);
  if (plain) return plain;
  try {
    return extractMinisignPubkey(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return '';
  }
}

function readAppOrigin() {
  const fromEnv =
    process.env.VITE_APP_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    process.env.TAURI_UPDATER_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return 'https://app.example.com';
}

const conf = JSON.parse(readFileSync(confPath, 'utf8'));
const pubkey = readPubkey();
const origin = readAppOrigin();

if (!conf.plugins) conf.plugins = {};
if (!conf.plugins.updater) conf.plugins.updater = {};
conf.plugins.updater.pubkey = pubkey;
conf.plugins.updater.endpoints = [`${origin}/updates/latest.json`];

writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');
console.log(`[sync-tauri-updater-config] pubkey=${pubkey ? 'set' : 'MISSING'} endpoint=${origin}/updates/latest.json`);
