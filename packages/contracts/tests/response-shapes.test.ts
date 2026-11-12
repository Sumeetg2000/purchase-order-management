import { describe, expect, it } from 'vitest';
import { adminAccessRequest, me, ownAccessRequest, vendor } from '../src/index.js';

// Response fields are the ones a client shows (docs/adr/0008, removals of 2026-11-12): a
// field nothing reads is left out rather than kept in step.

const keys = (schema: { shape: object }) => Object.keys(schema.shape).sort();

describe('[FR-USR-01] the profile response', () => {
  it('[FR-USR-01] Me carries no status: only an active user can read it', () => {
    expect(keys(me)).toEqual(['createdAt', 'email', 'id', 'name', 'roles']);
  });
});

describe('[FR-VEN-01] the vendor response', () => {
  it('[FR-VEN-01] Vendor carries deactivatedAt, and no createdAt or updatedAt', () => {
    expect(keys(vendor)).toEqual([
      'contactEmail',
      'contactName',
      'contactPhone',
      'deactivatedAt',
      'id',
      'name',
      'paymentTerms',
      'status',
      'version',
    ]);
  });
});

describe('[FR-ADM-06] the access-request responses', () => {
  it('[FR-ACC-09] the own request carries no createdAt or decidedAt', () => {
    expect(keys(ownAccessRequest)).toEqual(['adminNote', 'message', 'status', 'updatedAt']);
  });

  it('[FR-ADM-06] the admin view names when the user signed up as user.createdAt', () => {
    expect(keys(adminAccessRequest)).toEqual([
      'adminNote',
      'id',
      'message',
      'status',
      'updatedAt',
      'user',
    ]);
    expect(keys(adminAccessRequest.shape.user)).toEqual(['createdAt', 'email', 'id', 'name']);
  });
});
