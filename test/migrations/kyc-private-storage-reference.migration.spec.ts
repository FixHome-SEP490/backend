import { describe, expect, it, vi } from 'vitest';
import { KycPrivateStorageReference1725897000000 } from '../../src/database/migrations/1725897000000-KycPrivateStorageReference';

describe('KycPrivateStorageReference1725897000000', () => {
  it('adds a nullable private object reference without executing shared DB work', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [{ count: '0' }];
      }),
    } as any;

    await new KycPrivateStorageReference1725897000000().up(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "storage_object_path"');
    expect(sql).toContain('ALTER COLUMN "file_url" DROP NOT NULL');
    expect(sql).toContain('idx_verification_documents_storage_object_path');
    expect(sql).not.toContain('DROP TABLE');
  });

  it('refuses a lossy down migration when a row has both legacy and private references', async () => {
    const queryRunner = {
      query: vi.fn(async (sql: string) =>
        sql.includes('"storage_object_path" IS NOT NULL')
          ? [{ count: '1' }]
          : [],
      ),
    } as any;

    await expect(
      new KycPrivateStorageReference1725897000000().down(queryRunner),
    ).rejects.toThrow('reversal would be lossy');
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0][0]).not.toContain(
      '"file_url" IS NULL',
    );
  });

  it('allows down migration only when no private storage reference exists', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new KycPrivateStorageReference1725897000000().down(queryRunner);

    expect(queries[0]).toContain('"storage_object_path" IS NOT NULL');
    expect(queries.join('\n')).toContain('DROP COLUMN IF EXISTS "storage_object_path"');
    expect(queries.join('\n')).toContain('ALTER COLUMN "file_url" SET NOT NULL');
  });
});
