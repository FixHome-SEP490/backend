import { QueryRunner } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { BookingInvitationGroups1790000000002 } from './1790000000002-BookingInvitationGroups';

const SCHEMA = 'web_accept_isolated';

describe('BookingInvitationGroups schema-safe migration', () => {
  it('creates a durable group table and nullable legacy-safe invitation reference without backfilling rows', async () => {
    const query = vi.fn().mockResolvedValueOnce([{ target_schema: SCHEMA }]).mockResolvedValue(undefined);

    await new BookingInvitationGroups1790000000002().up({ query } as unknown as QueryRunner);

    const ddl = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(ddl).toContain('CREATE TABLE "web_accept_isolated"."booking_invitation_groups"');
    expect(ddl).toContain('"extension_used_at" timestamptz NULL');
    expect(ddl).toContain('ADD COLUMN "group_id" uuid NULL');
    expect(ddl).toContain('REFERENCES "web_accept_isolated"."booking_invitation_groups"("id")');
    expect(ddl).not.toMatch(/UPDATE\s+"web_accept_isolated"\."booking_invitations"/i);
    expect(ddl).not.toContain('storage.objects');
  });

  it('fails closed on rollback when durable group state exists', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ target_schema: SCHEMA }])
      .mockResolvedValueOnce([{ group_count: 1, invitation_count: 1 }]);

    await expect(new BookingInvitationGroups1790000000002().down({ query } as unknown as QueryRunner))
      .rejects.toThrow(/durable group state exists/i);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('quotes schema names and removes only empty additive state on rollback', async () => {
    const quotedSchema = 'schema"with"quotes';
    const query = vi.fn()
      .mockResolvedValueOnce([{ target_schema: quotedSchema }])
      .mockResolvedValueOnce([{ group_count: 0, invitation_count: 0 }])
      .mockResolvedValue(undefined);

    await new BookingInvitationGroups1790000000002().down({ query } as unknown as QueryRunner);

    const ddl = query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(ddl).toContain('"schema""with""quotes"."booking_invitations"');
    expect(ddl).toContain('DROP COLUMN "group_id"');
    expect(ddl).toContain('DROP TABLE "schema""with""quotes"."booking_invitation_groups"');
  });
});
