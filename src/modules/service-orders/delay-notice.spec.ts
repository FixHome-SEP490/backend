import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ServiceOrdersService } from './service-orders.service';
import { ServiceOrder } from './entities/service-order.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { RepairEvidence } from './entities/repair-evidence.entity';
import { SupportCase } from '../support-cases/entities/support-case.entity';
import { User } from '../users/entities/user.entity';
import { DelayNoticeDto, DelayReportDto } from './dto/delay-notice.dto';
import { Role, ServiceOrderStatus, SupportCaseStatus, SupportCaseType } from '../../shared/enums';

vi.mock('./order-access', () => ({ authorizeOrder: vi.fn(async (m: any, id: string) => m.findOneByOrFail(ServiceOrder, { id })) }));
vi.mock('./overrun-release', async (orig) => ({
  ...(await orig<typeof import('./overrun-release')>()),
  checkOverrunRelease: vi.fn(async () => ({ eligible: true, block: null, currentOrderCode: 'SO-1', currentOrderId: 'cur-1',
    currentOrderStatus: 'under_repair', windowMinutes: 180 })),
}));
import { checkOverrunRelease } from './overrun-release';

const customer = { id: 'cus-1', role: Role.CUSTOMER };
const tech = { id: 'tech-1', role: Role.TECHNICIAN };
const EV = '11111111-1111-4111-8111-111111111111';
const report = { reasonCode: 'new_fault_found', reason: 'Phát sinh lỗi thêm cần thay linh kiện', evidenceIds: [EV], confirm: true } as const;
const notice = (minutes = 60) => ({ ...report, evidenceIds: [...report.evidenceIds], delayMinutes: minutes }) as any;

function build(order: Partial<ServiceOrder> = {}, opts: { photos?: unknown[]; current?: Partial<ServiceOrder> } = {}) {
  const row = { id: 'o-1', code: 'SO-2', bookingId: 'b-1', status: ServiceOrderStatus.ACCEPTED, ...order } as ServiceOrder;
  const current = { id: 'cur-1', code: 'SO-1', status: ServiceOrderStatus.UNDER_REPAIR, completionRequestedAt: null, ...opts.current };
  const photos = opts.photos ?? [{ id: EV, mimeType: 'image/jpeg', mediaUrl: 'cloudinary://evidence/fixhome/evidence/cur-1/tech-1/abc123' }];
  const cases: any[] = [];
  const inserted: any[] = [];
  const manager: any = {
    findOneOrFail: vi.fn(async () => ({ id: 'b-1', customerId: 'cus-1' })),
    findOneByOrFail: vi.fn(async () => row),
    findOneBy: vi.fn(async (entity: unknown, where: any) => {
      if (entity === TechnicianAssignment) return { technicianId: 'tech-1' };
      if (entity === SupportCase) return cases.find(c => c.id === where.id) ?? null;
      return null;
    }),
    findOne: vi.fn(async (entity: unknown, o: any) => {
      if (entity === ServiceOrder) return current;
      if (entity === SupportCase) return cases.find(c => c.id === o.where.id && c.status === o.where.status) ?? null;
      return null;
    }),
    find: vi.fn(async (entity: unknown) => (entity === RepairEvidence ? photos : entity === User ? [{ id: 'sm-1' }] : [])),
    create: vi.fn((_e: unknown, v: unknown) => v),
    save: vi.fn(async (_e: unknown, v: any) => { const c = { id: 'case-1', ...v }; cases.push(c); return c; }),
    insert: vi.fn(async (_e: unknown, rows: any) => { inserted.push(...rows); }),
    update: vi.fn(async (entity: unknown, where: any, patch: any) => {
      if (entity === ServiceOrder) Object.assign(row, patch);
      if (entity === SupportCase) Object.assign(cases.find(c => c.id === (where.id ?? where)) ?? {}, patch);
    }),
  };
  const notify = vi.fn();
  const service = Object.create(ServiceOrdersService.prototype) as any;
  service.dataSource = { manager, transaction: (fn: (m: unknown) => unknown) => fn(manager) };
  service.configService = { getInt: vi.fn(async () => 180) };
  service.auditLogService = { logWithManager: vi.fn() };
  service.notificationsService = { createNotification: notify };
  service.releaseCheckedOrder = vi.fn(async () => ({ order: row, currentOrderCode: 'SO-1' }));
  service.cancelLocked = vi.fn(async () => row);
  return { service: service as ServiceOrdersService & Record<string, any>, manager, row, notify, cases, inserted };
}

