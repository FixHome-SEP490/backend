import { describe, expect, it, vi } from 'vitest';
import { checkOverrunRelease } from './overrun-release';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { ServiceOrderStatus } from '../../shared/enums';

const NOW = new Date('2026-10-31T07:00:00Z');
const next = { id: 'next', code: 'SO-NEXT', bookingId: 'b-next', status: ServiceOrderStatus.ACCEPTED } as ServiceOrder;
const job = (id: string, extra: Partial<ServiceOrder> = {}) =>
  ({ id, code: id.toUpperCase(), status: ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: null, updatedAt: new Date('2026-10-31T01:00:00Z'), ...extra }) as ServiceOrder;

function check(jobs: ServiceOrder[]) {
  const manager: any = {
    findOneBy: vi.fn(async (entity: unknown, where: any) => {
      if (entity === TechnicianAssignment) return { id: 'a' };
      if (where.id === 'b-next') return { preferredStartAt: new Date('2026-10-31T08:00:00Z') };
      return null; // no arrival check-in for the next order
    }),
    find: vi.fn(async (entity: unknown) => (entity === TechnicianAssignment ? jobs.map(j => ({ serviceOrderId: j.id })) : jobs)),
  };
  return checkOverrunRelease(manager, next, 'tech-1', 180, NOW);
}

describe('current job of a technician who may hold several orders under repair', () => {
  it('is the one not yet handed over, even when a handed-over one is listed first', async () => {
    const result = await check([
      job('old-a', { completionRequestedAt: new Date('2026-10-29T13:20:00Z'), updatedAt: new Date('2026-10-29T13:20:00Z') }),
      job('old-b', { completionRequestedAt: new Date('2026-10-29T13:15:00Z') }),
      job('working'),
    ]);
    expect(result).toMatchObject({ eligible: true, currentOrderId: 'working', currentOrderCode: 'WORKING', currentOrderStatus: ServiceOrderStatus.UNDER_REPAIR });
  });

  it('is the one touched last among those still being worked on', async () => {
    const result = await check([job('earlier', { updatedAt: new Date('2026-10-31T01:00:00Z') }), job('later', { updatedAt: new Date('2026-10-31T05:00:00Z') })]);
    expect(result.currentOrderId).toBe('later');
  });

  it('falls back to a handed-over job when nothing else is under repair, rather than none', async () => {
    const result = await check([job('only', { completionRequestedAt: new Date('2026-10-31T03:00:00Z') })]);
    expect(result.currentOrderId).toBe('only');
  });
});
