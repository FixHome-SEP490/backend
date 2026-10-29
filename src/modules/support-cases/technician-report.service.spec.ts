import { describe, expect, it, vi } from 'vitest';
import { Role, ServiceOrderStatus, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { SupportCase } from './entities';
import { TechnicianReportService } from './technician-report.service';

function setup(existing?: any) {
  const order = { id: 'order-1', bookingId: 'booking-1', status: ServiceOrderStatus.UNDER_REPAIR };
  const booking = { id: 'booking-1', customerId: 'customer-1' };
  const assignment = { serviceOrderId: order.id, technicianId: 'tech-1', isActive: true };
  const manager = {
    findOne: vi.fn(async (entity: unknown) => entity === ServiceOrder ? order : entity === Booking ? booking :
      entity === TechnicianAssignment ? assignment : entity === SupportCase ? existing ?? null : null),
    query: vi.fn(async () => [{ id: 'checkin-1' }]),
    create: vi.fn((_entity, value) => value),
    save: vi.fn(async (_entity, value) => ({ id: 'case-1', ...value })),
    insert: vi.fn(async () => undefined),
    find: vi.fn(async () => []),
  };
  const reputation = { penalizeReviewedCase: vi.fn(async () => ({ id: 'event-1', delta: -10 })) };
  const service = new TechnicianReportService(
    { transaction: async (work: (manager: any) => unknown) => work(manager) } as any,
    { logWithManagerStrict: vi.fn(async () => undefined) } as any,
    reputation as any,
  );
  return { service, manager, reputation, order, booking, assignment };
}

describe('technician report and SM responsibility', () => {
  const report = { serviceOrderId: 'order-1', reasonClass: 'technician_skill_gap', reasonCode: 'skill_gap',
    reason: 'Tôi không có kỹ năng xử lý dòng máy này', evidenceRefs: [] } as const;
  it('opens an assigned and checked-in report without any point event or order change', async () => {
    const s = setup();
    const result = await s.service.report(report as any, { id: 'tech-1', role: Role.TECHNICIAN });
    expect(result).toMatchObject({ reasonCode: 'skill_gap', responsibility: 'pending_sm_review', status: SupportCaseStatus.OPEN });
    expect(s.reputation.penalizeReviewedCase).not.toHaveBeenCalled();
    expect(s.order.status).toBe(ServiceOrderStatus.UNDER_REPAIR);
  });

  it('rejects report by an unassigned technician', async () => {
    const s = setup();
    await expect(s.service.report(report as any, { id: 'other-tech', role: Role.TECHNICIAN })).rejects.toThrow();
    expect(s.manager.save).not.toHaveBeenCalled();
  });

  it('records no-fault decision without points and returns only same-command replay', async () => {
    const kase = { id: 'case-1', caseType: SupportCaseType.TECHNICIAN_REPLACEMENT,
      reasonClass: 'non_technician_exception', reasonCode: 'customer_absent',
      responsibility: 'pending_sm_review', workflowVersion: 0, technicianId: 'tech-1', status: SupportCaseStatus.OPEN };
    const s = setup(kase);
    const actor = { id: 'sm-1', role: Role.SERVICE_MANAGER };
    const input = { commandId: 'command-1', workflowVersion: 0, decision: 'no_technician_fault',
      reason: 'Khách không có mặt; đã kiểm tra nhật ký liên lạc' } as const;
    const result = await s.service.decide('case-1', input as any, actor);
    expect(result.responsibility).toBe('no_technician_fault');
    expect(s.reputation.penalizeReviewedCase).not.toHaveBeenCalled();
    expect(await s.service.decide('case-1', input as any, actor)).toStrictEqual(result);
  });

  it('deducts at most once only after an SM fault decision', async () => {
    const kase = { id: 'case-1', caseType: SupportCaseType.TECHNICIAN_REPLACEMENT,
      reasonClass: 'technician_skill_gap', reasonCode: 'skill_gap',
      responsibility: 'pending_sm_review', workflowVersion: 0, technicianId: 'tech-1', status: SupportCaseStatus.OPEN };
    const s = setup(kase);
    await s.service.decide('case-1', { commandId: 'command-1', workflowVersion: 0,
      decision: 'technician_fault', reason: 'Bằng chứng cho thấy thợ nhận việc ngoài kỹ năng' } as any,
    { id: 'sm-1', role: Role.SERVICE_MANAGER });
    expect(s.reputation.penalizeReviewedCase).toHaveBeenCalledOnce();
    await expect(s.service.decide('case-1', { commandId: 'command-2', workflowVersion: 0,
      decision: 'technician_fault', reason: 'Khác' } as any,
    { id: 'sm-1', role: Role.SERVICE_MANAGER })).rejects.toThrow();
    expect(s.reputation.penalizeReviewedCase).toHaveBeenCalledOnce();
  });
});
