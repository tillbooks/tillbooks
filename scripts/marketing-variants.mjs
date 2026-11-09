#!/usr/bin/env node
/**
 * marketing-variants.mjs: the pre-cropped, sized product shots the home page ships (UX critic m1).
 *
 *   npm run shots:variants          # after npm run shots:marketing, or after a crop changed
 *
 * The captures in web/public/product/ are whole 2x Studio screens (scripts/marketing-screenshots.mjs),
 * each in a desk frame and a phone frame. The page shows a CROP of one, so shipping the whole file sent
 * a phone about 150 KB per shot of which it drew a fraction. This script cuts every crop named in
 * web/src/components/home/shots.mjs out of its capture (the desk crop from the desk frame, the phone
 * crop from the phone frame), per page locale and theme, at 2x and at 1x the crop's CSS width, and
 * writes them to web/public/product/crops/ with an index.json naming the crop and the frame each file
 * was cut from (the home-page test compares that index with shots.mjs, so a changed crop without a
 * re-run fails).
 *
 * Cropping, scaling and the WebP encode run in Chromium's own canvas (the Playwright copy
 * `.claude/ui-tests` installs), the same way the capture script encodes: no image library is added.
 * A file no longer named by shots.mjs is removed, so the folder never carries a stale shot.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT = join(ROOT, 'web', 'public', 'product');
const OUT = join(PRODUCT, 'crops');
const UI_TESTS = join(ROOT, '.claude', 'ui-tests');
const QUALITY = 0.84;

const { ALL_SHOTS, SHOT_PREFIXES, SHOT_THEMES, variantsOf, variantFile } = await import(
  pathToFileURL(join(ROOT, 'web', 'src', 'components', 'home', 'shots.mjs')).href
);
const manifest = JSON.parse(readFileSync(join(PRODUCT, 'manifest.json'), 'utf8'));
const scale = manifest.deviceScaleFactor;
/** The desk crop is cut from the desk frame, the phone crop from the phone frame. */
const frameOf = (kind) =>
  kind === 'm'
    ? { size: manifest.phoneViewport, suffix: '-phone' }
    : { size: manifest.viewport, suffix: '' };

const require = createRequire(join(UI_TESTS, 'package.json'));
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  throw new Error(`playwright not found under ${UI_TESTS}: run \`npm install\` there (or symlink its node_modules)`);
}

const log = (...m) => console.log('[variants]', ...m);

/** Cut, scale and encode one variant in the page's canvas. */
async function render(page, sourceB64, crop, width) {
  const res = await page.evaluate(
    async ({ b64, crop, width, scale, q }) => {
      const img = new Image();
      img.src = `data:image/webp;base64,${b64}`;
      await img.decode();
      const height = Math.round((crop.h / crop.w) * width);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale, 0, 0, width, height);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', q));
      if (!blob || blob.type !== 'image/webp') throw new Error('this Chromium cannot encode WebP');
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { height, b64: btoa(bin) };
    },
    { b64: sourceB64, crop, width, scale, q: QUALITY },
  );
  return { height: res.height, bytes: Buffer.from(res.b64, 'base64') };
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const written = new Map();
let total = 0;
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>variants</title>');
  for (const shot of ALL_SHOTS) {
    for (const { kind, crop, widths } of variantsOf(shot)) {
      const { size, suffix } = frameOf(kind);
      if (crop.x < 0 || crop.y < 0 || crop.x + crop.w > size.width || crop.y + crop.h > size.height) {
        throw new Error(`${shot.id} ${kind}: the crop leaves the ${size.width} x ${size.height} frame`);
      }
      for (const prefix of SHOT_PREFIXES) {
        for (const theme of SHOT_THEMES) {
          const source = `${shot.surface}-${prefix}-${theme}${suffix}.webp`;
          if (!existsSync(join(PRODUCT, source))) throw new Error(`no capture ${source}: run npm run shots:marketing`);
          const b64 = readFileSync(join(PRODUCT, source)).toString('base64');
          for (const width of widths) {
            const file = variantFile(shot.id, kind, prefix, theme, width);
            const { height, bytes } = await render(page, b64, crop, width);
            writeFileSync(join(OUT, file), bytes);
            written.set(file, { shot: shot.id, kind, prefix, theme, source, crop, width, height, bytes: bytes.length });
            total += bytes.length;
          }
        }
      }
      log(`${shot.id} ${kind} ${crop.w}x${crop.h}`);
    }
  }
} finally {
  await browser.close();
}

for (const file of readdirSync(OUT)) {
  if (file.endsWith('.webp') && !written.has(file)) {
    rmSync(join(OUT, file));
    log(`removed stale ${file}`);
  }
}
const index = {
  about:
    'Pre-cropped product shots for the home page, cut from the captures in ../ by scripts/marketing-variants.mjs from the crops in web/src/components/home/shots.mjs. Do not edit by hand: re-run npm run shots:variants.',
  viewport: manifest.viewport,
  phoneViewport: manifest.phoneViewport,
  deviceScaleFactor: scale,
  files: Object.fromEntries([...written.entries()].sort(([a], [b]) => a.localeCompare(b))),
};
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
log(`wrote ${written.size} files, ${(total / 1024).toFixed(0)} KB in all`);
