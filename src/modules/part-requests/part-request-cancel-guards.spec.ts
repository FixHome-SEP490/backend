import { describe, expect, it, vi } from 'vitest';
import { PartRequestsService } from './part-requests.service';
import { AdditionalCostRequest } from '../service-orders/entities/additional-cost-request.entity';
import { Role } from '../../shared/enums';

// BUG DETECTOR 154 and 156: guards that run before a part request is cancelled.
function setup(request: any, opts: { costStatus?: string; w3?: { moved: boolean } | null } = {}) {
  const manager: any = {
    query: vi.fn(async (sql: string) => (sql.includes('warehouse_delivery_cohorts') && opts.w3 ? [opts.w3] : [])),
    findOne: vi.fn(async (entity: any, options: any) =>
      entity === AdditionalCostRequest && opts.costStatus && options.where.status === opts.costStatus && options.where.id === request.additionalCostId
        ? { id: request.additionalCostId, status: opts.costStatus } : null),
    save: vi.fn(async (_entity: any, value: any) => value),
  };
  const audit: any = { logWithManager: vi.fn(async () => undefined) };
  const service = new PartRequestsService({ transaction: (run: any) => run(manager) } as any, {} as any, {} as any, {} as any, audit,
    { createNotification: async () => undefined } as any);
  (service as any).lockRequest = vi.fn(async () => ({ request, order: { id: 'order' } }));
  return { service, manager };
}
const tech = { id: 'tech', role: Role.TECHNICIAN };
const additional = (over: any = {}) => ({ id: 'pr', serviceOrderId: 'order', technicianId: 'tech', status: 'requested', requestType: 'additional',
  additionalCostId: 'cost', quotationId: null, receivedAt: null, items: [], ...over });

describe('cancelPartRequest guards', () => {
  it.each([Role.TECHNICIAN, Role.SERVICE_MANAGER])('BUG 154: blocks %s from cancelling parts of an approved additional cost', async role => {
    const request = additional();
    const s = setup(request, { costStatus: 'approved' });
    await expect(s.service.cancelPartRequest('pr', { id: role === Role.TECHNICIAN ? 'tech' : 'manager', role }))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining('phát sinh') });
    expect(request.status).toBe('requested');
    expect(s.manager.save).not.toHaveBeenCalled();
  });

  it('BUG 154: still lets the technician drop a request whose additional cost is not approved', async () => {
    const s = setup(additional(), { costStatus: 'approved' });
    s.manager.findOne.mockResolvedValue(null);
    expect(await s.service.cancelPartRequest('pr', tech)).toMatchObject({ status: 'cancelled' });
  });

  it('BUG 156: answers 409 in Vietnamese once a W3 parcel has left the warehouse', async () => {
    const request = additional({ requestType: 'pre_repair', additionalCostId: null });
    const s = setup(request, { w3: { moved: true } });
    await expect(s.service.cancelPartRequest('pr', tech)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('không thể hủy') });
    expect(s.manager.save).not.toHaveBeenCalled();
  });

  it('BUG 156: a W3 request still waiting at the warehouse can be cancelled', async () => {
    const s = setup(additional({ requestType: 'pre_repair', additionalCostId: null }), { w3: { moved: false } });
    expect(await s.service.cancelPartRequest('pr', tech)).toMatchObject({ status: 'cancelled' });
  });

  it('answers a closed state in Vietnamese', async () => {
    const s = setup(additional({ requestType: 'pre_repair', additionalCostId: null, status: 'received' }));
    await expect(s.service.cancelPartRequest('pr', { id: 'manager', role: Role.SERVICE_MANAGER }))
      .rejects.toMatchObject({ message: 'Không thể hủy yêu cầu linh kiện ở trạng thái hiện tại.' });
  });
});
