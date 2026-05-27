#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pkgVersion = pkg.version || '0.0.0';
const buildId = process.env.BUILD_ID || process.env.GITHUB_SHA?.slice(0, 7) || 'local';
const version = `${pkgVersion}+${buildId}`.replace(/[^a-zA-Z0-9+._-]/g, '-');

const template = readFileSync(join(root, 'scripts/sw.template.js'), 'utf8');
const output = template.replaceAll('__BUILD_VERSION__', version);
writeFileSync(join(root, 'public/sw.js'), output, 'utf8');
console.log(`[generate-sw] wrote public/sw.js (${version})`);
