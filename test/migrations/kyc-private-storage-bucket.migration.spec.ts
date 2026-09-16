import { describe, expect, it, vi } from 'vitest';
import { KycPrivateStorageBucket1725902000000 } from '../../src/database/migrations/1725902000000-KycPrivateStorageBucket';

describe('KycPrivateStorageBucket1725902000000', () => {
  it('registers the private kyc bucket idempotently', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new KycPrivateStorageBucket1725902000000().up(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain("INSERT INTO storage.buckets");
    expect(sql).toContain("'kyc-private'");
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
    expect(sql).toContain('"public"');
  });

  it('issues a single guarded statement so plain Postgres without a storage schema stays a no-op', async () => {
    const queryRunner = {
      // Simulates plain postgres:16 (local/CI): the guarded DO block runs but
      // its IF branch never fires because information_schema.tables has no
      // storage.buckets row.
      query: vi.fn(async () => []),
    } as any;

    await expect(
      new KycPrivateStorageBucket1725902000000().up(queryRunner),
    ).resolves.not.toThrow();
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
  });

  it('down is a no-op when storage.buckets does not exist', async () => {
    const queryRunner = {
      query: vi.fn(async () => [{ exists: false }]),
    } as any;

    await new KycPrivateStorageBucket1725902000000().down(queryRunner);

    expect(queryRunner.query).toHaveBeenCalledTimes(1);
  });

  it('refuses to drop the bucket when it still holds objects', async () => {
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('information_schema.tables')) return [{ exists: true }];
        if (sql.includes('storage.objects')) return [{ count: 3 }];
        return [];
      }),
    } as any;

    await expect(
      new KycPrivateStorageBucket1725902000000().down(queryRunner),
    ).rejects.toThrow('still holds objects');
    expect(queryRunner.query).toHaveBeenCalledTimes(2);
  });

  it('drops the bucket when it exists and is empty', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('information_schema.tables')) return [{ exists: true }];
        if (sql.includes('storage.objects')) return [{ count: 0 }];
        return [];
      }),
    } as any;

    await new KycPrivateStorageBucket1725902000000().down(queryRunner);

    expect(queries.join('\n')).toContain(
      "DELETE FROM storage.buckets WHERE \"id\" = 'kyc-private'",
    );
  });
});
