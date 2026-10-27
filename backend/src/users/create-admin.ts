import { writeAudit } from '../audit/write.js';
import { violatedConstraint } from '../db/errors.js';
import { lockAdmins } from '../db/locks.js';
import type { CliErrorCode } from '../lib/operator-codes.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { issueToken } from '../tokens/one-time.js';
import { createAdminUser, findUserByEmail } from './repository.js';

// Creating an administrator, shared by the bootstrap (SYSTEM) and admin:create (OPERATOR),
// inside the caller's transaction (ADR-0016, contracts/cli.md).

/** The message never names the email: callers' error logs don't redact PII. */
export class EmailInUseError extends Error {
  override readonly name = 'EmailInUseError';
  readonly code: CliErrorCode = 'EMAIL_IN_USE';
}

export interface CreatedAdmin {
  email: string;
  /** The set-password link, shown once and never stored. */
  link: string;
}

/**
 * The set-password page slice 1 builds, with the token in the fragment: browsers never send
 * a fragment to the server, so the token can't reach an access log or a Referer header. The
 * page reads location.hash and POSTs the token in the request body (ADR-0017). The token is
 * base64url, so it needs no escaping.
 */
export function setPasswordLink(appOrigin: string, token: string): string {
  const url = new URL('/reset-password', appOrigin);
  url.hash = `token=${token}`;
  return url.toString();
}

/**
 * Creates an ACTIVE administrator with no password, a RESET token, and the ADMIN_CREATED
 * audit entry, under ADMIN_LOCK (taken here; taking it again in the same transaction is
 * harmless). An email that belongs to anyone already is EmailInUseError: a user is never
 * promoted.
 */
export async function createAdmin(
  tx: AuditedTransaction,
  admin: { email: string; name: string; source: 'bootstrap' | 'cli'; appOrigin: string },
): Promise<CreatedAdmin> {
  await lockAdmins(tx);
  const email = admin.email.toLowerCase();
  if (await findUserByEmail(tx, email)) {
    throw new EmailInUseError('the email already belongs to a user');
  }
  let user;
  try {
    user = await createAdminUser(tx, { email, name: admin.name });
  } catch (error) {
    // A writer that doesn't take ADMIN_LOCK (signup, from slice 1) took the email after the
    // lookup above.
    if (violatedConstraint(error) === 'users_email_key') {
      throw new EmailInUseError('the email already belongs to a user', { cause: error });
    }
    throw error;
  }
  const { token } = await issueToken(tx, user.id, 'RESET');
  await writeAudit(tx, {
    action: 'ADMIN_CREATED',
    entityType: 'user',
    entityId: user.id,
    details: { source: admin.source, name: admin.name, email },
  });
  return { email, link: setPasswordLink(admin.appOrigin, token) };
}
