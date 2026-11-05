import { cliConfig } from '../config/cli.js';
import { loadConfig } from '../config/load.js';
import { createPrismaClient } from '../db/client.js';
import { classifyDbError, DatabaseUnavailableError } from '../db/errors.js';
import { ONE_SHOT } from '../db/one-shot.js';
import { withTransaction, type AuditedTransaction } from '../db/transaction.js';
import { systemClock } from '../lib/clock.js';
import { uuidv7 } from '../lib/uuid.js';
import { createLogger } from '../observability/logger.js';
import { RESET_TOKEN_LIFETIME_MINUTES } from '../tokens/one-time.js';
import { AdminStatusRefusedError } from '../users/admin-status.js';
import { EmailInUseError } from '../users/create-admin.js';
import {
  adminCreate,
  parseAdminCreateArgs,
  USAGE_LINE as CREATE_USAGE,
} from './commands/admin-create.js';
import {
  adminDeactivate,
  parseAdminDeactivateArgs,
  USAGE_LINE as DEACTIVATE_USAGE,
} from './commands/admin-deactivate.js';
import {
  adminReactivate,
  parseAdminReactivateArgs,
  USAGE_LINE as REACTIVATE_USAGE,
} from './commands/admin-reactivate.js';
import { CliError, EXIT } from './errors.js';

// The operator CLI (contracts/cli.md, research R13). Server only: no HTTP route reaches
// this module (route-table test). Each command runs in one transaction under ADMIN_LOCK
// with an OPERATOR actor naming the OS user and host.

const USAGE = `Usage: npm run admin -- <command> [flags]

Commands:
  ${CREATE_USAGE}
      Create an active administrator with no password and print a one-time
      set-password link (valid ${String(RESET_TOKEN_LIFETIME_MINUTES)} minutes, shown once).
  ${DEACTIVATE_USAGE}
      Deactivate an administrator and end their sessions. The last active
      administrator is never deactivated.
  ${REACTIVATE_USAGE}
      Reactivate a deactivated administrator.

Options:
  --help    Show this message

Exit codes: 0 success, 1 usage or validation error, 2 refused by a rule,
3 database unreachable, lock timeout or unexpected failure.
`;

export interface CliDeps {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** The OS user running the command, recorded in the audit entry. */
  osUser: string;
  host: string;
}

/** A parsed command: the work it does inside the OPERATOR transaction. */
type CommandWork = (
  tx: AuditedTransaction,
  context: { appOrigin: string; now: Date },
) => Promise<string[]>;

function parseCommand(argv: readonly string[]): CommandWork {
  const [command, ...rest] = argv;
  if (command === 'admin:create') {
    const args = parseAdminCreateArgs(rest);
    return (tx, { appOrigin }) => adminCreate(tx, args, appOrigin);
  }
  if (command === 'admin:deactivate') {
    const args = parseAdminDeactivateArgs(rest);
    return (tx, { now }) => adminDeactivate(tx, args, now);
  }
  if (command === 'admin:reactivate') {
    const args = parseAdminReactivateArgs(rest);
    return (tx, { now }) => adminReactivate(tx, args, now);
  }
  // The typed value is not echoed: with arguments out of order it can be an email or name.
  throw new CliError(
    'USAGE',
    EXIT.USAGE,
    command === undefined
      ? 'no command given. Run with --help.'
      : 'unknown command. Run with --help.',
  );
}

/** Runs one CLI invocation and returns its exit code. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  // --help anywhere shows the usage and runs nothing.
  if (argv.includes('--help')) {
    deps.stdout(USAGE);
    return EXIT.OK;
  }
  try {
    const work = parseCommand(argv);

    const configErrors: string[] = [];
    const config = loadConfig(cliConfig.schema, deps.env, {
      write: (line) => configErrors.push(line),
      exit: () => undefined,
    });
    if (!config) {
      throw new CliError('INVALID_CONFIGURATION', EXIT.USAGE, configErrors.join('\n'));
    }

    const prisma = createPrismaClient({
      url: config.DATABASE_URL,
      poolSize: 1,
      connectionTimeoutMs: ONE_SHOT.connectionTimeoutMs,
    });
    try {
      const lines = await withTransaction(
        {
          prisma,
          actor: { type: 'OPERATOR', osUser: deps.osUser, host: deps.host },
          requestId: uuidv7(),
          timeoutMs: ONE_SHOT.transactionTimeoutMs,
          maxWaitMs: ONE_SHOT.transactionMaxWaitMs,
          logger: createLogger(config.LOG_LEVEL, { write: deps.stderr }),
        },
        (tx) => work(tx, { appOrigin: config.APP_ORIGIN, now: systemClock.now() }),
      );
      deps.stdout(`${lines.join('\n')}\n`);
      return EXIT.OK;
    } finally {
      await prisma.$disconnect();
    }
  } catch (error) {
    const failure = toCliError(error);
    deps.stderr(`ERROR ${failure.code}: ${failure.message}\n`);
    return failure.exitCode;
  }
}

// Messages never name the email: the operator typed it, and error output isn't redacted.
const REFUSAL_MESSAGES: Record<AdminStatusRefusedError['code'], string> = {
  NOT_AN_ADMIN: 'that email is not an administrator; nothing was changed',
  LAST_ADMIN:
    'that is the last active administrator, who is never deactivated; nothing was changed',
};

function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof EmailInUseError) {
    return new CliError(
      'EMAIL_IN_USE',
      EXIT.REFUSED,
      'that email already belongs to a user, who is never promoted; nothing was changed',
    );
  }
  if (error instanceof AdminStatusRefusedError) {
    return new CliError(error.code, EXIT.REFUSED, REFUSAL_MESSAGES[error.code]);
  }
  if (error instanceof DatabaseUnavailableError || classifyDbError(error) === 'unavailable') {
    return new CliError(
      'UNAVAILABLE',
      EXIT.UNAVAILABLE,
      'the database is unreachable or the admin lock timed out; nothing was changed',
    );
  }
  return new CliError(
    'INTERNAL_ERROR',
    EXIT.UNAVAILABLE,
    `unexpected failure (${error instanceof Error ? error.name : 'unknown'}); nothing was changed`,
  );
}
