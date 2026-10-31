import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { Role, ServiceOrderStatus } from '../../shared/enums';

vi.mock('./order-access', () => ({ authorizeOrder: vi.fn(async (m: any, id: string) => m.findOneByOrFail(ServiceOrder, { id })) }));
vi.mock('./overrun-release', async (orig) => ({
  ...(await orig<typeof import('./overrun-release')>()),
  checkOverrunRelease: vi.fn(async () => ({ eligible: true, block: null, currentOrderCode: 'SO-1', windowMinutes: 180 })),
}));
import { checkOverrunRelease } from './overrun-release';

const customer = { id: 'cus-1', role: Role.CUSTOMER };
const tech = { id: 'tech-1', role: Role.TECHNICIAN };

function build(order: Partial<ServiceOrder>) {
  const row = { id: 'o-1', code: 'SO-2', bookingId: 'b-1', status: ServiceOrderStatus.ACCEPTED, ...order } as ServiceOrder;
  const manager = {
    findOneOrFail: vi.fn(async () => ({ id: 'b-1', customerId: 'cus-1' })),
    findOneByOrFail: vi.fn(async () => row),
    findOneBy: vi.fn(async (entity: unknown) => (entity === TechnicianAssignment ? { technicianId: 'tech-1' } : null)),
    update: vi.fn(async (_e: unknown, _w: unknown, patch: Partial<ServiceOrder>) => { Object.assign(row, patch); }),
  };
  const notify = vi.fn();
  const service = Object.create(ServiceOrdersService.prototype) as any;
  service.dataSource = { manager, transaction: (fn: (m: unknown) => unknown) => fn(manager) };
  service.configService = { getInt: vi.fn(async () => 180) };
  service.auditLogService = { logWithManager: vi.fn() };
  service.notificationsService = { createNotification: notify };
  service.releaseCheckedOrder = vi.fn(async () => ({ order: row, currentOrderCode: 'SO-1' }));
  service.cancelLocked = vi.fn(async () => row);
  return { service: service as ServiceOrdersService & Record<string, any>, manager, row, notify };
}

describe('delay notice', () => {
  it('rejects minutes outside 30/60/90/120 before touching anything', async () => {
    const { service, manager } = build({});
    await expect(service.sendDelayNotice('o-1', 45, tech)).rejects.toThrow('không hợp lệ');
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('stores the notice and tells the customer once; a retry of the same notice does neither', async () => {
    const { service, manager, row, notify } = build({});
    await service.sendDelayNotice('o-1', 60, tech);
    expect(row).toMatchObject({ delayNoticeMinutes: 60, delayDecision: null });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ userId: 'cus-1', type: 'TECHNICIAN_DELAY_NOTICE' });
    await service.sendDelayNotice('o-1', 60, tech);
    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('refuses a notice when the technician is not overrunning', async () => {
    vi.mocked(checkOverrunRelease).mockResolvedValueOnce({ eligible: false, block: 'NO_CURRENT_JOB', currentOrderCode: null, windowMinutes: 180 });
    const { service, notify } = build({});
    await expect(service.sendDelayNotice('o-1', 30, tech)).rejects.toThrow('đang làm đơn khác');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('delay decision', () => {
  const noticed = { delayNoticeMinutes: 60, delayNoticedAt: new Date(), delayDecision: null } as Partial<ServiceOrder>;

  it('needs a notice first', async () => {
    const { service } = build({});
    await expect(service.decideDelay('o-1', 'wait', customer)).rejects.toThrow('chưa báo trễ');
  });

  it('wait only records the answer and tells the technician', async () => {
    const { service, row, notify } = build(noticed);
    await service.decideDelay('o-1', 'wait', customer);
    expect(row.delayDecision).toBe('wait');
    expect(service['releaseCheckedOrder']).not.toHaveBeenCalled();
    expect(service['cancelLocked']).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toMatchObject({ userId: 'tech-1' });
  });

  it('switch runs the release as the technician, without points for anyone', async () => {
    const { service, row } = build(noticed);
    await service.decideDelay('o-1', 'switch', customer);
    expect(row.delayDecision).toBe('switch');
    expect(service['releaseCheckedOrder']).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { id: 'tech-1', role: Role.TECHNICIAN }, 'SO-1');
  });

  it('cancel waives the customer penalty', async () => {
    const { service, row } = build(noticed);
    await service.decideDelay('o-1', 'cancel', customer);
    expect(row.delayDecision).toBe('cancel');
    const call = vi.mocked(service['cancelLocked']).mock.calls[0];
    expect(call[4]).toBe(customer);
    expect(call[6]).toBe(true);
  });

  it('answers only once; the same answer again is a no-op, a different one is refused', async () => {
    const { service, manager } = build({ ...noticed, delayDecision: 'wait' });
    await service.decideDelay('o-1', 'wait', customer);
    expect(manager.update).not.toHaveBeenCalled();
    await expect(service.decideDelay('o-1', 'cancel', customer)).rejects.toThrow('đã trả lời');
  });

  it('refuses once the technician has arrived or the order left the waiting states', async () => {
    vi.mocked(checkOverrunRelease).mockResolvedValueOnce({ eligible: false, block: 'ALREADY_ARRIVED', currentOrderCode: null, windowMinutes: 180 });
    const { service, row } = build(noticed);
    await expect(service.decideDelay('o-1', 'switch', customer)).rejects.toThrow('không còn ở trạng thái chờ');
    expect(row.delayDecision).toBeNull();
  });
});
