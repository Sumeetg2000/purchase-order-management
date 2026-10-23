import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type AppPrismaClient = PrismaClient;

export interface PrismaClientOptions {
  url: string;
  /** Maximum pool connections (DB_POOL_SIZE). */
  poolSize: number;
  /** How long a query outside a transaction waits for a free connection. */
  connectionTimeoutMs: number;
}

/** Prisma 7 connects through the pg driver adapter with an explicit pool (research R8). */
export function createPrismaClient(options: PrismaClientOptions): AppPrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.url,
    max: options.poolSize,
    connectionTimeoutMillis: options.connectionTimeoutMs,
  });
  return new PrismaClient({ adapter });
}
