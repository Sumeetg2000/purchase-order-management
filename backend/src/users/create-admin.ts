import { writeAudit } from '../audit/write.js';
import type { AuditedTransaction } from '../db/transaction.js';
import { issueToken } from '../tokens/one-time.js';
import { createAdminUser, findUserByEmail } from './repository.js';

// Creating an administrator, shared by the bootstrap (SYSTEM) and admin:create (OPERATOR).
// Callers hold ADMIN_LOCK and own the transaction (ADR-0016, contracts/cli.md).

export class EmailInUseError extends Error {
  override readonly name = 'EmailInUseError';
  readonly code = 'EMAIL_IN_USE';
}

export interface CreatedAdmin {
  email: string;
  /** The set-password link, shown once and never stored. */
  link: string;
}

/** The set-password page slice 1 builds; the token is base64url, so it needs no escaping. */
export function setPasswordLink(appOrigin: string, token: string): string {
  const url = new URL('/reset-password', appOrigin);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * Creates an ACTIVE administrator with no password, a RESET token, and the ADMIN_CREATED
 * audit entry. An email that belongs to anyone already is EmailInUseError: a user is never
 * promoted.
 */
export async function createAdmin(
  tx: AuditedTransaction,
  admin: { email: string; name: string; source: 'bootstrap' | 'cli'; appOrigin: string },
): Promise<CreatedAdmin> {
  const email = admin.email.toLowerCase();
  if (await findUserByEmail(tx, email)) {
    throw new EmailInUseError(`${email} already belongs to a user`);
  }
  const user = await createAdminUser(tx, { email, name: admin.name });
  const { token } = await issueToken(tx, user.id, 'RESET');
  await writeAudit(tx, {
    action: 'ADMIN_CREATED',
    entityType: 'user',
    entityId: user.id,
    details: { source: admin.source, name: admin.name, email },
  });
  return { email, link: setPasswordLink(admin.appOrigin, token) };
}
