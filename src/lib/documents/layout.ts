import 'server-only';
import {
  PDFDocument,
  PDFFont,
  PDFPage,
  rgb,
  StandardFonts,
  type RGB,
} from 'pdf-lib';

/**
 * A small cursor-based layout helper over pdf-lib.
 *
 * pdf-lib positions everything absolutely, which is unworkable for a document
 * whose length depends on how many vehicles are on the load and how much
 * damage was found. This wraps it in a downward-flowing cursor with automatic
 * page breaks, so the document code reads as a sequence of sections.
 *
 * Deliberately not a browser-rendered PDF. Driving headless Chromium would
 * mean a self-hoster needs 400 MB of browser on a machine whose entire job is
 * printing a bill of lading. The standard PDF fonts also mean no font files
 * to ship or licence.
 */

/** US Letter, in points. Legal documents in this industry are not A4. */
export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
export const MARGIN = 36;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const FOOTER_HEIGHT = 28;

export const INK = rgb(0.08, 0.08, 0.1);
export const MUTED = rgb(0.42, 0.42, 0.46);
export const HAIRLINE = rgb(0.78, 0.78, 0.82);
export const PANEL = rgb(0.96, 0.96, 0.97);
export const WARNING = rgb(0.62, 0.24, 0.06);

export interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

/**
 * The carrier's own layer of a document, resolved from their template.
 *
 * Deliberately narrow. Everything here sits around the document — above the
 * masthead, in the rules, at the foot of the page, after the fixed terms.
 * Nothing in it can remove or rewrite regulatory content, because a bill of
 * lading whose terms the user can edit is not a bill of lading. Passing a
 * brand through changes how a document looks; it never changes what it says.
 */
export interface DocumentBrand {
  /** Printed above the masthead. Null prints no name, which a logo already carries. */
  name: string | null;
  tagline: string | null;
  logo: {
    bytes: Uint8Array;
    contentType: string;
    width: number;
    height: number;
  } | null;
  /** Used as given for rules and bars. */
  accent: RGB | null;
  /** The same colour darkened far enough to survive a photocopier. */
  accentText: RGB | null;
  footerNote: string | null;
  /** Extra terms, printed after the fixed ones under the carrier's own name. */
  addendum: string | null;
  remitToText: string | null;
}

export interface DocBuilderOptions {
  /** Rendered bottom-left of every page, beside the page number. */
  footerNote?: string;
  /** Document metadata. Defaults to the current time if omitted. */
  title?: string;
  issuedAt?: Date;
  brand?: DocumentBrand | null;
}

/** Widest and tallest a logo may print. Wider than this and it reads as a banner. */
const LOGO_MAX_WIDTH = 168;
const LOGO_MAX_HEIGHT = 44;

export class DocBuilder {
  private page!: PDFPage;
  private cursor = 0;
  private pages: PDFPage[] = [];

  private constructor(
    readonly pdf: PDFDocument,
    readonly fonts: Fonts,
    private readonly options: DocBuilderOptions,
  ) {}

  static async create(options: DocBuilderOptions = {}): Promise<DocBuilder> {
    const pdf = await PDFDocument.create();

    const [regular, bold, mono] = await Promise.all([
      pdf.embedFont(StandardFonts.Helvetica),
      pdf.embedFont(StandardFonts.HelveticaBold),
      // A VIN is read character by character off a plate. Proportional digits
      // make transcription errors easy; a monospace face does not.
      pdf.embedFont(StandardFonts.Courier),
    ]);

    /*
     * Metadata is set explicitly so the output is a pure function of the
     * input. pdf-lib otherwise stamps the wall-clock time, which would mean
     * two renders of the same record produce different bytes and different
     * hashes — and it is the issue date that belongs here anyway, not the
     * moment the bytes were written.
     */
    const issuedAt = options.issuedAt ?? new Date(0);
    pdf.setCreationDate(issuedAt);
    pdf.setModificationDate(issuedAt);
    pdf.setCreator('OpenHaul');
    if (options.title) pdf.setTitle(options.title);

    const builder = new DocBuilder(pdf, { regular, bold, mono }, options);
    builder.addPage();
    return builder;
  }

  private addPage(): void {
    this.page = this.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.cursor = PAGE_HEIGHT - MARGIN;
    this.currentFont = null;
  }

