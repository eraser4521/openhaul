import { inflateSync } from 'node:zlib';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

/**
 * Reads back the words actually printed on a page.
 *
 * Asserting on the input to a renderer proves nothing about what a consignee
 * or a claimant ends up holding, so the tests read the content streams
 * instead.
 *
 * Two quirks of how these documents are drawn shape the reassembly. Body text
 * is emitted one wrapped line per show-text operator, so lines have to be
 * separated or the last word of one fuses to the first word of the next
 * ("within nine" + "months" reads as "ninemonths"). Letter-spaced headings are
 * emitted one glyph at a time, so those must be joined with nothing at all or
 * "CHARGES" comes back as "C H A R G E S". Run length tells them apart.
 */
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
      runs.push(Buffer.from(match[1] ?? '', 'hex').toString('latin1'));
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
