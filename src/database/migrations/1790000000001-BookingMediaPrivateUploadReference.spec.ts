import { QueryRunner } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { BookingMediaPrivateUploadReference1790000000001 } from './1790000000001-BookingMediaPrivateUploadReference';

const SCHEMA = 'web_accept_isolated';
const targetSchema = [{ target_schema: SCHEMA }];

describe('BookingMediaPrivateUploadReference schema-safe migration', () => {
  it('adds a nullable unique upload FK and preserves every existing public media row', async () => {
    const query = vi.fn().mockResolvedValueOnce(targetSchema).mockResolvedValue(undefined);
    await new BookingMediaPrivateUploadReference1790000000001().up({ query } as unknown as QueryRunner);

    expect(query).toHaveBeenCalledTimes(2);
    const ddl = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(ddl).toContain('ALTER TABLE "web_accept_isolated"."booking_media"');
    expect(ddl).toContain('ADD COLUMN "private_upload_id" uuid');
    expect(ddl).not.toMatch(/"private_upload_id"\s+uuid\s+NOT NULL/i);
    expect(ddl).toContain('REFERENCES "web_accept_isolated"."booking_media_uploads"("id")');
    expect(ddl).toContain('UNIQUE ("private_upload_id")');
    expect(ddl).toContain('"private_upload_id" IS NULL OR "url" =');
    expect(ddl).not.toMatch(/\bUPDATE\s+"/i);
    expect(ddl).not.toContain('DELETE FROM');
    expect(ddl).not.toContain('storage.objects');
  });

  it('quotes the current schema and refuses rollback while private media references exist', async () => {
    const quotedSchema = 'schema"with"quotes';
    const query = vi.fn()
      .mockResolvedValueOnce([{ target_schema: quotedSchema }])
      .mockResolvedValueOnce([{ count: 1 }]);
    await expect(new BookingMediaPrivateUploadReference1790000000001().down({
      query,
    } as unknown as QueryRunner)).rejects.toThrow(/private Booking media references exist/i);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain('"schema""with""quotes"."booking_media"');
  });

  it('drops only the empty nullable reference column on rollback', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce(targetSchema)
      .mockResolvedValueOnce([{ count: 0 }])
      .mockResolvedValue(undefined);
    await new BookingMediaPrivateUploadReference1790000000001().down({ query } as unknown as QueryRunner);
    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[2][0])).toContain('DROP COLUMN "private_upload_id"');
  });

  it('fails closed when schema or private-reference count evidence is missing', async () => {
    const migration = new BookingMediaPrivateUploadReference1790000000001();
    await expect(migration.up({
      query: vi.fn().mockResolvedValueOnce([{ target_schema: null }]),
    } as unknown as QueryRunner)).rejects.toThrow(/current schema/i);

    const query = vi.fn().mockResolvedValueOnce(targetSchema).mockResolvedValueOnce([]);
    await expect(migration.down({ query } as unknown as QueryRunner)).rejects.toThrow(/Cannot verify/i);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
