import { afterEach } from 'vitest';
import type { TestDatabase } from './db.js';

// Databases created through useTestDatabase() are dropped after each test.
const created: TestDatabase[] = [];

export function trackDatabase(db: TestDatabase): TestDatabase {
  created.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((db) => db.drop()));
});
