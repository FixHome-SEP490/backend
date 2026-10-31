import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { PaymentStatus, Role, SupportCaseStatus, SupportCaseType } from '../../shared/enums';
import { SupportCase } from './entities/support-case.entity';
import { SupportCasesService } from './support-cases.service';

const SM = { id: 'sm-1', role: Role.SERVICE_MANAGER };
const command = {
  finalStatus: SupportCaseStatus.RESOLVED as const,
  resolutionCode: 'escalate_admin', reason: 'Cần quản trị viên xem xét thêm bằng chứng.',
  commandId: '11111111-1111-4111-8111-111111111111', expectedVersion: 0,
};

// Transactional storage double: assert persisted state/readback, including rollback.
function fixture(caseType = SupportCaseType.QUALITY) {
  let row = {
    id: 'case-1', caseType, status: SupportCaseStatus.OPEN, workflowVersion: 0,
    holdCompletion: true, assignedManagerId: null, resolutionCode: null,
    resolutionReason: null, resolvedAt: null, serviceOrderId: 'order-1',
    customerId: 'customer-1', technicianId: 'tech-1', evidenceRefs: null,
  } as unknown as SupportCase;
  let audits: any[] = [];
  let walletBalance = 0;
  let failAudit = false;
  let failWallet = false;
  const invoice = { id: 'invoice-1', grandTotal: 100000, paymentStatus: PaymentStatus.PAID };
  const locks: any[] = [];
  const repo = {
    findOne: async (options: any) => { locks.push(options.lock); return structuredClone(row); },
    findOneBy: async () => structuredClone(row),
    findOneByOrFail: async () => structuredClone(row),
    update: async (_where: any, updates: any) => { Object.assign(row, updates); return { affected: 1 }; },
  };
  const manager: any = {
    getRepository: (entity: any) => entity === SupportCase ? repo : { findOne: async () => null },
    find: async (entity: any, options: any) => entity === AuditLog
      ? audits.filter(a => a.action === options.where.action && a.resourceId === options.where.resourceId)
      : [{ id: 'admin-1' }],
    findOne: async (entity: any) => entity === Invoice ? invoice
      : entity === ServiceOrder ? { code: 'TEST-1' } : null,
    query: async (sql: string) => sql.includes('to_regclass') ? [{ rel: null }] : [],
    insert: async (_entity: any, entry: any) => {
      if (failAudit) throw new Error('audit unavailable');
      audits.push({ ...structuredClone(entry), id: `audit-${audits.length}`, createdAt: new Date() });
    },
    transaction: async (cb: any) => {
      const snapshot = structuredClone({ row, audits, walletBalance });
      try { return await cb(manager); }
      catch (e) { ({ row, audits, walletBalance } = snapshot); throw e; }
    },
  };
  const notifications = { createManyNotifications: vi.fn().mockResolvedValue([]), createNotification: vi.fn().mockResolvedValue({}) };
  const wallet = {
    refundedForOrder: async () => walletBalance,
    apply: async (_manager: any, input: any) => {
      if (failWallet) throw new Error('wallet unavailable');
      walletBalance += input.amount;
    },
  };
  const service = new SupportCasesService(
    { ...repo, manager } as any, { findOne: async () => null } as any,
    { findOne: async () => ({ id: 'order-1', code: 'TEST-1' }) } as any,
    { findOne: async () => invoice } as any, { findOne: async () => null } as any,
    {} as any, new AuditLogService({} as any), {} as any, notifications as any, wallet as any,
  );
  return {
    service, notifications, locks, state: () => ({ row, audits, walletBalance }),
    failAudit: () => { failAudit = true; }, failWallet: () => { failWallet = true; },
  };
}

