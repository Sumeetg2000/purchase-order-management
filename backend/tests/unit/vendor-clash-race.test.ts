import { AppError } from '@po/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../src/auth/service.js';
import type { AppPrismaClient } from '../../src/db/client.js';
import type { TransactionRunner } from '../../src/db/transaction.js';
import { Prisma } from '../../src/generated/prisma/client.js';
import type { RequestContext } from '../../src/lib/request-context.js';
import { createVendorsService } from '../../src/vendors/service.js';
import { createCapture } from '../support/log-capture.js';

// A name clash whose holder is gone by the time it is read back (research R3): another
// Buyer renamed that vendor between the conflict and the read. No database can time that
// window, so the repository is replaced here. The answer is the retryable 503, never a 500.

const repository = vi.hoisted(() => ({
  insertVendor: vi.fn(),
  findVendorByNameKey: vi.fn(),
  selectVendor: vi.fn(),
  updateVendor: vi.fn(),
}));
vi.mock('../../src/vendors/repository.js', () => repository);

const BUYER = { userId: 'u1', name: 'Bea', email: 'bea@example.local' } as AuthenticatedUser;
const BODY = {
  name: 'Acme',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  paymentTerms: { type: 'ADVANCE' as const },
};

function service(run: TransactionRunner['run']) {
  const ctx = { requestId: 'r1', logger: createCapture().logger } as unknown as RequestContext;
  return {
    vendors: createVendorsService({ prisma: {} as AppPrismaClient, transactions: { run } }),
    ctx,
  };
}

/** The adapter's unique violation on the name key, as Prisma 7.10.1 reports a raw query's. */
function nameKeyViolation() {
  return new Prisma.PrismaClientKnownRequestError('duplicate key', {
    code: 'P2010',
    clientVersion: '7.10.1',
    meta: {
      driverAdapterError: {
        cause: {
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'vendors_name_key_key' },
        },
      },
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('[FR-VEN-01] a name clash whose holder has gone', () => {
  it('[FR-VEN-01] create: the insert conflicted but no vendor holds the name → retryable 503', async () => {
    repository.insertVendor.mockResolvedValue(null);
    repository.findVendorByNameKey.mockResolvedValue(null);
    const { vendors, ctx } = service((_options, fn) => fn({} as never, {} as never));
    const error: unknown = await vendors.createVendor(BUYER, BODY, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'CONCURRENCY_RETRY_EXHAUSTED', status: 503 });
  });

  it('[FR-VEN-01] edit: the rename lost the key but no vendor holds it now → retryable 503', async () => {
    repository.findVendorByNameKey.mockResolvedValue(null);
    const { vendors, ctx } = service(() => Promise.reject(nameKeyViolation()));
    const error: unknown = await vendors
      .updateVendor(
        BUYER,
        { id: '0192e4a0-0000-7000-8000-0000000000a1', version: 1, body: BODY },
        ctx,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'CONCURRENCY_RETRY_EXHAUSTED', status: 503 });
  });
});
