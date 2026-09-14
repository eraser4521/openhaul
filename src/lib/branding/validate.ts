import { z } from 'zod';
import { TEMPLATE_SCOPES, ACCESSORIAL_UNITS } from '../db/schema';

/**
 * Field limits for a template, defined once.
 *
 * The settings form, the server action behind it and the preview route all
 * parse through this. Three places agreeing on what a valid footer line is
 * only by convention is how a preview ends up showing something the save then
 * refuses.
 *
 * Empty strings become null rather than empty text, because null is what the
 * resolver reads as "inherit" — a carrier clearing the footer on invoices
 * means "use the house one", and saving an empty string instead would print a
 * blank line forever.
 */

const blankToNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => value || null);

export const templateFieldsSchema = z.object({
  letterheadName: blankToNull(80),
  tagline: blankToNull(120),
  accentHex: z
    .string()
    .trim()
    .nullish()
    .transform((value) => value?.replace('#', '').toLowerCase() || null)
    .refine((value) => value === null || /^[0-9a-f]{6}$/.test(value), {
      message: 'A colour is six hex digits, like 1F4E79.',
    }),
  showLogo: z
    .boolean()
    .nullish()
    .transform((value) => value ?? null),
  /** One line at the foot of every page, so it has to stay one line. */
  footerNote: blankToNull(110),
  addendum: blankToNull(4000),
  remitToText: blankToNull(300),
});

export type TemplateFieldValues = z.infer<typeof templateFieldsSchema>;

export const templateScopeSchema = z.enum(TEMPLATE_SCOPES);

export const accessorialRateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, 'Give the charge a short code.')
    .max(12)
    .regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, dashes and underscores only.'),
  label: z.string().trim().min(1, 'Give the charge a name a customer will recognise.').max(80),
  unit: z.enum(ACCESSORIAL_UNITS),
  defaultCents: z.number().int().min(0).max(100_000_000),
  note: blankToNull(200),
});
