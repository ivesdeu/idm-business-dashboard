#!/usr/bin/env node
/**
 * Build square PWA / touch icons from public/idm-logo.png → public/icons/*
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'public/idm-logo.png');
const iconsDir = join(root, 'public/icons');
const masterOut = join(root, 'public/icon-master.png');

const sizes = [
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  { name: 'maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-180.png', size: 180 },
];

async function main() {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('[generate-icons] sharp not installed; run npm install');
    process.exit(0);
  }

  if (!existsSync(source)) {
    console.warn('[generate-icons] missing', source);
    process.exit(0);
  }

  mkdirSync(iconsDir, { recursive: true });

  const square = await sharp(source)
    .resize(1024, 1024, {
      fit: 'contain',
      background: { r: 10, g: 10, b: 10, alpha: 1 },
    })
    .png()
    .toBuffer();

  await sharp(square).toFile(masterOut);

  for (const spec of sizes) {
    let pipeline = sharp(square).resize(spec.size, spec.size);
    if (spec.maskable) {
      pipeline = pipeline.extend({
        top: Math.round(spec.size * 0.05),
        bottom: Math.round(spec.size * 0.05),
        left: Math.round(spec.size * 0.05),
        right: Math.round(spec.size * 0.05),
        background: { r: 10, g: 10, b: 10, alpha: 1 },
      });
    }
    await pipeline.png().toFile(join(iconsDir, spec.name));
  }

  console.log('[generate-icons] wrote public/icon-master.png and public/icons/*');
}

main().catch((err) => {
  console.error('[generate-icons] failed', err);
  process.exit(1);
});
