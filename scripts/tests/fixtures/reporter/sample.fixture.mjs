import { describe, it } from 'node:test';

describe('[NFR-DEV-01] outer', () => {
  describe('inner', () => {
    it('passes', () => {});
  });
  it('fails', () => {
    throw new Error('no');
  });
  it.skip('is skipped', () => {});
});

it('top level', () => {});

describe.skip('[NFR-DEV-01] skipped suite', () => {
  it('never runs', () => {});
});
