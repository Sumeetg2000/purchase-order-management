import type { z } from 'zod';

export interface LoadConfigIo {
  write: (line: string) => void;
  exit: (code: number) => void;
}

const defaultIo: LoadConfigIo = {
  write: (line) => process.stderr.write(`${line}\n`),
  exit: (code) => process.exit(code),
};

// Keys whose values may be credentials. Their values are never printed, even when a
// validation message would otherwise echo them. URLs embed passwords.
const SENSITIVE_KEY = /PASSWORD|SECRET|TOKEN|URL/;

function scrub(message: string, env: Record<string, string | undefined>): string {
  let out = message;
  for (const [key, value] of Object.entries(env)) {
    if (value && SENSITIVE_KEY.test(key)) {
      out = out.split(value).join('[redacted]');
    }
  }
  return out;
}

/**
 * Validates the process environment against a schema. On failure it prints one line per
 * invalid key (key and reason, never the value) and exits 1, so a misconfigured process
 * never starts (Principle IX).
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
  io: LoadConfigIo = defaultIo,
): z.output<S> | undefined {
  const parsed = schema.safeParse(env);
  if (parsed.success) {
    return parsed.data;
  }

  io.write('Invalid configuration:');
  for (const issue of parsed.error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    io.write(`  ${key}: ${scrub(issue.message, env)}`);
  }
  io.exit(1);
  return undefined;
}
