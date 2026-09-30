import { describe, expect, it, vi } from 'vitest';
import { ResetUnfundedTechnicianWallets1790000000022 } from '../../src/database/migrations/1790000000022-ResetUnfundedTechnicianWallets';

describe('ResetUnfundedTechnicianWallets1790000000022 Migration', () => {
  it('resets wallet balance to 0 and is_available to false for non-seed technicians without transactions', async () => {
    const executedQueries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        executedQueries.push(sql);
        return [];
      }),
    } as any;

    const migration = new ResetUnfundedTechnicianWallets1790000000022();
    await migration.up(queryRunner);

    expect(executedQueries.length).toBe(2);
    const sqlWallet = executedQueries[0].toLowerCase();
    expect(sqlWallet).toContain('update "wallets"');
    expect(sqlWallet).toContain('set "balance" = 0');
    expect(sqlWallet).toContain("u.email not like 'tech%@fixhome.vn'");
    expect(sqlWallet).toContain('not exists');
    expect(sqlWallet).toContain('wallet_transactions');

    const sqlProfile = executedQueries[1].toLowerCase();
    expect(sqlProfile).toContain('update "technician_profiles"');
    expect(sqlProfile).toContain('set "is_available" = false');
  });

  it('runs safely on down without crashing', async () => {
    const queryRunner = {
      query: vi.fn(async () => []),
    } as any;

    const migration = new ResetUnfundedTechnicianWallets1790000000022();
    await expect(migration.down(queryRunner)).resolves.not.toThrow();
  });
});
