import type { Me } from '@po/contracts';
import type { AppPrismaClient } from '../db/client.js';
import { withDatabase } from '../db/transaction.js';
import { toMe } from '../users/me.js';
import { findProfile } from '../users/repository.js';

// The caller's own profile (ADR-0016). Slice 1 US4 adds the edit.

export interface ProfileService {
  getMe(userId: string): Promise<Me>;
}

export function createProfileService(deps: { prisma: AppPrismaClient }): ProfileService {
  return {
    getMe: async (userId) => {
      const user = await withDatabase(() => findProfile(deps.prisma, userId));
      // The authorize step has just read this user, and users are never deleted.
      if (!user) throw new Error(`authenticated user ${userId} not found`);
      return toMe(user);
    },
  };
}
