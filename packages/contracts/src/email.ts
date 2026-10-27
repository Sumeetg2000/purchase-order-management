import { z } from 'zod';

/** The longest address SMTP allows (RFC 5321 path limit). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * A plain email address, local@domain, and nothing else: no display name, quotes,
 * comments, angle brackets, whitespace or lists. Stricter than RFC 5322 on purpose, so no
 * mail library's address parser can read more recipients into it.
 */
export const emailAddressSchema = z
  .email()
  .max(EMAIL_MAX_LENGTH)
  .refine((value) => !/[\s"<>(),;:\\[\]]/.test(value), 'must be a plain address');
