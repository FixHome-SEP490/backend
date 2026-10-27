import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { Booking } from './entities/booking.entity';
import { InvitationsService } from './invitations.service';
import { BookingStatus, Role, ServiceOrderStatus, SupportCaseType } from '../../shared/enums';

function fixture(outcomes = ['succeeded', 'failed', 'succeeded'], solo = false) {
  const rows: Record<string, any[]> = {
    Booking: outcomes.map((_outcome, i) => ({ id: `booking-${i}`, customerId: 'customer', serviceId: 'service', visitGroupId: solo ? null : 'group', addressId: 'address', status: BookingStatus.CANCELLED,
      description: `Device ${i}`, deviceAttributesSnapshot: { brand: 'TEST' }, customerNote: 'Private customer note', catalogV2PricingSnapshot: { selectedVariant: { variantCode: 'AC-02-01', laborPriceVnd: 999999 } },
      preferredStartAt: new Date(0), slot: 'morning', fixedUnitPriceSnapshot: 999999, quantity: 1,
    })),
    VisitGroupItem: outcomes.map((outcome, i) => ({ groupId: 'group', bookingId: `booking-${i}`, outcome, sequence: i + 1, deviceLabel: `Device ${i}` })),
    ServiceOrder: outcomes.map((_outcome, i) => ({ id: `order-${i}`, bookingId: `booking-${i}`, status: ServiceOrderStatus.CANCELLED })),
    SupportCase: outcomes.map((_outcome, i) => ({ id: `incident-${i}`, bookingId: `booking-${i}`, serviceOrderId: `order-${i}`, caseType: SupportCaseType.MID_JOB_INTERRUPTION, technicianId: 'tech', createdByUserId: 'tech', customerId: 'customer' })),
    AuditLog: outcomes.flatMap((outcome, i) => outcome === 'failed' ? [{ action: 'VISIT_DEVICE_REPAIR_FAILED', resourceType: 'service_order', resourceId: `order-${i}`, actorUserId: 'tech', actorRole: Role.TECHNICIAN,
      after: { version: 1, incidentId: `incident-${i}`, request: { reason: 'other', note: null, parts: [], photoEvidenceIds: [] } } }] : []),
    Address: [{ id: 'address', userId: 'customer', line1: 'Test address', district: 'Test district', province: 'Test province' }],
    Service: [{ id: 'service', isActive: true }],
    BookingMedia: [{ id: 'photo', bookingId: 'booking-1', privateUploadId: 'upload', mimeType: 'image/jpeg' }, { id: 'legacy', bookingId: 'booking-1', url: 'https://example.com/unsafe.jpg' }],
    PrivateBookingPhotoUpload: [{ id: 'upload', claimedBookingId: 'booking-1', ownerUserId: 'customer', mimeType: 'image/jpeg', objectRef: 'private-reference' }],
  };
  const matches = (row: any, where: any): boolean => Object.entries(where ?? {}).every(([key, value]) => value instanceof FindOperator
    ? value.type === 'in' ? value.value.includes(row[key])
      : value.type === 'like' ? typeof row[key] === 'string' && row[key].startsWith(String(value.value).replace(/%$/, ''))
        : row[key] !== value.value
    : row[key] === value);
  const find = vi.fn(async (entity: any, options: any) => (rows[entity.name] ?? []).filter(row => matches(row, options?.where)));
  const manager = { find, findOne: vi.fn(async (entity: any, options: any) => (rows[entity.name] ?? []).find(row => matches(row, options.where)) ?? null), findOneBy: vi.fn(async (entity: any, where: any) => (rows[entity.name] ?? []).find(row => matches(row, where)) ?? null), insert: vi.fn(), update: vi.fn(), save: vi.fn() };
  const service = Object.assign(Object.create(BookingsService.prototype), { dataSource: { manager } }) as BookingsService;
  return { rows, manager, service, customer: { id: 'customer', role: Role.CUSTOMER } };
}