  /**
   * The font last set on the page being drawn.
   *
   * pdf-lib mints a fresh font resource entry for every drawText call that
   * names a font, even when it is the same font as the call before. A document
   * of any length then carries hundreds of dictionary entries pointing at the
   * same three faces. Setting the font on the page and drawing without the
   * option reuses one entry per face per page.
   */
  private currentFont: PDFFont | null = null;

  /** Draws one run of text in the given font, reusing the page's font entry. */
  private draw(
    text: string,
    options: { x: number; y: number; size: number; font: PDFFont; color: RGB },
    page: PDFPage = this.page,
  ): void {
    if (page === this.page) {
      if (this.currentFont !== options.font) {
        this.page.setFont(options.font);
        this.currentFont = options.font;
      }
      this.page.drawText(text, {
        x: options.x,
        y: options.y,
        size: options.size,
        color: options.color,
      });
      return;
    }

    // A page other than the one being built — the footer pass. It sets its own
    // font, so the cached key for the current page stays correct.
    page.drawText(text, options);
  }

  /** Remaining vertical space above the footer. */
  get available(): number {
    return this.cursor - MARGIN - FOOTER_HEIGHT;
  }

  get y(): number {
    return this.cursor;
  }

  /** The carrier's colour for rules and bars, or ink when they have not set one. */
  get accent(): RGB {
    return this.options.brand?.accent ?? INK;
  }

  /**
   * The carrier's colour for text.
   *
   * Already darkened to clear 4.5:1 against white by the time it arrives here,
   * so a pale brand colour prints as a readable version of itself rather than
   * as a blank line on the fax a broker actually files.
   */
  get accentText(): RGB {
    return this.options.brand?.accentText ?? INK;
  }

  /** Starts a new page when `needed` points will not fit. */
  ensure(needed: number): void {
    if (this.available < needed) this.addPage();
  }

  move(points: number): void {
    this.cursor -= points;
  }

  /**
   * Puts the cursor back where it was.
   *
   * Used to draw a second thing on the same line as the first — a right
   * aligned amount beside its label, say — without a second layout pass.
   */
  moveTo(y: number): void {
    this.cursor = y;
  }

  /** A filled rectangle anywhere on the page, unlike `panel`'s full width. */
  fill(box: { x: number; y: number; width: number; height: number }, color = PANEL): void {
    this.page.drawRectangle({ ...box, color });
  }