describe('delay report input', () => {
  const errors = (plain: object) => validateSync(plainToInstance(DelayNoticeDto, plain), { whitelist: true }).map(e => e.property);
  const good = { ...report, evidenceIds: [EV], delayMinutes: 60 };

  it('accepts a full report', () => expect(errors(good)).toEqual([]));
  it('needs a reason of at least 10 characters', () => expect(errors({ ...good, reason: 'ngắn' })).toContain('reason'));
  it('needs one to three photos', () => {
    expect(errors({ ...good, evidenceIds: [] })).toContain('evidenceIds');
    expect(errors({ ...good, evidenceIds: [EV, EV] })).toContain('evidenceIds');
    expect(errors({ ...good, evidenceIds: ['a', 'b', 'c', 'd'].map((_, i) => `1111111${i}-1111-4111-8111-111111111111`) })).toContain('evidenceIds');
  });
  it('needs the confirmation and a known reason group', () => {
    expect(errors({ ...good, confirm: false })).toContain('confirm');
    expect(errors({ ...good, reasonCode: 'whatever' })).toContain('reasonCode');
  });
  it('release takes the same report without minutes', () =>
    expect(validateSync(plainToInstance(DelayReportDto, report)).length).toBe(0));
});

describe('delay notice', () => {
  it('rejects minutes outside 30/60/90/120 before touching anything', async () => {
    const { service, manager } = build();
    await expect(service.sendDelayNotice('o-1', notice(45), tech)).rejects.toThrow('không hợp lệ');
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('opens a technician_delay case with reason and photos, tells the managers and the customer', async () => {
    const { service, row, notify, cases, inserted } = build();
    await service.sendDelayNotice('o-1', notice(60), tech);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ caseType: SupportCaseType.TECHNICIAN_DELAY, status: SupportCaseStatus.OPEN, serviceOrderId: 'o-1',
      technicianId: 'tech-1', customerId: 'cus-1', reason: report.reason, evidenceRefs: [EV], holdCompletion: false });
    expect(row).toMatchObject({ delayNoticeMinutes: 60, delayReasonCode: 'new_fault_found', delayCurrentOrderId: 'cur-1', delaySupportCaseId: 'case-1', delayDecision: null });
    expect(inserted[0]).toMatchObject({ userId: 'sm-1', type: 'TECHNICIAN_DELAY_REPORTED', referenceType: 'SUPPORT_CASE', referenceId: 'case-1' });
    expect(notify.mock.calls[0][0]).toMatchObject({ userId: 'cus-1', type: 'TECHNICIAN_DELAY_NOTICE' });
  });

  it('lets the technician read back what they sent: minutes, reason group, description and photos', async () => {
    const { service } = build();
    expect((await service.overrunReleaseStatus('o-1', tech)).delayNotice).toBeNull();
    await service.sendDelayNotice('o-1', notice(90), tech);
    expect((await service.overrunReleaseStatus('o-1', tech)).delayNotice).toMatchObject({
      minutes: 90, reasonCode: 'new_fault_found', decision: null, reason: report.reason, evidenceIds: [EV],
    });
  });

  it('a retry of the same report changes nothing and tells nobody twice', async () => {
    const { service, manager, notify, cases } = build();
    await service.sendDelayNotice('o-1', notice(60), tech);
    const writes = manager.update.mock.calls.length;
    await service.sendDelayNotice('o-1', notice(60), tech);
    expect(manager.update.mock.calls.length).toBe(writes);
    expect(cases).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('refuses photos the technician did not upload for the job under repair', async () => {
    const { service, cases, notify } = build({}, { photos: [] });
    await expect(service.sendDelayNotice('o-1', notice(), tech)).rejects.toThrow('ảnh riêng tư');
    expect(cases).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses a photo whose file is not under the technician\'s own path', async () => {
    const { service, cases } = build({}, { photos: [{ id: EV, mimeType: 'image/jpeg', mediaUrl: 'cloudinary://evidence/fixhome/evidence/other/tech-9/abc' }] });
    await expect(service.sendDelayNotice('o-1', notice(), tech)).rejects.toThrow('ảnh riêng tư');
    expect(cases).toHaveLength(0);
  });

  it('refuses when the job the technician is on is not under repair or already handed over', async () => {
    const a = build({}, { current: { status: ServiceOrderStatus.EN_ROUTE } });
    await expect(a.service.sendDelayNotice('o-1', notice(), tech)).rejects.toThrow('còn đang sửa');
    const b = build({}, { current: { completionRequestedAt: new Date() } });
    await expect(b.service.sendDelayNotice('o-1', notice(), tech)).rejects.toThrow('còn đang sửa');
    expect(a.cases.length + b.cases.length).toBe(0);
  });

  it('refuses a notice when the technician is not overrunning', async () => {
    vi.mocked(checkOverrunRelease).mockResolvedValueOnce({ eligible: false, block: 'NO_CURRENT_JOB', currentOrderCode: null, currentOrderId: null, currentOrderStatus: null, windowMinutes: 180 });
    const { service, notify, cases } = build();
    await expect(service.sendDelayNotice('o-1', notice(30), tech)).rejects.toThrow('đang làm đơn khác');
    expect(notify).not.toHaveBeenCalled();
    expect(cases).toHaveLength(0);
  });
});

describe('release needs the same report', () => {
  it('opens the case, closes it as released and runs the release', async () => {
    const { service, cases, inserted } = build();
    await service.releaseForOverrun('o-1', { ...report, evidenceIds: [EV] } as any, tech);
    expect(cases[0]).toMatchObject({ caseType: SupportCaseType.TECHNICIAN_DELAY, status: SupportCaseStatus.RESOLVED, resolutionCode: 'delay_released', evidenceRefs: [EV] });
    expect(cases[0].resolvedAt).toBeInstanceOf(Date);
    expect(inserted[0]).toMatchObject({ type: 'TECHNICIAN_DELAY_REPORTED' });
    expect(service['releaseCheckedOrder']).toHaveBeenCalledOnce();
  });

  it('does not release when the photos are not the technician\'s', async () => {
    const { service, cases } = build({}, { photos: [] });
    await expect(service.releaseForOverrun('o-1', { ...report, evidenceIds: [EV] } as any, tech)).rejects.toThrow('ảnh riêng tư');
    expect(service['releaseCheckedOrder']).not.toHaveBeenCalled();
    expect(cases).toHaveLength(0);
  });
});

describe('delay decision', () => {
  const noticed = async () => {
    const ctx = build();
    await ctx.service.sendDelayNotice('o-1', notice(60), tech);
    ctx.notify.mockClear();
    return ctx;
  };

  it('needs a notice first', async () => {
    const { service } = build();
    await expect(service.decideDelay('o-1', 'wait', customer)).rejects.toThrow('chưa báo trễ');
  });

  it('wait closes the case, records the answer and tells the technician', async () => {
    const { service, row, notify, cases } = await noticed();
    await service.decideDelay('o-1', 'wait', customer);
    expect(row.delayDecision).toBe('wait');
    expect(cases[0]).toMatchObject({ status: SupportCaseStatus.RESOLVED, resolutionCode: 'delay_customer_waits' });
    expect(service['releaseCheckedOrder']).not.toHaveBeenCalled();
    expect(notify.mock.calls[0][0]).toMatchObject({ userId: 'tech-1' });
  });

  it('switch runs the release as the technician and closes the case', async () => {
    const { service, row, cases } = await noticed();
    await service.decideDelay('o-1', 'switch', customer);
    expect(row.delayDecision).toBe('switch');
    expect(cases[0].resolutionCode).toBe('delay_switch');
    expect(service['releaseCheckedOrder']).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { id: 'tech-1', role: Role.TECHNICIAN }, 'SO-1');
  });

  it('cancel waives the customer penalty and closes the case', async () => {
    const { service, row, cases } = await noticed();
    await service.decideDelay('o-1', 'cancel', customer);
    expect(row.delayDecision).toBe('cancel');
    expect(cases[0].resolutionCode).toBe('delay_cancel');
    const call = vi.mocked(service['cancelLocked']).mock.calls[0];
    expect(call[4]).toBe(customer);
    expect(call[6]).toBe(true);
  });

  it('answers only once; the same answer again is a no-op, a different one is refused', async () => {
    const { service, manager } = await noticed();
    await service.decideDelay('o-1', 'wait', customer);
    const writes = manager.update.mock.calls.length;
    await service.decideDelay('o-1', 'wait', customer);
    expect(manager.update.mock.calls.length).toBe(writes);
    await expect(service.decideDelay('o-1', 'cancel', customer)).rejects.toThrow('đã trả lời');
  });

  it('refuses once the technician has arrived or the order left the waiting states', async () => {
    const { service, row } = await noticed();
    vi.mocked(checkOverrunRelease).mockResolvedValueOnce({ eligible: false, block: 'ALREADY_ARRIVED', currentOrderCode: null, currentOrderId: null, currentOrderStatus: null, windowMinutes: 180 });
    await expect(service.decideDelay('o-1', 'switch', customer)).rejects.toThrow('không còn ở trạng thái chờ');
    expect(row.delayDecision).toBeNull();
  });
});