describe('repair-failure draft contract', () => {
  it('returns only B from A+/B-/C+, safe form fields and original private read references without creating anything', async () => {
    const { service, customer, manager } = fixture();
    const result = await (service as any).repairFailureDraft('booking-1', customer);
    expect(result.targetKind).toBe('booking');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ sourceBookingId: 'booking-1', sourceIncidentId: 'incident-1', serviceId: 'service', selectedVariantCode: 'AC-02-01', description: 'Device 1', deviceAttributes: { brand: 'TEST' } });
    expect(result.items[0].photos).toEqual([{ mediaId: 'photo', sourceBookingId: 'booking-1', contentPath: '/api/v1/bookings/booking-1/media/photo/content' }]);
    expect(result.address.id).toBe('address');
    expect(result.customerNote).toBe('Private customer note');
    for (const key of ['preferredStartAt', 'slot', 'fixedUnitPriceSnapshot', 'technicianId', 'payment', 'quotation', 'photoUploadIds']) expect(result.items[0]).not.toHaveProperty(key);
    expect(JSON.stringify(result)).not.toContain('999999');
    expect(manager.insert).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])('routes %i failed devices to the correct new booking type, including a failed lead', async count => {
    const { service, customer } = fixture(Array(count).fill('failed'));
    const result = await (service as any).repairFailureDraft('booking-0', customer);
    expect(result.items).toHaveLength(count);
    expect(result.targetKind).toBe(count === 1 ? 'booking' : 'visit_group');
      expect(result.confirmation).toEqual({ available: true, path: '/api/v1/bookings/booking-0/repair-failure-rebook' });
  });

  it('accepts a solo structured incident independently of VisitGroup outcomes', async () => {
    const { service, customer } = fixture(['failed'], true);
    expect((await (service as any).repairFailureDraft('booking-0', customer)).targetKind).toBe('booking');
  });

  it('does not offer an already consumed failed source in a fresh draft', async () => {
    const { service, customer, rows } = fixture();
    rows.RepairFailureRebookSource = [{ sourceBookingId: 'booking-1' }];
    await expect(service.repairFailureDraft('booking-1', customer)).rejects.toThrow();
  });

  it('does not offer a partly consumed failed visit from another failed sibling anchor', async () => {
    const { service, customer, rows } = fixture(['failed', 'failed', 'succeeded']);
    rows.RepairFailureRebookSource = [{ sourceBookingId: 'booking-1' }];
    await expect(service.repairFailureDraft('booking-0', customer)).rejects.toThrow();
  });

  it.each([Role.ADMIN, Role.SERVICE_MANAGER, Role.TECHNICIAN])('rejects noncustomer role %s', async role => {
    const { service } = fixture();
    await expect((service as any).repairFailureDraft('booking-1', { id: 'customer', role })).rejects.toThrow();
  });

  it.each(['foreign customer', 'generic cancelled', 'successful child', 'missing incident', 'inconsistent outcome', 'inactive service', 'foreign media', 'malformed receipt', 'duplicate receipt', 'foreign incident owner'])('fails closed or excludes unsafe data: %s', async issue => {
    const { service, customer, rows } = fixture();
    if (issue === 'foreign customer') customer.id = 'foreign';
    if (issue === 'generic cancelled') rows.AuditLog = [];
    if (issue === 'missing incident') rows.SupportCase = [];
    if (issue === 'inconsistent outcome') rows.VisitGroupItem[1].outcome = 'quote_declined';
    if (issue === 'inactive service') rows.Service[0].isActive = false;
    if (issue === 'malformed receipt') rows.AuditLog[0].after.request = { reason: 'unknown' };
    if (issue === 'duplicate receipt') rows.AuditLog.push({ ...rows.AuditLog[0] });
    if (issue === 'foreign incident owner') rows.SupportCase[1].customerId = 'foreign';
    if (issue === 'foreign media') {
      rows.PrivateBookingPhotoUpload[0].ownerUserId = 'foreign';
      expect((await (service as any).repairFailureDraft('booking-1', customer)).items[0].photos).toEqual([]);
    } else {
      await expect((service as any).repairFailureDraft(issue === 'successful child' ? 'booking-0' : 'booking-1', customer)).rejects.toThrow();
    }
  });

  it('passes the authenticated actor through the controller without invoking legacy instant rebook', async () => {
    const repairFailureDraft = vi.fn(async () => ({ targetKind: 'booking' }));
    const controller = new BookingsController({ repairFailureDraft } as never, {} as never, {} as never);
    expect(await (controller as any).repairFailureDraft('id', { user: { id: 'customer', role: Role.CUSTOMER } })).toEqual({ data: { targetKind: 'booking' } });
    expect(repairFailureDraft).toHaveBeenCalledWith('id', { id: 'customer', role: Role.CUSTOMER });
  });

  it('blocks the legacy instant route for a failed incident, preventing automatic invitation of its technician', async () => {
    const { service, manager, customer } = fixture();
    Object.assign(service, {
      bookingRepo: { findOneBy: (where: any) => manager.findOneBy(Booking, where) },
      serviceRepo: { findOneBy: async () => ({ isActive: true }) },
    });
    const create = vi.spyOn(service, 'create').mockResolvedValue({ id: 'new' } as never);
    await expect(service.rebook('booking-1', customer, { mode: 'scheduled', date: '2030-10-28', slot: 'morning' })).rejects.toThrow('Báo cáo không sửa được cần đặt lại qua bản nháp riêng.');
    expect(create).not.toHaveBeenCalled();
  });

  it('also blocks legacy instant rebook for an ambiguous solo repair receipt', async () => {
    const { service, manager, customer, rows } = fixture(['failed'], true);
    rows.AuditLog[0].after = { version: 99 };
    Object.assign(service, { bookingRepo: { findOneBy: (where: any) => manager.findOneBy(Booking, where) }, serviceRepo: { findOneBy: async () => ({ isActive: true }) } });
    const create = vi.spyOn(service, 'create').mockResolvedValue({ id: 'new' } as never);
    await expect(service.rebook('booking-0', customer, { mode: 'scheduled', date: '2030-10-28', slot: 'morning' })).rejects.toThrow('Báo cáo không sửa được cần đặt lại qua bản nháp riêng.');
    expect(create).not.toHaveBeenCalled();
  });

  it('blocks solo legacy rebook using the persisted failure transition and incident if its audit receipt is missing', async () => {
    const { service, manager, customer, rows } = fixture(['failed'], true);
    rows.AuditLog = [];
    rows.OrderStatusHistory = [{ serviceOrderId: 'order-0', fromStatus: ServiceOrderStatus.UNDER_REPAIR,
      toStatus: ServiceOrderStatus.CANCELLED, actorRole: Role.TECHNICIAN, actorUserId: 'tech', reason: 'Không sửa được: lỗi máy' }];
    rows.SupportCase[0].reason = 'Không sửa được thiết bị đơn #FH-TEST';
    rows.ServiceOrder[0].code = 'FH-TEST';
    Object.assign(service, { bookingRepo: { findOneBy: (where: any) => manager.findOneBy(Booking, where) },
      serviceRepo: { findOneBy: async () => ({ isActive: true }) } });
    const create = vi.spyOn(service, 'create').mockResolvedValue({ id: 'new' } as never);
    await expect(service.rebook('booking-0', customer, { mode: 'scheduled', date: '2030-10-28', slot: 'morning' })).rejects.toThrow('Báo cáo không sửa được cần đặt lại qua bản nháp riêng.');
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps ordinary solo cancellation eligible for legacy rebook without a failure transition', async () => {
    const { service, manager, customer, rows } = fixture(['failed'], true);
    rows.AuditLog = [];
    rows.OrderStatusHistory = [{ serviceOrderId: 'order-0', fromStatus: ServiceOrderStatus.UNDER_REPAIR,
      toStatus: ServiceOrderStatus.CANCELLED, actorRole: Role.TECHNICIAN, actorUserId: 'tech', reason: 'Ordinary cancellation' }];
    Object.assign(service, { bookingRepo: { findOneBy: (where: any) => manager.findOneBy(Booking, where) },
      serviceRepo: { findOneBy: async () => ({ isActive: true }) } });
    vi.spyOn(service, 'create').mockResolvedValue({ id: 'new' } as never);
    expect((await service.rebook('booking-0', customer, { mode: 'scheduled', date: '2030-10-28', slot: 'morning' })).booking.id).toBe('new');
  });

  it('rejects rescheduling or shortlisting through the failed lead using the existing group command paths', async () => {
    const { service, customer, manager } = fixture(['failed', 'succeeded', 'succeeded']);
    const dataSource = { manager, transaction: (work: any) => work(manager) };
    Object.assign(service, { dataSource });
    const invitations = Object.assign(Object.create(InvitationsService.prototype), { dataSource }) as InvitationsService;
    await expect(service.reschedule('booking-0', { mode: 'scheduled', date: '2030-10-28', slot: 'morning' }, customer, { asVisit: true })).rejects.toThrow('Booking cannot be rescheduled');
    await expect(invitations.createShortlist('booking-0', ['tech'], customer, { asVisit: true })).rejects.toThrow('Booking cannot be shortlisted');
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.save).not.toHaveBeenCalled();
  });
});
