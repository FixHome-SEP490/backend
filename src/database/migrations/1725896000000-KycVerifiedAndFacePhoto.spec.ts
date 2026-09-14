import { describe, expect, it, vi } from 'vitest';
import { KycVerifiedAndFacePhoto1725896000000 } from './1725896000000-KycVerifiedAndFacePhoto';

describe('KycVerifiedAndFacePhoto1725896000000', () => {
  it('emits a forward-only schema conversion for KYC status, face photo, profile status, and the open-request index', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new KycVerifiedAndFacePhoto1725896000000().up(queryRunner);

    const sql = queries.join('\n');
    expect(sql).toContain("'pending', 'verified', 'rejected'");
    expect(sql).toContain("WHEN 'approved' THEN 'verified'");
    expect(sql).toContain("ADD VALUE IF NOT EXISTS 'face_photo'");
    expect(sql).toContain('technician_profiles_verification_status_enum');
    expect(sql).toContain("WHERE \"status\" IN ('pending', 'verified')");
    expect(sql).not.toContain('DROP TABLE');
  });

  it('refuses a lossy down migration when new KYC data exists', async () => {
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('technician_verifications')) return [{ count: '1' }];
        return [{ count: '0' }];
      }),
    } as any;

    await expect(
      new KycVerifiedAndFacePhoto1725896000000().down(queryRunner),
    ).rejects.toThrow('reversal would be lossy');
  });
});
