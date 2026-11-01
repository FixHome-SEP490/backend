import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ServiceOrdersService } from './service-orders.service';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { ArrivalCheckIn } from './entities/arrival-check-in.entity';
import { RepairEvidence } from './entities/repair-evidence.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { OrderEvidenceStorage } from '../media/order-evidence-storage.service';
import { CheckInResult, EvidenceType, Role, ServiceOrderStatus, ServicePricingMode } from '../../shared/enums';

const technician = { id: 'tech-1', role: Role.TECHNICIAN };
const photo = { buffer: Buffer.from([255, 216, 255]), mimetype: 'image/jpeg', size: 3 };

function setup() {
  const order = { id: 'order', bookingId: 'booking', code: 'FH-TEST', status: ServiceOrderStatus.EN_ROUTE, completionRequestedAt: null as Date | null };
  const booking = { pricingModeSnapshot: ServicePricingMode.FIXED_PRICE, fixedUnitPriceSnapshot: 100000 };
  const assignment = { technicianId: technician.id, isActive: true, assignedAt: new Date('2026-10-01T01:00:00Z') };
  const arrival = { result: CheckInResult.VALID, checkedInAt: new Date('2026-10-01T02:00:00Z') };
  const evidence = [{ type: EvidenceType.CHECKIN_FACE, uploaderId: technician.id }] as RepairEvidence[];
  let approvedQuotation = false;
  const manager = {
    findOne: vi.fn(async (entity): Promise<any> => entity === ServiceOrder ? order : null),
    findOneBy: vi.fn(async (entity, where) => {
      if (entity === TechnicianAssignment) return assignment.isActive && (!where.technicianId || where.technicianId === assignment.technicianId) ? assignment : null;
      if (entity === ArrivalCheckIn) return arrival.result === where.result ? arrival : null;
      if (entity === RepairEvidence) return evidence.find(item => item.type === where.type && item.uploaderId === where.uploaderId) ?? null;
      if (entity === Quotation) return approvedQuotation ? { id: 'quote' } : null;
      return null;
    }),
    findOneByOrFail: vi.fn(async entity => entity === Booking ? booking : order),
    count: vi.fn(async (entity, { where }) => entity === RepairEvidence
      ? evidence.filter(item => item.type === where.type && (!where.uploaderId || item.uploaderId === where.uploaderId)).length : 0),
    create: vi.fn((_entity, value) => value),
    save: vi.fn(async (_entity, value) => { evidence.push(value); return value; }),
    update: vi.fn(async (entity, _where, value) => { if (entity === ServiceOrder) Object.assign(order, value); }),
    insert: vi.fn(),
  };
  const storage = {
    validate: vi.fn((file) => new OrderEvidenceStorage(null).validate(file)),
    upload: vi.fn(async () => `cloudinary://evidence/test-${evidence.length}`),
    delete: vi.fn(),
  };
  const service = Object.assign(Object.create(ServiceOrdersService.prototype), {
    dataSource: { manager, transaction: async work => work(manager) },
    orderRepo: { findOneBy: vi.fn(async () => order) },
    evidenceStorage: storage,
    configService: { getInt: vi.fn(async (_key, fallback) => fallback) },
    auditLogService: { logWithManager: vi.fn() },
    notifyCustomerForOrder: vi.fn(),
  }) as ServiceOrdersService;
  return { service, manager, storage, order, booking, arrival, assignment, evidence, approveQuotation: () => { approvedQuotation = true; } };
}

