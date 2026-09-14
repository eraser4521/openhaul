import { z } from 'zod';

/**
 * What the personal-data form is allowed to contain.
 *
 * Kept out of the server-action file because a `'use server'` module may only
 * export async functions, which would leave this untestable — and the one bug
 * it has already had was a blank field being rejected, which is exactly the
 * case a test catches and a walkthrough does not.
 */

/**
 * An optional field, where blank means "not recorded".
 *
 * `|| null` rather than `?? null`: a form posts an empty string for a field
 * nobody filled in, and `??` lets that through as `''` — which then fails the
 * date check below for the entirely reasonable act of leaving a date of birth
 * blank.
 */
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

export const personalDataSchema = z.object({
  name: optional(160),
  email: optional(160),
  phone: optional(40),
  address: optional(300),
  dob: optional(10).refine((value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: 'A date of birth is YYYY-MM-DD.',
  }),
  cdlNumber: optional(40),
});

export type PersonalDataInput = z.infer<typeof personalDataSchema>;
