/**
 * The carrier's colour, made safe to print.
 *
 * A bill of lading does not stay on a screen. It gets printed on whatever is
 * in the truck, photocopied at a terminal, and faxed to a broker — and a fax
 * is one bit per pixel. A pale brand colour that looks fine in a browser
 * becomes an empty line on the copy that ends up in the file, which is the
 * copy that matters when somebody disputes what was agreed.
 *
 * So the colour is used two ways. Rules, bars and fills take it exactly as
 * given, because legibility of a line is not at stake. Text takes a darkened
 * version that clears 4.5:1 against white — the same threshold WCAG uses for
 * body text, applied here for the same underlying reason.
 *
 * No `server-only`: the settings form uses these to show the carrier what
 * their colour will actually do before they save it.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?[0-9a-fA-F]{6}$/;

/** Parses six hex digits, with or without the hash. Null if it is not that. */
export function parseHex(value: string | null | undefined): Rgb | null {
  if (!value || !HEX.test(value.trim())) return null;
  const hex = value.trim().replace('#', '');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

export function toHex(color: Rgb): string {
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** WCAG 2.x relative luminance. */
export function luminance(color: Rgb): number {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** Contrast ratio against white, which is the only ground these documents use. */
export function contrastOnWhite(color: Rgb): number {
  return 1.05 / (luminance(color) + 0.05);
}

/** The threshold WCAG sets for body text, and roughly where a fax gives up. */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * The darkest the colour needs to be to stay readable as text.
 *
 * Scaling the channels toward black keeps the hue recognisably the carrier's
 * rather than substituting a different colour. Returned unchanged when it
 * already passes, so a carrier who picked a dark colour gets exactly what they
 * picked.
 */
export function darkenForText(color: Rgb): Rgb {
  if (contrastOnWhite(color) >= MIN_TEXT_CONTRAST) return color;

  // Contrast rises monotonically as the scale falls, so bisection converges
  // without needing to invert the luminance curve.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    const scaled = { r: color.r * mid, g: color.g * mid, b: color.b * mid };
    if (contrastOnWhite(scaled) >= MIN_TEXT_CONTRAST) low = mid;
    else high = mid;
  }

  return { r: color.r * low, g: color.g * low, b: color.b * low };
}

export interface AccentAssessment {
  /** Null when the value was not six hex digits. */
  color: Rgb | null;
  /** What text set in it will actually print as. */
  textColor: Rgb | null;
  /** True when the two differ, which is worth telling the carrier about. */
  darkened: boolean;
  contrast: number;
}

export function assessAccent(value: string | null | undefined): AccentAssessment {
  const color = parseHex(value);
  if (!color) return { color: null, textColor: null, darkened: false, contrast: 0 };

  const textColor = darkenForText(color);
  return {
    color,
    textColor,
    darkened: toHex(textColor) !== toHex(color),
    contrast: contrastOnWhite(color),
  };
}
