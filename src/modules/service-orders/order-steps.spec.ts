import { describe, expect, it, vi } from 'vitest';
import { evidenceStampText, evidenceStampTransformation } from '../media/order-evidence-storage.service';
import { allowedCaseTypes } from '../support-cases/support-case-policy';
import { Role, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';
import { ServiceOrdersService } from './service-orders.service';

describe('order photos carry the time and the order code (PO 08/10/2026)', () => {
  it('writes Vietnam time and the order code', () => {
    expect(evidenceStampText(new Date('2026-10-08T16:49:00Z'), 'FH-20261008-CAEE5B16')).toBe('08/10/2026 23:49 · FH-20261008-CAEE5B16');
  });
  it('burns white text on a dark band at the bottom right', () => {
    const t = evidenceStampTransformation('x');
    expect(t).toMatchObject({ gravity: 'south_east', color: '#FFFFFF', overlay: { text: 'x' } });
  });
});

describe('"Cần thay đổi thợ" is a technician case on site only', () => {
  it('is offered to the technician while en route or repairing, never to the customer', () => {
    expect(allowedCaseTypes({ role: Role.TECHNICIAN, orderStatus: ServiceOrderStatus.EN_ROUTE })).toContain(SupportCaseType.TECHNICIAN_REPLACEMENT);
    expect(allowedCaseTypes({ role: Role.TECHNICIAN, orderStatus: ServiceOrderStatus.UNDER_REPAIR })).toContain(SupportCaseType.TECHNICIAN_REPLACEMENT);
    expect(allowedCaseTypes({ role: Role.TECHNICIAN, orderStatus: ServiceOrderStatus.ACCEPTED })).not.toContain(SupportCaseType.TECHNICIAN_REPLACEMENT);
    expect(allowedCaseTypes({ role: Role.CUSTOMER, orderStatus: ServiceOrderStatus.EN_ROUTE })).not.toContain(SupportCaseType.TECHNICIAN_REPLACEMENT);
  });
});

describe('repair starts by itself once the order is ready', () => {
  const make = (status: string, assignment: object | null, startRepair: () => Promise<unknown>) =>
    Object.assign(Object.create(ServiceOrdersService.prototype), {
      orderRepo: { findOneBy: vi.fn(async () => ({ id: 'o1', status })) },
      dataSource: { manager: { findOneBy: vi.fn(async () => assignment) } },
      startRepair: vi.fn(startRepair),
    }) as ServiceOrdersService & { startRepair: ReturnType<typeof vi.fn> };

  it('starts the repair as the assigned technician', async () => {
    const s = make(ServiceOrderStatus.EN_ROUTE, { technicianId: 'tech-1' }, async () => ({}));
    expect(await s.autoStartRepair('o1')).toBe(true);
    expect(s.startRepair).toHaveBeenCalledWith('o1', { id: 'tech-1', role: Role.TECHNICIAN });
  });
  it('does nothing when the order is not ready, without raising', async () => {
    expect(await make(ServiceOrderStatus.ACCEPTED, { technicianId: 't' }, async () => ({})).autoStartRepair('o1')).toBe(false);
    expect(await make(ServiceOrderStatus.EN_ROUTE, null, async () => ({})).autoStartRepair('o1')).toBe(false);
    expect(await make(ServiceOrderStatus.EN_ROUTE, { technicianId: 't' }, async () => { throw new Error('quotation not approved'); }).autoStartRepair('o1')).toBe(false);
  });
});

describe('pressing "Bắt đầu sửa" after the repair already started', () => {
  it('returns the order unchanged instead of failing', async () => {
    const order = { id: 'o1', status: ServiceOrderStatus.UNDER_REPAIR };
    const transitionStatus = vi.fn();
    const s = Object.assign(Object.create(ServiceOrdersService.prototype), {
      orderRepo: { findOneBy: vi.fn(async () => order) },
      dataSource: { manager: {} },
      transitionStatus,
    }) as ServiceOrdersService;
    const auth = await import('./order-access');
    const spy = vi.spyOn(auth, 'authorizeOrder').mockResolvedValue(order as never);
    expect(await s.startRepair('o1', { id: 'tech-1', role: Role.TECHNICIAN })).toBe(order);
    expect(transitionStatus).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
