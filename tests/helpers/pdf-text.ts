import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

/**
 * Reads back the words actually printed on a page.
 *
 * Asserting on the input to a renderer proves nothing about what a consignee
 * or a claimant ends up holding, so the tests read the content streams
 * instead.
 *
 * Text is decoded from WinAnsi, which is what the standard PDF fonts use.
 * Its 0x80-0x9F range holds the typographic punctuation these documents are
 * full of — em dashes, curly apostrophes — where Latin-1 has control codes, so
 * decoding as Latin-1 turns "Sep 1 — Sep 14" into a string no assertion can
 * match and quietly hides whether the dash was ever drawn.
 *
 * Two further quirks of how these documents are drawn shape the reassembly. Body text
 * is emitted one wrapped line per show-text operator, so lines have to be
 * separated or the last word of one fuses to the first word of the next
 * ("within nine" + "months" reads as "ninemonths"). Letter-spaced headings are
 * emitted one glyph at a time, so those must be joined with nothing at all or
 * "CHARGES" comes back as "C H A R G E S". Run length tells them apart.
 */
/** The WinAnsi codepoints that differ from Latin-1, which is all of 0x80-0x9F. */
const WINANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…',
  0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’',
  0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ',
  0x9e: 'ž', 0x9f: 'Ÿ',
};

function decodeWinAnsi(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) {
    out += WINANSI_HIGH[byte] ?? String.fromCharCode(byte);
  }
  return out;
}

export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const runs: string[] = [];

  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;

    const filter = object.dict.get(PDFName.of('Filter'));
    if (!filter || !String(filter).includes('FlateDecode')) continue;

    let decoded: Buffer;
    try {
      decoded = inflateSync(Buffer.from(object.contents));
    } catch {
      continue;
    }

    const stream = decoded.toString('latin1');
    if (!stream.includes('Tj')) continue;

    for (const match of stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      runs.push(decodeWinAnsi(Buffer.from(match[1] ?? '', 'hex')));
    }
  }

  let text = '';
  let previous = '';

  for (const run of runs) {
    if (text !== '' && previous.length > 1 && run.length > 1) text += ' ';
    text += run;
    previous = run;
  }

  return text;
}

export async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

export function isPdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-';
}