describe('onsite ADDITIONAL evidence', () => {
  it.each([ServiceOrderStatus.EN_ROUTE, ServiceOrderStatus.UNDER_REPAIR])('accepts private evidence at %s without starting repair or requiring BEFORE/face photos', async status => {
    const f = setup(); f.order.status = status; f.evidence.length = 0;
    expect(await f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).toMatchObject({
      type: EvidenceType.ADDITIONAL, uploaderId: technician.id, mediaUrl: expect.stringMatching(/^cloudinary:\/\/evidence\//),
    });
    expect(f.order.status).toBe(status);
    expect(f.manager.update).not.toHaveBeenCalled();
    const orderReads = f.manager.findOne.mock.calls.filter(([entity]) => entity === ServiceOrder);
    expect(orderReads).toHaveLength(2);
    for (const [, options] of orderReads as any[]) expect(options.lock.mode).toBe('pessimistic_write');
  });

  it.each([CheckInResult.LOW_ACCURACY, CheckInResult.OUT_OF_GEOFENCE])('rejects invalid onsite GPS: %s', async result => {
    const f = setup(); f.arrival.result = result;
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).rejects.toThrow('Valid arrival required');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it.each(['stale', 'future', 'missing'])('rejects %s check-in for the current assignment', async timing => {
    const f = setup();
    f.arrival.checkedInAt = timing === 'stale' ? new Date('2026-09-30T01:00:00Z') : timing === 'future' ? new Date(Date.now() + 60000) : null;
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).rejects.toThrow('Valid arrival required');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it.each(['assignment', 'completion', 'gps', 'stop'])('rechecks %s after upload and removes rejected media', async changed => {
    const f = setup();
    f.storage.upload.mockImplementationOnce(async () => {
      if (changed === 'assignment') f.assignment.isActive = false;
      if (changed === 'completion') f.order.completionRequestedAt = new Date();
      if (changed === 'gps') f.arrival.result = CheckInResult.OUT_OF_GEOFENCE;
      if (changed === 'stop') f.manager.findOne.mockImplementation(async entity => entity === ServiceOrder ? f.order : { action: 'TECHNICIAN_ONSITE_STOP_FINALIZED' });
      return 'cloudinary://evidence/raced';
    });
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).rejects.toThrow();
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.storage.delete).toHaveBeenCalledWith('cloudinary://evidence/raced');
  });

  it.each([ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED])('rejects timing at %s', async status => {
    const f = setup(); f.order.status = status;
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).rejects.toThrow('Evidence timing');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it.each([{ id: 'other-tech', role: Role.TECHNICIAN }, { id: technician.id, role: Role.CUSTOMER }])('denies wrong actor %j', async actor => {
    const f = setup();
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, actor, photo)).rejects.toMatchObject({ status: 403 });
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it('preserves MIME validation and storage 503 without saving evidence', async () => {
    const f = setup();
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, { ...photo, mimetype: 'text/plain' })).rejects.toMatchObject({ status: 400 });
    f.storage.upload.mockRejectedValueOnce(new ServiceUnavailableException('Private evidence upload failed'));
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).rejects.toMatchObject({ status: 503 });
    expect(f.manager.save).not.toHaveBeenCalled();
  });

  it('rejects completion and evidence limit before uploading', async () => {
    const f = setup(); f.order.completionRequestedAt = new Date();
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).rejects.toThrow('Evidence timing');
    f.order.completionRequestedAt = null;
    for (let i = 0; i < 20; i++) f.evidence.push({ type: EvidenceType.ADDITIONAL } as RepairEvidence);
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.ADDITIONAL }, technician, photo)).rejects.toThrow('Evidence limit');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });
});

