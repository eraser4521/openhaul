/**
 * Rasterises the OpenHaul mark into the PWA icon set.
 *
 * Run with `node scripts/generate-icons.mjs`. Committed output lives in
 * public/icons so a clean checkout does not need sharp to build.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const OUT = path.join(process.cwd(), 'public', 'icons');

const BRAND = '#f0a12e';
const ACCENT = '#3fb6c9';
const CONTRAST = '#1a1206';

/**
 * @param {object} options
 * @param {boolean} options.maskable Pads the mark into the 80% safe zone that
 *   Android's adaptive icon mask requires, and fills the full bleed area.
 */
function markSvg({ maskable = false } = {}) {
  // A maskable icon may be cropped to a circle, so the artwork is scaled down
  // and centred inside a full-bleed background.
  const scale = maskable ? 0.62 : 1;
  const offset = (32 - 32 * scale) / 2;
  const radius = maskable ? 0 : 8;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <defs>
    <linearGradient id="g" x1="2" y1="28" x2="30" y2="4" gradientUnits="userSpaceOnUse">
      <stop stop-color="${BRAND}"/>
      <stop offset="1" stop-color="${ACCENT}"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="${radius}" fill="url(#g)"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})" opacity="0.92">
    <path d="M6 13.5 L14 9 L26 9" stroke="${CONTRAST}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M6 22 L20 22 L26 18" stroke="${CONTRAST}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <circle cx="10.5" cy="25.5" r="1.9" fill="${CONTRAST}"/>
    <circle cx="21" cy="25.5" r="1.9" fill="${CONTRAST}"/>
  </g>
</svg>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
];

await mkdir(OUT, { recursive: true });

for (const target of TARGETS) {
  const svg = Buffer.from(markSvg({ maskable: target.maskable }));
  await sharp(svg, { density: 640 })
    .resize(target.size, target.size, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, target.file));
  console.log(`wrote icons/${target.file} (${target.size}px)`);
}

// Keep a vector copy for the browser tab; it stays crisp and themes cleanly.
await writeFile(path.join(process.cwd(), 'public', 'icon.svg'), markSvg(), 'utf8');
console.log('wrote icon.svg');

// favicon.ico equivalent: modern browsers accept a PNG at /favicon.ico.
await sharp(Buffer.from(markSvg()), { density: 640 })
  .resize(48, 48)
  .png({ compressionLevel: 9 })
  .toFile(path.join(process.cwd(), 'public', 'favicon.ico'));
console.log('wrote favicon.ico');
