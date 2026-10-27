import { z } from 'zod';

/** The longest address SMTP allows (RFC 5321 path limit). */
export const EMAIL_MAX_LENGTH = 254;

/**
 * A plain email address, local@domain, and nothing else: no display name, quotes,
 * comments, angle brackets, whitespace or lists. Stricter than RFC 5322 on purpose, so no
 * mail library's address parser can read more recipients into it. The single rule for
 * every address: API bodies, config (MAIL_FROM, BOOTSTRAP_ADMIN_EMAIL) and the CLI.
 *
 * Zod's own email pattern rejects these characters today; the refine says so explicitly,
 * so the guarantee survives a Zod upgrade that loosens its pattern.
 */
export const emailAddressSchema = z
  .email()
  .max(EMAIL_MAX_LENGTH)
  .refine((value) => !/[\s"<>(),;:\\[\]]/.test(value), 'must be a plain address');
