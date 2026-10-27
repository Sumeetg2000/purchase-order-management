// Operator CLI entry, run on the server only: `npm run admin -- <command>` (ADR-0016,
// contracts/cli.md). The commands live in run.ts.
import { hostname, userInfo } from 'node:os';
import { runCli } from './run.js';

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    // No passwd entry for the uid (some containers): fall back to the environment.
    return process.env['USER'] ?? `uid-${String(process.getuid?.() ?? 'unknown')}`;
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  osUser: osUser(),
  host: hostname(),
});
