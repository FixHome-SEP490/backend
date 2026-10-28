import { describe, expect, it, vi } from 'vitest';
import { SupportCasesService } from './support-cases.service';
import { Role, ServiceOrderStatus, SupportCaseStatus } from '../../shared/enums';

function setup(ownerId = 'customer-1') {
  const booking = { id: 'booking-1', customerId: ownerId };
  const order = { id: 'order-1', bookingId: booking.id, status: ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: null };
  let current: Record<string, unknown> | null = null;
  const manager = {
    findOne: vi.fn(async (entity: { name: string }, options?: { where?: { customerId?: string } }) => {
      if (entity.name === 'Booking') return options?.where?.customerId === booking.customerId ? booking : null;
      if (entity.name === 'ServiceOrder') return order;
      if (entity.name === 'SupportCase') return current;
      if (entity.name === 'TechnicianAssignment') return { technicianId: 'tech-1' };
      return null;
    }),
    create: vi.fn((_entity: unknown, value: Record<string, unknown>) => ({ ...value })),
    find: vi.fn(async () => []),
    save: vi.fn(async (_entity: unknown, value: Record<string, unknown>) => {
      current = { id: 'case-1', ...value };
      return current;
    }),
    insert: vi.fn(async () => undefined),
  };
  const auditLogService = { logWithManagerStrict: vi.fn(async () => undefined) };
  const service = Object.assign(Object.create(SupportCasesService.prototype), {
    supportCaseRepository: { manager: { transaction: (fn: (m: typeof manager) => unknown) => fn(manager) } },
    auditLogService,
  }) as SupportCasesService;
  return { service, manager, auditLogService, order };
}

describe('customer stop or replace request', () => {
  const actor = { id: 'customer-1', role: Role.CUSTOMER };
  it('creates one targeted hold and returns the same open case on retry', async () => {
    const h = setup();
    const first = await (h.service as any).requestStopOrReplace('order-1', 'Tôi muốn dừng sửa thiết bị này', actor);
    const second = await (h.service as any).requestStopOrReplace('order-1', 'Tôi muốn dừng sửa thiết bị này', actor);
    expect(first).toBe(second);
    expect(first).toMatchObject({ serviceOrderId: 'order-1', status: SupportCaseStatus.OPEN, requestIntent: 'stop_or_replace', holdCompletion: true });
    expect(h.manager.save).toHaveBeenCalledTimes(1);
    expect(h.auditLogService.logWithManagerStrict).toHaveBeenCalledTimes(1);
  });

  it('rejects another customer and a technician before writing', async () => {
    const h = setup();
    await expect((h.service as any).requestStopOrReplace('order-1', 'Tôi muốn dừng sửa thiết bị này', { id: 'other', role: Role.CUSTOMER })).rejects.toThrow();
    await expect((h.service as any).requestStopOrReplace('order-1', 'Tôi muốn dừng sửa thiết bị này', { id: 'tech-1', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(h.manager.save).not.toHaveBeenCalled();
  });

  it('rejects a completion request that already won the order lock', async () => {
    const h = setup();
    h.order.completionRequestedAt = new Date() as never;
    await expect((h.service as any).requestStopOrReplace('order-1', 'Tôi muốn dừng sửa thiết bị này', actor)).rejects.toThrow();
    expect(h.manager.save).not.toHaveBeenCalled();
  });

  it('keeps the customer stop intent UNDER_REPAIR-only even when the technician checked in EN_ROUTE', async () => {
    const h = setup();
    h.order.status = ServiceOrderStatus.EN_ROUTE;
    await expect((h.service as any).requestStopOrReplace('order-1', 'Tôi muốn dừng sửa thiết bị này', actor)).rejects.toThrow();
    expect(h.manager.save).not.toHaveBeenCalled();
  });
});