describe('T12 support case truth', () => {
  it('records pseudo outcomes without claiming price, refund, warranty or sanction execution', async () => {
    for (const code of ['warning_issued', 'price_adjusted', 'refund_recorded', 'warranty_overturned']) {
      const f = fixture();
      const result = await f.service.resolveCase('case-1', { ...command, resolutionCode: code }, SM);
      expect(result).toMatchObject({ status: SupportCaseStatus.RESOLVED, holdCompletion: false,
        resolutionCode: code, resolutionExecutionKind: 'DECISION_RECORDED', needsManualAction: true, nextActor: Role.SERVICE_MANAGER });
      expect(f.state().walletBalance).toBe(0);
      expect(f.notifications.createManyNotifications.mock.calls[0][0]).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('chưa thực hiện'), referenceType: 'SUPPORT_CASE' }),
      ]));
    }
  });

  it('escalates durably under lock, keeps hold, replays once and rejects stale or changed commands and Admin writes', async () => {
    const f = fixture();
    const result = await f.service.resolveCase('case-1', command, SM);
    expect(result).toMatchObject({ status: SupportCaseStatus.IN_REVIEW, holdCompletion: true,
      resolvedAt: null, workflowVersion: 1, resolutionExecutionKind: 'ESCALATED_ADMIN', nextActor: Role.ADMIN });
    expect(f.locks[0]).toEqual({ mode: 'pessimistic_write' });
    expect(f.state().audits).toEqual([expect.objectContaining({ action: 'SUPPORT_CASE_ESCALATE_ADMIN',
      actorUserId: SM.id, after: expect.objectContaining({ commandId: command.commandId, workflowVersion: 1, reason: command.reason }) })]);
    expect(f.notifications.createManyNotifications.mock.calls[0][0]).toEqual([
      expect.objectContaining({ userId: 'admin-1', referenceId: 'case-1', referenceType: 'SUPPORT_CASE',
        message: expect.stringContaining('chỉ đọc') }),
    ]);
    await f.service.resolveCase('case-1', command, SM);
    expect(f.state().audits).toHaveLength(1);
    expect(f.notifications.createManyNotifications).toHaveBeenCalledTimes(1);
    await expect(f.service.resolveCase('case-1', { ...command, reason: 'Lý do khác với lệnh đã ghi.' }, SM)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.resolveCase('case-1', { ...command, commandId: '22222222-2222-4222-8222-222222222222' }, SM)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.resolveCase('case-1', command, { id: 'admin-1', role: Role.ADMIN })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.state().row.status).toBe(SupportCaseStatus.IN_REVIEW);
    expect(f.state().walletBalance).toBe(0);
  });

  it('fails closed without escalation command/version or audit; notification failure does not undo durable escalation', async () => {
    const f = fixture();
    await expect(f.service.resolveCase('case-1', { ...command, commandId: undefined } as any, SM)).rejects.toBeInstanceOf(BadRequestException);
    f.failAudit();
    await expect(f.service.resolveCase('case-1', command, SM)).rejects.toThrow('audit unavailable');
    expect(f.state().row).toMatchObject({ status: SupportCaseStatus.OPEN, holdCompletion: true, workflowVersion: 0 });
    expect(f.state().audits).toHaveLength(0);
    expect(f.notifications.createManyNotifications).not.toHaveBeenCalled();
    const fallback = fixture();
    fallback.notifications.createManyNotifications.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(fallback.service.resolveCase('case-1', command, SM)).resolves.toMatchObject({ status: SupportCaseStatus.IN_REVIEW });
    expect(fallback.state().audits).toHaveLength(1);
  });

  it('reports a wallet refund executed only after the real command credits the wallet; failed command rolls back case and audit', async () => {
    const f = fixture(SupportCaseType.PARTS_DISPUTE);
    const input = { ...command, resolutionCode: 'refund_to_wallet', amount: 10000 };
    const result = await f.service.resolveCase('case-1', input, SM);
    expect(f.state().walletBalance).toBe(10000);
    expect(result).toMatchObject({ resolutionExecutionKind: 'DOMAIN_ACTION_EXECUTED', needsManualAction: false, nextActor: null });
    expect(await f.service.findById('case-1')).toMatchObject({ resolutionExecutionKind: 'DOMAIN_ACTION_EXECUTED' });
    f.state().audits.length = 0;
    expect(await f.service.findById('case-1')).toMatchObject({ resolutionExecutionKind: 'EXECUTION_NOT_VERIFIED', needsManualAction: true });
    const failed = fixture(SupportCaseType.PARTS_DISPUTE);
    failed.failWallet();
    await expect(failed.service.resolveCase('case-1', input, SM)).rejects.toThrow('wallet unavailable');
    expect(failed.state().row).toMatchObject({ status: SupportCaseStatus.OPEN, holdCompletion: true });
    expect(failed.state().audits).toHaveLength(0);
    expect(failed.notifications.createManyNotifications).not.toHaveBeenCalled();
  });
});
