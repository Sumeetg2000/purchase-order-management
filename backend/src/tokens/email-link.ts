import type { Logger } from 'pino';
import type { AuditedTransaction, TransactionHooks } from '../db/transaction.js';
import type { MailDispatcher } from '../mail/dispatcher.js';
import { sendAfterCommit } from '../mail/send-after-commit.js';
import { resetPasswordTemplate, verifyEmailTemplate } from '../mail/templates.js';
import { setPasswordLink, verifyEmailLink } from './links.js';
import { issueToken, type TokenPurpose } from './one-time.js';

// Each one-time link's email and page (ADR-0017): a reset link opens the set-password
// page, a verification link the verify-email page.
const LINK_EMAILS = {
  RESET: { template: resetPasswordTemplate, link: setPasswordLink },
  VERIFY_EMAIL: { template: verifyEmailTemplate, link: verifyEmailLink },
} as const satisfies Record<TokenPurpose, unknown>;

interface LinkMailer {
  mail: MailDispatcher;
  /** APP_ORIGIN, for the link. */
  appOrigin: string;
  logger: Logger;
}

/**
 * Issues a one-time token, which supersedes the user's earlier unused ones with the same
 * purpose, and emails its link once the transaction commits.
 */
export async function emailOneTimeLink(
  tx: AuditedTransaction,
  hooks: TransactionHooks,
  purpose: TokenPurpose,
  user: { id: string; email: string; name: string },
  { mail, appOrigin, logger }: LinkMailer,
): Promise<void> {
  const { token } = await issueToken(tx, user.id, purpose);
  const { template, link } = LINK_EMAILS[purpose];
  sendAfterCommit(hooks, {
    mail,
    logger,
    message: {
      template,
      to: user.email,
      variables: { name: user.name, link: link(appOrigin, token) },
    },
  });
}
