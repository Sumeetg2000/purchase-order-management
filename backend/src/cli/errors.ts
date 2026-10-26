// Exit codes and stable error codes of the operator CLI (contracts/cli.md, ADR-0016).

export const EXIT = {
  OK: 0,
  /** Usage, argument or configuration error. */
  USAGE: 1,
  /** A rule refused the command. */
  REFUSED: 2,
  /** Infrastructure failure: database unreachable, lock timeout, or an unexpected error. */
  UNAVAILABLE: 3,
} as const;

/** A failure the CLI reports as `ERROR <code>: <message>` on stderr. */
export class CliError extends Error {
  override readonly name = 'CliError';

  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}
