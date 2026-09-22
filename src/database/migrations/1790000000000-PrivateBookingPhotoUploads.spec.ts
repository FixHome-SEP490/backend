import { QueryRunner } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { PrivateBookingPhotoUploads1790000000000 } from './1790000000000-PrivateBookingPhotoUploads';

const SCHEMA = 'web_accept_isolated';
const targetSchema = [{ target_schema: SCHEMA }];

describe('PrivateBookingPhotoUploads schema-safe migration', () => {
  it('creates only current-schema private metadata, scoped foreign keys and no storage operations', async () => {
    const query = vi.fn().mockResolvedValueOnce(targetSchema).mockResolvedValue(undefined);
    await new PrivateBookingPhotoUploads1790000000000().up({ query } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(3);
    const ddl = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(ddl).toContain('CREATE TABLE "web_accept_isolated"."booking_media_uploads"');
    expect(ddl).toContain('REFERENCES "web_accept_isolated"."users"("id")');
    expect(ddl).toContain('REFERENCES "web_accept_isolated"."bookings"("id")');
    expect(ddl).toContain('"object_ref" varchar NOT NULL');
    expect(ddl).toContain('UNIQUE ("object_ref")');
    expect(ddl).toContain('"size_bytes" > 0');
    expect(ddl).toContain('"expires_at" timestamptz NOT NULL');
    expect(ddl).toContain('"claimed_booking_id" uuid');
    expect(ddl).not.toContain('storage.objects');
    expect(ddl).not.toContain('DELETE FROM');
  });

  it('does not touch a public table when current schema has no matching table', async () => {
    const query = vi.fn().mockResolvedValueOnce(targetSchema)
      .mockResolvedValueOnce([{ table_exists: false }]);
    const dropTable = vi.fn();
    await new PrivateBookingPhotoUploads1790000000000().down({ query, dropTable, hasTable: vi.fn().mockResolvedValue(true) } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([SCHEMA]);
    expect(query.mock.calls[1][0]).toContain('information_schema.tables');
    expect(dropTable).not.toHaveBeenCalled();
  });

  it('refuses down migration while scoped owner metadata exists', async () => {
    const query = vi.fn().mockResolvedValueOnce(targetSchema)
      .mockResolvedValueOnce([{ table_exists: true }])
      .mockResolvedValueOnce([{ count: 1 }]);
    await expect(new PrivateBookingPhotoUploads1790000000000().down({ query } as unknown as QueryRunner))
      .rejects.toThrow(/ownership metadata exists/i);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][0]).toContain('FROM "web_accept_isolated"."booking_media_uploads"');
  });

  it('drops only empty metadata table in the selected schema', async () => {
    const query = vi.fn().mockResolvedValueOnce(targetSchema)
      .mockResolvedValueOnce([{ table_exists: true }])
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValue(undefined);
    await new PrivateBookingPhotoUploads1790000000000().down({ query } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls[3][0]).toContain('DROP TABLE "web_accept_isolated"."booking_media_uploads"');
  });

  it('fails closed if target schema or row-count evidence is absent', async () => {
    const migration = new PrivateBookingPhotoUploads1790000000000();
    await expect(migration.up({ query: vi.fn().mockResolvedValueOnce([{ target_schema: null }]) } as unknown as QueryRunner))
      .rejects.toThrow(/current schema/i);
    const query = vi.fn().mockResolvedValueOnce(targetSchema)
      .mockResolvedValueOnce([{ table_exists: true }])
      .mockResolvedValueOnce([]);
    await expect(migration.down({ query } as unknown as QueryRunner))
      .rejects.toThrow(/Cannot verify/i);
    expect(query).toHaveBeenCalledTimes(3);
  });
});