  /** Splits text to fit a width, respecting explicit newlines. */
  wrap(text: string, size: number, width: number, font = this.fonts.regular): string[] {
    const lines: string[] = [];

    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line.length === 0 ? word : `${line} ${word}`;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line.length > 0) lines.push(line);
        line = word;
      }
      lines.push(line);
    }

    return lines;
  }


  /**
   * Draws text with letter spacing.
   *
   * pdf-lib has no characterSpacing option, so each glyph is placed
   * individually. Only used for short all-caps labels, where tracking is what
   * makes them read as section markers rather than shouted body text.
   */
  private drawTracked(
    value: string,
    options: { x: number; y: number; size: number; font: PDFFont; color: RGB; tracking: number },
  ): void {
    let x = options.x;
    for (const character of value) {
      this.draw(character, {
        x,
        y: options.y,
        size: options.size,
        font: options.font,
        color: options.color,
      });
      x += options.font.widthOfTextAtSize(character, options.size) + options.tracking;
    }
  }

  text(
    value: string,
    options: {
      size?: number;
      font?: PDFFont;
      color?: RGB;
      x?: number;
      width?: number;
      lineHeight?: number;
      align?: 'left' | 'right' | 'center';
    } = {},
  ): void {
    const size = options.size ?? 9;
    const font = options.font ?? this.fonts.regular;
    const color = options.color ?? INK;
    const x = options.x ?? MARGIN;
    const width = options.width ?? CONTENT_WIDTH;
    const lineHeight = options.lineHeight ?? size * 1.35;

    for (const line of this.wrap(value, size, width, font)) {
      this.ensure(lineHeight);

      let drawX = x;
      if (options.align === 'right') {
        drawX = x + width - font.widthOfTextAtSize(line, size);
      } else if (options.align === 'center') {
        drawX = x + (width - font.widthOfTextAtSize(line, size)) / 2;
      }

      this.draw(line, { x: drawX, y: this.cursor - size, size, font, color });
      this.cursor -= lineHeight;
    }
  }

  /** Section heading with a rule beneath it. */
  heading(label: string, options: { size?: number } = {}): void {
    const size = options.size ?? 8;
    this.ensure(size + 14);
    this.move(6);

    this.drawTracked(label.toUpperCase(), {
      x: MARGIN,
      y: this.cursor - size,
      size,
      font: this.fonts.bold,
      color: MUTED,
      tracking: 0.8,
    });

    this.cursor -= size + 4;
    this.rule();
    this.move(5);
  }

  /**
   * The carrier's letterhead, above the masthead of the first page.
   *
   * A no-op when nothing is configured, so a carrier who has never opened the
   * template settings gets exactly the document they got before — letterhead
   * is an addition to these documents, not a new requirement of them.
   *
   * The address is deliberately absent. It is already printed below in the
   * party block, where the regulation wants it and where a reader looks for
   * it; repeating it here would only make the page busier without making it
   * say anything more.
   */
  async letterhead(options: { text?: boolean; rule?: boolean } = {}): Promise<void> {
    const brand = this.options.brand;
    if (!brand) return;

    const logo = brand.logo;
    // A letter that already prints the carrier's name and address in full —
    // the Part 370 claim letters do — takes the logo alone, because a second
    // rendering of the same name directly above the first reads as a mistake.
    const hasText = options.text !== false && Boolean(brand.name || brand.tagline);
    if (!logo && !hasText) return;

    const top = this.cursor;
    let used = 0;

    if (logo && logo.width > 0 && logo.height > 0) {
      // Never enlarged: a small logo blown up to fill the box prints soft, and
      // the carrier uploaded what they uploaded.
      const scale = Math.min(LOGO_MAX_WIDTH / logo.width, LOGO_MAX_HEIGHT / logo.height, 1);
      const width = logo.width * scale;
      const height = logo.height * scale;

      await this.image(logo.bytes, logo.contentType, {
        x: MARGIN,
        y: top - height,
        width,
        height,
      });
      used = height;
    }

    if (hasText) {
      // Beside the logo when there is one, so the two read as a single block
      // rather than stacking and pushing the document down a line.
      const align = logo ? 'right' : 'left';
      let textY = top;

      if (brand.name) {
        const size = 12;
        const font = this.fonts.bold;
        const x =
          align === 'right'
            ? PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(brand.name, size)
            : MARGIN;
        this.draw(brand.name, { x, y: textY - size, size, font, color: this.accentText });
        textY -= size + 3;
      }

      if (brand.tagline) {
        const size = 7.5;
        const font = this.fonts.regular;
        for (const line of this.wrap(brand.tagline, size, CONTENT_WIDTH / 2, font)) {
          const x =
            align === 'right' ? PAGE_WIDTH - MARGIN - font.widthOfTextAtSize(line, size) : MARGIN;
          this.draw(line, { x, y: textY - size, size, font, color: MUTED });
          textY -= size + 2;
        }
      }

      used = Math.max(used, top - textY);
    }

    this.cursor = top - used - 7;

    if (options.rule === false) {
      this.move(3);
      return;
    }

    this.rule(this.accent, 1.2);
    this.move(9);
  }

  /**
   * The carrier's own terms, after the fixed ones.
   *
   * Appended under a heading naming whose they are, never merged into the
   * regulatory text above. A shipper reading the page has to be able to tell
   * which sentences are the law's and which are this carrier's, because the
   * two are not enforceable on the same footing — and a carrier who could
   * interleave them could quietly contradict a term they are not free to
   * disclaim.
   */
  addendum(carrierName: string): void {
    const text = this.options.brand?.addendum;
    if (!text) return;

    this.heading(`Additional terms — ${carrierName}`);
    this.text(text, { size: 7.5, lineHeight: 10 });
  }

  rule(color = HAIRLINE, thickness = 0.6): void {
    this.ensure(thickness + 2);
    this.page.drawLine({
      start: { x: MARGIN, y: this.cursor },
      end: { x: PAGE_WIDTH - MARGIN, y: this.cursor },
      thickness,
      color,
    });
    this.cursor -= thickness;
  }

  /** A filled panel drawn behind content the caller then writes into. */
  panel(height: number, color = PANEL): { top: number } {
    this.ensure(height);
    const top = this.cursor;
    this.page.drawRectangle({
      x: MARGIN,
      y: top - height,
      width: CONTENT_WIDTH,
      height,
      color,
    });
    return { top };
  }

  /** Draws a label above a value, for form-style fields. */
  field(
    label: string,
    value: string,
    options: { x?: number; width?: number; mono?: boolean } = {},
  ): void {
    const x = options.x ?? MARGIN;
    const width = options.width ?? CONTENT_WIDTH;

    this.ensure(20);
    this.drawTracked(label.toUpperCase(), {
      x,
      y: this.cursor - 6,
      size: 6,
      font: this.fonts.bold,
      color: MUTED,
      tracking: 0.5,
    });
    this.cursor -= 9;

    const font = options.mono ? this.fonts.mono : this.fonts.regular;
    for (const line of this.wrap(value || '—', 9, width, font)) {
      this.ensure(12);
      this.draw(line, { x, y: this.cursor - 9, size: 9, font, color: INK });
      this.cursor -= 11.5;
    }
  }

  /**
   * Two fields side by side without advancing twice.
   *
   * Used for consignor and consignee, which the regulation treats as a pair
   * and which read far more clearly beside each other.
   */
  columns(
    left: (column: ColumnContext) => void,
    right: (column: ColumnContext) => void,
    gap = 18,
  ): void {
    const columnWidth = (CONTENT_WIDTH - gap) / 2;
    const start = this.cursor;

    left({ x: MARGIN, width: columnWidth });
    const leftEnd = this.cursor;

    this.cursor = start;
    right({ x: MARGIN + columnWidth + gap, width: columnWidth });
    const rightEnd = this.cursor;

    this.cursor = Math.min(leftEnd, rightEnd);
  }

  table(
    columns: TableColumn[],
    rows: string[][],
    options: { fontSize?: number; headerColor?: RGB } = {},
  ): void {
    const size = options.fontSize ?? 8;
    const rowPadding = 5;
    const totalWeight = columns.reduce((sum, c) => sum + c.weight, 0);
    const widths = columns.map((c) => (c.weight / totalWeight) * CONTENT_WIDTH);

    const drawHeader = () => {
      this.ensure(size + rowPadding * 2);
      const height = size + rowPadding * 2;
      this.page.drawRectangle({
        x: MARGIN,
        y: this.cursor - height,
        width: CONTENT_WIDTH,
        height,
        color: options.headerColor ?? PANEL,
      });

      let x = MARGIN + 4;
      columns.forEach((column, i) => {
        this.drawTracked(column.header.toUpperCase(), {
          x,
          y: this.cursor - size - rowPadding + 1,
          size: 6.5,
          font: this.fonts.bold,
          color: MUTED,
          tracking: 0.4,
        });
        x += widths[i] ?? 0;
      });
      this.cursor -= height;
    };

    drawHeader();

    for (const row of rows) {
      // Measure the tallest cell first so a wrapped VIN does not overlap the
      // row beneath it.
      const cellLines = row.map((cell, i) => {
        const column = columns[i];
        const font = column?.mono ? this.fonts.mono : this.fonts.regular;
        return this.wrap(cell || '—', size, (widths[i] ?? 0) - 8, font);
      });
      const lineCount = Math.max(1, ...cellLines.map((lines) => lines.length));
      const height = lineCount * (size * 1.3) + rowPadding * 1.5;

      if (this.available < height) {
        this.addPage();
        drawHeader();
      }

      let x = MARGIN + 4;
      cellLines.forEach((lines, i) => {
        const column = columns[i];
        const font = column?.mono ? this.fonts.mono : this.fonts.regular;
        lines.forEach((line, lineIndex) => {
          const cellWidth = (widths[i] ?? 0) - 8;
          const drawX =
            column?.align === 'right'
              ? x + cellWidth - font.widthOfTextAtSize(line, size)
              : x;
          this.draw(line, {
            x: drawX,
            y: this.cursor - size - rowPadding / 2 - lineIndex * (size * 1.3),
            size,
            font,
            color: INK,
          });
        });
        x += widths[i] ?? 0;
      });

      this.cursor -= height;
      this.page.drawLine({
        start: { x: MARGIN, y: this.cursor },
        end: { x: PAGE_WIDTH - MARGIN, y: this.cursor },
        thickness: 0.4,
        color: HAIRLINE,
      });
    }
  }

  /** Places an already-embedded image, scaled to fit a box. */
  async image(
    bytes: Uint8Array,
    contentType: string,
    box: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    const embedded =
      contentType === 'image/png'
        ? await this.pdf.embedPng(bytes)
        : await this.pdf.embedJpg(bytes);

    const scale = Math.min(box.width / embedded.width, box.height / embedded.height);
    const width = embedded.width * scale;
    const height = embedded.height * scale;

    this.page.drawImage(embedded, {
      x: box.x + (box.width - width) / 2,
      y: box.y + (box.height - height) / 2,
      width,
      height,
    });
  }

  /** Current page, for callers that need absolute placement. */
  get currentPage(): PDFPage {
    return this.page;
  }

  drawBox(box: { x: number; y: number; width: number; height: number }, color = HAIRLINE): void {
    this.page.drawRectangle({
      ...box,
      borderColor: color,
      borderWidth: 0.6,
    });
  }

  /**
   * Stamps every page footer and serialises.
   *
   * Footers are written last because "page 2 of 5" cannot be known until the
   * document is finished.
   */
  async finish(): Promise<Uint8Array> {
    const total = this.pages.length;
    // The carrier's line wins where they set one — it is usually a remittance
    // address or a dispatch number, which is more use at the foot of a page
    // than the document number repeated from the masthead.
    const footerNote = this.options.brand?.footerNote ?? this.options.footerNote;

    this.pages.forEach((page, index) => {
      page.setFont(this.fonts.regular);

      const label = `Page ${index + 1} of ${total}`;
      page.drawText(label, {
        x: PAGE_WIDTH - MARGIN - this.fonts.regular.widthOfTextAtSize(label, 7),
        y: MARGIN - 10,
        size: 7,
        color: MUTED,
      });

      if (footerNote) {
        // Clipped rather than wrapped. The footer is one line by construction
        // and the page number sits at the other end of it, so a carrier who
        // pastes a paragraph in gets it cut short instead of printed over the
        // numbering.
        const room = CONTENT_WIDTH - this.fonts.regular.widthOfTextAtSize(label, 7) - 12;
        let text = footerNote;
        while (text.length > 1 && this.fonts.regular.widthOfTextAtSize(text, 7) > room) {
          text = `${text.slice(0, -2)}…`;
        }

        page.drawText(text, {
          x: MARGIN,
          y: MARGIN - 10,
          size: 7,
          color: MUTED,
        });
      }
    });

    return this.pdf.save();
  }
}