describe('BEFORE evidence sequencing', () => {
  it('saves multiple BEFORE photos on a fixed-price job, then auto-starts only after the final upload', async () => {
    const f = setup();
    const body = { type: EvidenceType.BEFORE, deferAutoStart: true, capturedAt: '2026-10-08T16:49:00Z', note: 'Camera photo' };
    for (let index = 0; index < 2; index++) {
      expect(await f.service.uploadEvidence('order', body, technician, photo)).toMatchObject({ type: EvidenceType.BEFORE, note: body.note, capturedAt: new Date(body.capturedAt) });
      expect(f.order.status).toBe(ServiceOrderStatus.EN_ROUTE);
      expect(f.manager.update).not.toHaveBeenCalled();
    }
    await f.service.uploadEvidence('order', { ...body, deferAutoStart: false }, technician, photo);
    expect(f.evidence.filter(item => item.type === EvidenceType.BEFORE)).toHaveLength(3);
    expect(f.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
    expect(f.manager.insert).toHaveBeenCalledTimes(1);
    expect(f.storage.upload).toHaveBeenCalledWith('order', technician.id, photo, '08/10/2026 23:49 · FH-TEST');
  });

  it('keeps legacy uploads auto-starting after the first BEFORE photo', async () => {
    const f = setup();
    await f.service.uploadEvidence('order', { type: EvidenceType.BEFORE }, technician, photo);
    expect(f.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
  });

  it('still requires the approved quotation for inspection jobs', async () => {
    const f = setup();
    f.booking.pricingModeSnapshot = ServicePricingMode.INSPECTION_REQUIRED;
    await f.service.uploadEvidence('order', { type: EvidenceType.BEFORE }, technician, photo);
    expect(f.order.status).toBe(ServiceOrderStatus.EN_ROUTE);
    f.approveQuotation();
    expect(await f.service.autoStartRepair('order')).toBe(true);
    expect(f.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
  });

  it.each([CheckInResult.LOW_ACCURACY, CheckInResult.OUT_OF_GEOFENCE])('requires valid GPS even when auto-start is deferred (%s)', async result => {
    const f = setup();
    f.arrival.result = result;
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true }, technician, photo)).rejects.toThrow('Valid arrival required');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it('requires the current technician face photo before deferred BEFORE uploads', async () => {
    const f = setup();
    f.evidence[0].uploaderId = 'previous-tech';
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true }, technician, photo)).rejects.toThrow('check-in');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it.each([ServiceOrderStatus.ACCEPTED, ServiceOrderStatus.UNDER_REPAIR, ServiceOrderStatus.COMPLETED, ServiceOrderStatus.CANCELLED])('rejects deferred BEFORE at %s', async status => {
    const f = setup();
    f.order.status = status;
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true }, technician, photo)).rejects.toThrow('Evidence timing');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it.each([{ id: 'other-tech', role: Role.TECHNICIAN }, { id: technician.id, role: Role.CUSTOMER }])('preserves ownership and technician permission for %j', async actor => {
    const f = setup();
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true }, actor, photo)).rejects.toThrow('access denied');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it('enforces 20 photos and supports the existing start action if every upload was deferred', async () => {
    const f = setup();
    for (let index = 0; index < 19; index++) await f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true }, technician, photo);
    expect(f.order.status).toBe(ServiceOrderStatus.EN_ROUTE);
    f.storage.upload.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE }, technician, photo)).rejects.toThrow('Storage unavailable');
    expect(f.order.status).toBe(ServiceOrderStatus.EN_ROUTE);
    await f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true }, technician, photo);
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE }, technician, photo)).rejects.toThrow('Evidence limit');
    expect(await f.service.autoStartRepair('order')).toBe(true);
    expect(f.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
  });

  it('revalidates after storage upload and deletes the object if repair started meanwhile', async () => {
    const f = setup();
    f.storage.upload.mockImplementationOnce(async () => { f.order.status = ServiceOrderStatus.UNDER_REPAIR; return 'cloudinary://evidence/raced'; });
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true }, technician, photo)).rejects.toThrow('Evidence timing');
    expect(f.manager.save).not.toHaveBeenCalled();
    expect(f.storage.delete).toHaveBeenCalledWith('cloudinary://evidence/raced');
  });

  it('does not accept future capture timestamps', async () => {
    const f = setup();
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.BEFORE, deferAutoStart: true, capturedAt: new Date(Date.now() + 60000).toISOString() }, technician, photo)).rejects.toThrow('timestamp');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it.each([EvidenceType.AFTER, EvidenceType.ADDITIONAL, EvidenceType.CHECKIN_FACE])('rejects deferAutoStart for %s', async type => {
    const f = setup();
    if (type !== EvidenceType.CHECKIN_FACE) f.order.status = ServiceOrderStatus.UNDER_REPAIR;
    await expect(f.service.uploadEvidence('order', { type, deferAutoStart: true }, technician, photo)).rejects.toThrow('deferAutoStart');
    expect(f.storage.upload).not.toHaveBeenCalled();
  });

  it('allows multiple AFTER uploads without requesting completion, then rejects uploads once completion is requested', async () => {
    const f = setup();
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.AFTER }, technician, photo)).rejects.toThrow('Evidence timing');
    await f.service.uploadEvidence('order', { type: EvidenceType.BEFORE }, technician, photo);
    await f.service.uploadEvidence('order', { type: EvidenceType.AFTER }, technician, photo);
    await f.service.uploadEvidence('order', { type: EvidenceType.AFTER }, technician, photo);
    expect(f.order.completionRequestedAt).toBeNull();
    expect(f.evidence.filter(item => item.type === EvidenceType.AFTER)).toHaveLength(2);
    f.order.completionRequestedAt = new Date();
    await expect(f.service.uploadEvidence('order', { type: EvidenceType.AFTER }, technician, photo)).rejects.toThrow('Evidence timing');
  });
});
