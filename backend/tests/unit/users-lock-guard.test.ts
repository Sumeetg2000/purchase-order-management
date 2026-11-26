import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// ADR-0006's exception for keyed commands: every Idempotency-Key insert takes KEY SHARE on
// the caller's users row first (its foreign key), before the order. That is safe only while
// nothing locks a users row FOR UPDATE, the one row lock KEY SHARE conflicts with apart from
// a key change: user rows are locked FOR NO KEY UPDATE (what their own UPDATE takes) or FOR
// SHARE. This guard fails if any backend source or migration locks users FOR UPDATE.

const BACKEND = join(import.meta.dirname, '..', '..');
const ROOTS = [join(BACKEND, 'src'), join(BACKEND, 'prisma', 'migrations')];
const SKIP = [join(BACKEND, 'src', 'generated')];

function files(dir: string): string[] {
  if (SKIP.includes(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|sql)$/.test(name) ? [path] : [];
  });
}

/**
 * The SQL statements in a file that lock a users row FOR UPDATE: each statement (split on
 * template-literal backticks and semicolons) that reads FROM or JOINs users and ends in a
 * plain FOR UPDATE (FOR UPDATE OF names the locked tables, so users must be among them).
 */
export function usersLockedForUpdate(source: string): string[] {
  return source
    .split(/[`;]/)
    .filter((sql) => /\b(FROM|JOIN)\s+users\b/i.test(sql))
    .filter((sql) => {
      const lock = /\bFOR\s+UPDATE\b(\s+OF\s+([\w\s,]+))?/i.exec(sql);
      if (!lock) return false;
      const of = lock[2];
      if (of === undefined) return true;
      const alias = /\b(?:FROM|JOIN)\s+users(?:\s+(?:AS\s+)?(\w+))?/i.exec(sql)?.[1];
      const locked = of.split(',').map((name) => name.trim().toLowerCase());
      return (
        locked.includes('users') || (alias !== undefined && locked.includes(alias.toLowerCase()))
      );
    })
    .map((sql) => sql.replace(/\s+/g, ' ').trim());
}

describe('[NFR-CON-01] no code locks a users row FOR UPDATE (ADR-0006, keyed commands)', () => {
  it('[NFR-CON-01] the detector finds the forms it must find, and only those', () => {
    expect(usersLockedForUpdate('SELECT 1 FROM users WHERE id = $1 FOR UPDATE')).toHaveLength(1);
    expect(
      usersLockedForUpdate(
        'SELECT 1 FROM refresh_tokens t JOIN users u ON u.id = t.u FOR UPDATE OF t, u',
      ),
    ).toHaveLength(1);
    expect(usersLockedForUpdate('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE')).toEqual([]);
    expect(usersLockedForUpdate('SELECT 1 FROM users WHERE id = $1 FOR SHARE')).toEqual([]);
    expect(
      usersLockedForUpdate(
        'SELECT 1 FROM refresh_tokens t JOIN users u ON u.id = t.u FOR UPDATE OF t',
      ),
    ).toEqual([]);
    expect(usersLockedForUpdate('SELECT 1 FROM orders WHERE id = $1 FOR UPDATE')).toEqual([]);
  });

  it('[NFR-CON-01] no backend source or migration locks users FOR UPDATE', () => {
    const found = ROOTS.flatMap(files).flatMap((path) =>
      usersLockedForUpdate(readFileSync(path, 'utf8')).map(
        (sql) => `${relative(BACKEND, path)}: ${sql.slice(0, 90)}`,
      ),
    );
    expect(found).toEqual([]);
  });
});
