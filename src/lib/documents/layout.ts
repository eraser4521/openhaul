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

export interface DocBuilderOptions {
  /** Rendered bottom-left of every page, beside the page number. */
  footerNote?: string;
  /** Document metadata. Defaults to the current time if omitted. */
  title?: string;
  issuedAt?: Date;
}

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

  /** Starts a new page when `needed` points will not fit. */
  ensure(needed: number): void {
    if (this.available < needed) this.addPage();
  }

  move(points: number): void {
    this.cursor -= points;
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

    this.pages.forEach((page, index) => {
      page.setFont(this.fonts.regular);

      const label = `Page ${index + 1} of ${total}`;
      page.drawText(label, {
        x: PAGE_WIDTH - MARGIN - this.fonts.regular.widthOfTextAtSize(label, 7),
        y: MARGIN - 10,
        size: 7,
        color: MUTED,
      });

      if (this.options.footerNote) {
        page.drawText(this.options.footerNote, {
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
