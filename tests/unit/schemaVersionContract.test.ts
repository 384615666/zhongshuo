import { describe, expect, it } from 'vitest';
import { CURRENT_DATA_SCHEMA_VERSION } from '../../src/contracts/dataCopyJob.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/registry.ts';

describe('current schema contract', () => {
  it('matches the latest append-only migration', () => {
    expect(CURRENT_DATA_SCHEMA_VERSION).toBe(MIGRATIONS.at(-1)?.id);
  });
});