/* -------------------------------------------------------------------------
 * Formatting every document agrees on
 * ---------------------------------------------------------------------- */

/**
 * Money on a document, always with its sign shown.
 *
 * Here rather than in each generator because three of them had their own
 * identical copy and a fourth was about to. A statement and the invoice it
 * summarises printing an amount two different ways is exactly the kind of
 * discrepancy a customer queries instead of paying.
 */
export function moneyText(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const body = `${Math.floor(absolute / 100).toLocaleString('en-US')}.${String(absolute % 100).padStart(2, '0')}`;
  return currency === 'USD' ? `${sign}$${body}` : `${sign}${body} ${currency}`;
}

/** UTC deliberately: a document dated by the reader's timezone shifts a day. */
export function dateText(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The fields of a party that belong under its name, one per line. */
export interface PartyAddress {
  contactName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  email?: string | null;
}

export function addressBlock(party: PartyAddress): string {
  return [
    party.contactName,
    party.addressLine1,
    party.addressLine2,
    [party.city, party.state, party.postalCode].filter(Boolean).join(' ').trim() || null,
    party.phone,
    party.email,
  ]
    .filter(Boolean)
    .join('\n');
}

export interface ColumnContext {
  x: number;
  width: number;
}

export interface TableColumn {
  header: string;
  /** Relative share of the content width. */
  weight: number;
  mono?: boolean;
  align?: 'left' | 'right';
}
