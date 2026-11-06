import { describe, expect, it, vi } from 'vitest';
import { Role } from '../../shared/enums';
import { WarrantyClaimReadService } from './warranty-claim-read.service';
import { WarrantyNotifier } from './warranty-notifier.service';

const claim = {
  id: 'claim-1',
  serviceOrderId: 'order-1',
  warrantyCoverageId: 'cov-1',
  status: 'accepted',
  description: 'Vòi nước rò rỉ',
  evidenceRefs: null,
  submittedAfterExpiry: false,
  customerResponse: null,
  awaitingPrompt: null,
  resolutionNotes: null,
  submittedAt: new Date('2026-09-29T08:00:00.000Z'),
  resolvedAt: null,
  technician: { id: 'tech-1', fullName: 'Kỹ thuật viên A', phoneNumber: '0900', passwordHash: 'x' },
} as any;

const MANAGER = (invoices: unknown[] = [], requests: unknown[] = []) => ({
  find: vi.fn(async (entity: { name: string }) => (entity.name === 'Invoice' ? invoices : entity.name === 'PartRequest' ? requests : [])),
});

describe('WarrantyClaimReadService', () => {
  it('joins order, customer, coverage and the latest visit without leaking technician contact data', async () => {
    const repos = {
      order: {
        find: vi.fn().mockResolvedValue([{ id: 'order-1', code: 'SO-1', bookingId: 'booking-1' }]),
        manager: MANAGER([{ id: 'inv-1', serviceOrderId: 'order-1' }], [{
          id: 'pr-1', warrantyClaimId: 'claim-1', status: 'received', faultyReturnDueAt: new Date('2026-11-12T00:00:00.000Z'), faultyReturnedAt: null,
          faultyReturnChargedAt: null, faultyInspectionResult: null, chargeTechnician: false,
        }]),
      },
      booking: {
        find: vi.fn().mockResolvedValue([
          { id: 'booking-1', customerId: 'customer-1', serviceNameSnapshot: 'Sửa đường nước', addressTextSnapshot: '12 Lê Lợi' },
        ]),
      },
      user: { find: vi.fn().mockResolvedValue([{ id: 'customer-1', fullName: 'Khách A', phoneNumber: '0911' }]) },
      coverage: {
        find: vi.fn().mockResolvedValue([{ id: 'cov-1', note: 'Vòi sen', expiresAt: new Date('2026-10-30T00:00:00.000Z') }]),
      },
      invoiceItem: { find: vi.fn(async (query: any) => (query?.where?.invoiceId ? [
        { id: 'part-1', invoiceId: 'inv-1', description: 'Tụ khởi động', quantity: 2, partSource: 'fixhome' },
        { id: 'part-2', invoiceId: 'inv-other', description: 'Của đơn khác', quantity: 1, partSource: 'fixhome' },
      ] : [])) },
      visit: {
        find: vi.fn().mockResolvedValue([
          { id: 'visit-new', warrantyClaimId: 'claim-1', status: 'checked_in', createdAt: new Date('2026-09-30') },
          { id: 'visit-old', warrantyClaimId: 'claim-1', status: 'cancelled', createdAt: new Date('2026-09-29') },
        ]),
      },
    };
    const service = new WarrantyClaimReadService(
      repos.order as any,
      repos.booking as any,
      repos.user as any,
      repos.coverage as any,
      repos.visit as any,
      repos.invoiceItem as any,
    );

    const [view] = await service.toStaffViews([claim]);

    expect(view.order).toEqual({
      id: 'order-1',
      code: 'SO-1',
      bookingId: 'booking-1',
      serviceName: 'Sửa đường nước',
      addressSummary: '12 Lê Lợi',
      customerName: 'Khách A',
      customerPhone: '0911',
      partLines: [{ id: 'part-1', name: 'Tụ khởi động', quantity: 2, partSource: 'fixhome' }],
    });
    expect(view.partRequest).toEqual({
      id: 'pr-1', status: 'received', faultyReturnDueAt: new Date('2026-11-12T00:00:00.000Z'), faultyReturnedAt: null,
      faultyReturnChargedAt: null, faultyInspectionResult: null, chargeTechnician: false,
    });
    expect(view.coverage).toMatchObject({ id: 'cov-1', itemDescription: 'Vòi sen' });
    expect(view.visit?.id).toBe('visit-new');
    expect(view.technician).toEqual({ id: 'tech-1', fullName: 'Kỹ thuật viên A' });
    expect(JSON.stringify(view)).not.toContain('passwordHash');
    expect(JSON.stringify(view)).not.toContain('0900');
  });

  it('names the covered item after its invoice line, so the manager and the technician see what is claimed', async () => {
    const find = (rows: unknown[]) => ({ find: vi.fn().mockResolvedValue(rows) });
    const service = new WarrantyClaimReadService(
      { ...find([{ id: 'order-1', code: 'SO-1', bookingId: 'booking-1' }]), manager: MANAGER() } as any,
      find([{ id: 'booking-1', customerId: 'customer-1' }]) as any,
      find([{ id: 'customer-1', fullName: 'Khách A' }]) as any,
      find([
        { id: 'cov-line', invoiceItemId: 'line-2', note: null, expiresAt: new Date() },
        { id: 'cov-note', invoiceItemId: null, note: 'Ghi chú cũ', expiresAt: new Date() },
        { id: 'cov-none', invoiceItemId: null, note: null, expiresAt: new Date() },
      ]) as any,
      find([]) as any,
      find([{ id: 'line-2', description: 'Board X' }]) as any,
    );
    const claim = (coverageId: string) => ({ id: `c-${coverageId}`, serviceOrderId: 'order-1', warrantyCoverageId: coverageId, technician: null, status: 'submitted', submittedAt: new Date() }) as any;

    const views = await service.toStaffViews([claim('cov-line'), claim('cov-note'), claim('cov-none')]);

    expect(views.map((v) => v.coverage?.itemDescription)).toEqual(['Board X', 'Ghi chú cũ', 'Bảo hành dịch vụ']);
  });

  it('returns nothing without querying when there are no claims', async () => {
    const find = vi.fn();
    const service = new WarrantyClaimReadService({ find } as any, { find } as any, { find } as any, { find } as any, { find } as any, { find } as any);
    expect(await service.toStaffViews([])).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });
});

