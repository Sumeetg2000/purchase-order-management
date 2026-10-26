// Operator CLI, run on the server only: `npm run admin -- <command>` (ADR-0016).
// This stub handles --help; US5 adds the commands.
const USAGE = `Usage: npm run admin -- <command> [flags]

Commands:
  (none yet)

Options:
  --help    Show this message
`;

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(USAGE);
  process.exit(0);
}

process.stderr.write('ERROR USAGE: unknown or missing command. Run with --help.\n');
process.exit(1);
