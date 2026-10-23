import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config/load.js';

const schema = z.object({
  HTTP_PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.url(),
  SMTP_PASSWORD: z.string().min(16),
  API_TOKEN: z.string().min(16),
  CLIENT_SECRET: z.string().min(16),
});

function run(env: Record<string, string | undefined>) {
  const lines: string[] = [];
  let exitCode: number | undefined;
  const result = loadConfig(schema, env, {
    write: (line) => lines.push(line),
    exit: (code) => {
      exitCode = code;
    },
  });
  return { result, output: lines.join('\n'), exitCode };
}

const valid = {
  HTTP_PORT: '3000',
  DATABASE_URL: 'postgres://po_app:pw@db:5432/po',
  SMTP_PASSWORD: 'xxxx-xxxx-xxxx-xxxx',
  API_TOKEN: 'xxxx-xxxx-xxxx-xxxx',
  CLIENT_SECRET: 'xxxx-xxxx-xxxx-xxxx',
};

describe('[NFR-OPS-02] config loader', () => {
  it('returns the parsed config when every key is valid', () => {
    const { result, exitCode } = run(valid);
    expect(exitCode).toBeUndefined();
    expect(result?.HTTP_PORT).toBe(3000);
  });

  it('exits 1 naming every invalid or missing key with its reason', () => {
    const { result, output, exitCode } = run({ ...valid, HTTP_PORT: 'abc', API_TOKEN: undefined });
    expect(exitCode).toBe(1);
    expect(result).toBeUndefined();
    expect(output).toMatch(/HTTP_PORT: .+/);
    expect(output).toMatch(/API_TOKEN: .+/);
    expect(output).not.toMatch(/DATABASE_URL/);
  });

  it('never prints the value of a key containing PASSWORD, SECRET, TOKEN or URL', () => {
    const secrets = {
      DATABASE_URL: 'not-a-url-xxxx-1',
      SMTP_PASSWORD: 'xxxx-xxxx-2',
      API_TOKEN: 'xxxx-xxxx-3',
      CLIENT_SECRET: 'xxxx-xxxx-4',
    };
    const { output, exitCode } = run({ ...valid, ...secrets });
    expect(exitCode).toBe(1);
    for (const value of Object.values(secrets)) {
      expect(output).not.toContain(value);
    }
    expect(output).toMatch(/DATABASE_URL/);
    expect(output).toMatch(/SMTP_PASSWORD/);
  });
});