describe('WarrantyNotifier', () => {
  it('notifies every service manager and swallows a delivery failure', async () => {
    const userRepo = { find: vi.fn().mockResolvedValue([{ id: 'sm-1' }, { id: 'sm-2' }]) };
    const notifications = { createManyNotifications: vi.fn().mockResolvedValue([]), createNotification: vi.fn() };
    const notifier = new WarrantyNotifier(userRepo as any, notifications as any);

    await notifier.toManagers('Tiêu đề', 'Nội dung', 'WARRANTY_PROPOSAL_READY', 'order-1');
    expect(userRepo.find).toHaveBeenCalledWith({ where: { role: Role.SERVICE_MANAGER }, select: ['id'] });
    expect(notifications.createManyNotifications).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'sm-1', type: 'WARRANTY_PROPOSAL_READY', referenceId: 'order-1' }),
      expect.objectContaining({ userId: 'sm-2' }),
    ]);

    notifications.createNotification.mockRejectedValueOnce(new Error('down'));
    await expect(notifier.toUser('user-1', 'a', 'b', 'T', 'order-1')).resolves.toBeUndefined();
    await expect(notifier.toUser(null, 'a', 'b', 'T', 'order-1')).resolves.toBeUndefined();
    expect(notifications.createNotification).toHaveBeenCalledTimes(1);
  });

  it('does nothing when notifications are not available', async () => {
    const notifier = new WarrantyNotifier({ find: vi.fn() } as any);
    await expect(notifier.toUser('user-1', 'a', 'b', 'T', 'order-1')).resolves.toBeUndefined();
    await expect(notifier.toManagers('a', 'b', 'T', 'order-1')).resolves.toBeUndefined();
  });
});
