import { describe, expect, it, vi } from 'vitest';
import { technicianEligibility } from './technician-eligibility';

describe('interrupted booking technician exclusion', () => {
  it('refuses the previous unsuitable technician before shortlist or acceptance', async () => {
    const manager = {
      createQueryBuilder: vi.fn(() => ({ innerJoin: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), getCount: vi.fn(async () => 0) })),
      count: vi.fn(async (entity: { name: string }) => entity.name === 'InterruptionRebookSource' ? 1 : 0),
    };
    const verdict = await technicianEligibility(manager as never, 'tech-old', { id: 'new-booking' } as never);
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toMatch(/interrupted|previous/i);
  });
});
