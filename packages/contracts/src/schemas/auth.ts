import { z } from 'zod';
import { emailAddressSchema } from '../email.js';
import type { FieldCode } from '../errors.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, USER_NAME_MAX_LENGTH } from '../users.js';

// Account and authentication bodies (contracts/api.md, ADR-0017).

/** The longest one-time token accepted in a body; real ones are 43 characters. */
export const TOKEN_INPUT_MAX_LENGTH = 128;

/** A user's name as entered: trimmed, 1 to USER_NAME_MAX_LENGTH characters. */
export const userName = z.string().trim().min(1).max(USER_NAME_MAX_LENGTH);

function passwordIssue(fieldCode: FieldCode, message: string) {
  return { code: 'custom' as const, message, params: { fieldCode } };
}

/**
 * The password policy's length rule (ADR-0017, research R4), counted in characters (code
 * points), so twelve emoji are twelve characters. Each failure is a custom issue carrying
 * its field code. The common-password check is the service's: the list stays out of the
 * web bundle.
 */
export const passwordSchema = z
  .string()
  .superRefine((value, ctx) => {
    const length = Array.from(value).length;
    if (length < PASSWORD_MIN_LENGTH) {
      ctx.addIssue(
        passwordIssue(
          'PASSWORD_TOO_SHORT',
          `must be at least ${String(PASSWORD_MIN_LENGTH)} characters`,
        ),
      );
    } else if (length > PASSWORD_MAX_LENGTH) {
      ctx.addIssue(
        passwordIssue(
          'PASSWORD_TOO_LONG',
          `must be at most ${String(PASSWORD_MAX_LENGTH)} characters`,
        ),
      );
    }
  })
  .meta({
    override: ({ jsonSchema }: { jsonSchema: Record<string, unknown> }) => {
      jsonSchema['minLength'] = PASSWORD_MIN_LENGTH;
      jsonSchema['maxLength'] = PASSWORD_MAX_LENGTH;
    },
  });

/**
 * A password presented to log in or to confirm a change: present and not over the
 * maximum. The policy applies only when one is set; an old password may predate it.
 */
export const presentedPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH);

const oneTimeToken = z.string().min(1).max(TOKEN_INPUT_MAX_LENGTH);

export const loginBody = z.strictObject({ email: emailAddressSchema, password: presentedPassword });
export const signupBody = z.strictObject({
  name: userName,
  email: emailAddressSchema,
  password: passwordSchema,
});
export const tokenBody = z.strictObject({ token: oneTimeToken });
/** A verification link, with the password chosen at signup (ADR-0017 "Squatting"). */
export const verifyEmailBody = z.strictObject({ token: oneTimeToken, password: presentedPassword });
export const emailBody = z.strictObject({ email: emailAddressSchema });
export const resetPasswordBody = z.strictObject({
  token: oneTimeToken,
  newPassword: passwordSchema,
});
export const changePasswordBody = z.strictObject({
  currentPassword: presentedPassword,
  newPassword: passwordSchema,
});

export type LoginBody = z.infer<typeof loginBody>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBody>;
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;
export type SignupBody = z.infer<typeof signupBody>;
export type TokenBody = z.infer<typeof tokenBody>;
export type VerifyEmailBody = z.infer<typeof verifyEmailBody>;
export type EmailBody = z.infer<typeof emailBody>;
