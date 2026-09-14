// src/modules/audit-log/audit-log.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { AuditLogService } from './audit-log.service';
import { AuditLog } from './entities/audit-log.entity';

describe('AuditLogService', () => {
  let auditLogService: AuditLogService;
  let mockAuditRepo: any;

  const makeLog = (overrides: Partial<AuditLog> = {}): AuditLog =>
    ({
      id: 'log-uuid-1',
      actorUserId: 'actor-uuid',
      actorRole: 'admin',
      action: 'CONFIG_UPDATE',
      resourceType: 'system_config',
      resourceId: 'commission.rate_bps',
      before: { value: '1000' },
      after: { value: '900' },
      ip: null,
      userAgent: null,
      createdAt: new Date(),
      ...overrides,
    }) as AuditLog;

  beforeEach(() => {
    const logs = [makeLog(), makeLog({ id: 'log-uuid-2', action: 'CREATE', resourceType: 'service' })];
    mockAuditRepo = {
      insert: vi.fn().mockResolvedValue(undefined),
      createQueryBuilder: vi.fn().mockReturnValue({
        andWhere: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        take: vi.fn().mockReturnThis(),
        getManyAndCount: vi.fn().mockResolvedValue([logs, logs.length]),
      }),
      findOneBy: vi.fn().mockImplementation(({ id }: { id: string }) =>
        Promise.resolve(logs.find((l) => l.id === id) ?? null),
      ),
    };

    auditLogService = new AuditLogService(mockAuditRepo);
  });

  describe('log', () => {
    it('inserts an audit log entry', async () => {
      await auditLogService.log({
        actorUserId: 'user-1',
        actorRole: 'admin',
        action: 'CONFIG_UPDATE',
        resourceType: 'system_config',
        resourceId: 'commission.rate_bps',
        before: { value: '1000' },
        after: { value: '900' },
      });
      expect(mockAuditRepo.insert).toHaveBeenCalledTimes(1);
    });

    it('does not throw when insert fails (append-only resilience)', async () => {
      mockAuditRepo.insert.mockRejectedValue(new Error('DB error'));
      // Should not propagate the error
      await expect(
        auditLogService.log({
          actorUserId: 'u1',
          actorRole: 'admin',
          action: 'TEST',
          resourceType: 'test',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('findAll', () => {
    it('returns paginated results', async () => {
      const result = await auditLogService.findAll({ page: 1, limit: 10 });
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('applies resourceType filter', async () => {
      await auditLogService.findAll({ page: 1, limit: 10, resourceType: 'system_config' });
      expect(mockAuditRepo.createQueryBuilder().andWhere).toHaveBeenCalled();
    });

    it('applies actorUserId filter', async () => {
      await auditLogService.findAll({ page: 1, limit: 10, actorUserId: 'actor-uuid' });
      expect(mockAuditRepo.createQueryBuilder().andWhere).toHaveBeenCalled();
    });

    it('applies action filter', async () => {
      await auditLogService.findAll({ page: 1, limit: 10, action: 'CONFIG_UPDATE' });
      expect(mockAuditRepo.createQueryBuilder().andWhere).toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns log when found', async () => {
      const result = await auditLogService.findById('log-uuid-1');
      expect(result?.id).toBe('log-uuid-1');
    });

    it('returns null when not found', async () => {
      const result = await auditLogService.findById('nonexistent-uuid');
      expect(result).toBeNull();
    });
  });
});
