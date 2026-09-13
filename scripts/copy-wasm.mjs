/**
 * Copies the ZXing reader WASM into public/ so the barcode scanner is served
 * from our own origin.
 *
 * Without this the decoder is fetched from a CDN at runtime, which breaks
 * scanning offline — the single most important thing the driver app has to do
 * in a yard with no signal — and adds a third-party runtime dependency the
 * Content Security Policy would have to allow.
 */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const source = path.join(
  process.cwd(),
  'node_modules',
  'zxing-wasm',
  'dist',
  'reader',
  'zxing_reader.wasm',
);
const targetDir = path.join(process.cwd(), 'public', 'wasm');

try {
  await mkdir(targetDir, { recursive: true });
  await copyFile(source, path.join(targetDir, 'zxing_reader.wasm'));
  console.log('Copied zxing_reader.wasm into public/wasm/');
} catch (error) {
  // A missing dependency during a partial install must not fail the install.
  console.warn(`Could not copy the barcode decoder WASM: ${error.message}`);
}
