import type { AppPrismaClient } from '../db/client.js';

export interface MigrationRow {
  migration_name: string;
  finished: boolean;
  rolled_back: boolean;
}

export interface HealthRepository {
  /** Prisma's migration table; one query proves the database answers. */
  migrationRows: () => Promise<MigrationRow[]>;
}

export function createHealthRepository(prisma: AppPrismaClient): HealthRepository {
  return {
    migrationRows: () =>
      prisma.$queryRaw<MigrationRow[]>`
        SELECT migration_name,
               finished_at IS NOT NULL AS finished,
               rolled_back_at IS NOT NULL AS rolled_back
          FROM _prisma_migrations`,
  };
}
