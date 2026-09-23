// src/modules/system-config/admin-config.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AdminConfigService } from './admin-config.service';
import { SystemConfig } from './entities/system-config.entity';

describe('AdminConfigService', () => {
  let adminConfigService: AdminConfigService;
  let mockConfigService: any;
  let mockAuditLogService: any;

  const makeConfig = (key: string, value: string, valueType: SystemConfig['valueType'] = 'int'): SystemConfig =>
    ({
      key,
      value,
      valueType,
      description: `${key} description`,
      updatedByUserId: null,
      updatedAt: new Date(),
    }) as SystemConfig;

  const seedConfigs: SystemConfig[] = [
    makeConfig('commission.rate_bps', '1000', 'int'),
    makeConfig('matching.mode', 'SEQUENTIAL', 'enum'),
    makeConfig('commission.base', 'LABOR', 'enum'),
    makeConfig('compensation.arrival.amount', '0', 'bigint'),
    makeConfig('ai.provider', 'stub', 'enum'),
    makeConfig('payment.mode', 'DEMO', 'enum'),
    makeConfig('matching.max_shortlist', '5', 'int'),
    makeConfig('matching.invitation_ttl_minutes', '30', 'int'),
    makeConfig('geofence.radius_meters', '300', 'int'),
  ];

  beforeEach(() => {
    mockConfigService = {
      getAll: vi.fn().mockResolvedValue(seedConfigs),
      set: vi.fn().mockImplementation(async (key: string, value: string) => ({
        ...seedConfigs.find((c) => c.key === key),
        value,
      })),
    };

    mockAuditLogService = {
      log: vi.fn().mockResolvedValue(undefined),
    };

    adminConfigService = new AdminConfigService(
      mockConfigService,
      mockAuditLogService,
    );
  });

  describe('findAll', () => {
    it('returns all config keys with effect metadata', async () => {
      const result = await adminConfigService.findAll();
      expect(result).toHaveLength(seedConfigs.length);
      expect(result[0]).toHaveProperty('effectStatus');
      expect(result[0]).toHaveProperty('key');
      expect(result[0]).toHaveProperty('value');
    });

    it('filters by search when provided', async () => {
      const result = await adminConfigService.findAll('commission');
      expect(result.every((r) => r.key.includes('commission'))).toBe(true);
    });

    it('annotates matching.mode as STALE_REVIEW', async () => {
      const result = await adminConfigService.findAll();
      const modeKey = result.find((r) => r.key === 'matching.mode');
      expect(modeKey?.effectStatus).toBe('STALE_REVIEW');
    });

    it('annotates compensation.arrival.amount as STALE_REVIEW', async () => {
      const result = await adminConfigService.findAll();
      const comp = result.find((r) => r.key === 'compensation.arrival.amount');
      expect(comp?.effectStatus).toBe('STALE_REVIEW');
    });

    it('annotates payment.mode as ACTIVE (gates VNPay URL issuance)', async () => {
      const result = await adminConfigService.findAll();
      const pm = result.find((r) => r.key === 'payment.mode');
      expect(pm?.effectStatus).toBe('ACTIVE');
    });

    it('annotates commission.base as TO_WIRE (hard-coded in service-orders)', async () => {
      const result = await adminConfigService.findAll();
      const cb = result.find((r) => r.key === 'commission.base');
      expect(cb?.effectStatus).toBe('TO_WIRE');
      expect(cb?.consumerEvidence).toContain('hard-coded');
    });

    it('annotates matching.max_shortlist as ACTIVE (read via BusinessConfigService)', async () => {
      const result = await adminConfigService.findAll();
      const k = result.find((r) => r.key === 'matching.max_shortlist');
      expect(k?.effectStatus).toBe('ACTIVE');
    });

    it('annotates matching.invitation_ttl_minutes as ACTIVE', async () => {
      const result = await adminConfigService.findAll();
      const k = result.find((r) => r.key === 'matching.invitation_ttl_minutes');
      expect(k?.effectStatus).toBe('ACTIVE');
    });

    it('annotates geofence.radius_meters as TO_WIRE (_geofenceRadius read but not used in distance check)', async () => {
      const result = await adminConfigService.findAll();
      const k = result.find((r) => r.key === 'geofence.radius_meters');
      expect(k?.effectStatus).toBe('TO_WIRE');
      expect(k?.consumerEvidence).toContain('_geofenceRadius');
    });

    it('annotates ai.provider as TO_WIRE (env var, not BusinessConfigService)', async () => {
      const result = await adminConfigService.findAll();
      const k = result.find((r) => r.key === 'ai.provider');
      expect(k?.effectStatus).toBe('TO_WIRE');
    });
  });

  describe('findOne', () => {
    it('returns a single config key', async () => {
      const result = await adminConfigService.findOne('commission.rate_bps');
      expect(result.key).toBe('commission.rate_bps');
      expect(result.value).toBe('1000');
    });

    it('throws NotFoundException for unknown key', async () => {
      await expect(adminConfigService.findOne('nonexistent.key')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('updates commission.rate_bps with valid int value', async () => {
      const result = await adminConfigService.update(
        'commission.rate_bps',
        '800',
        'user-uuid',
        'admin',
      );
      expect(result.value).toBe('800');
      expect(mockAuditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CONFIG_UPDATE',
          resourceType: 'system_config',
          resourceId: 'commission.rate_bps',
          before: expect.objectContaining({ value: '1000' }),
          after: expect.objectContaining({ value: '800' }),
        }),
      );
    });

    it('rejects int value below minimum', async () => {
      await expect(
        adminConfigService.update('commission.rate_bps', '-1', 'user-uuid', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects int value exceeding maximum', async () => {
      await expect(
        adminConfigService.update('commission.rate_bps', '9999', 'user-uuid', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-integer string for int key', async () => {
      await expect(
        adminConfigService.update('commission.rate_bps', 'abc', 'user-uuid', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects invalid enum value for matching.mode', async () => {
      await expect(
        adminConfigService.update('matching.mode', 'SIMULTANEOUS', 'user-uuid', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts valid enum value SEQUENTIAL for matching.mode', async () => {
      const result = await adminConfigService.update(
        'matching.mode',
        'SEQUENTIAL',
        'user-uuid',
        'admin',
      );
      expect(result.value).toBe('SEQUENTIAL');
    });

    it('rejects compensation.arrival.amount > 0 (locked at 0 per v1.4)', async () => {
      await expect(
        adminConfigService.update('compensation.arrival.amount', '50000', 'user-uuid', 'admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for unknown config key on update', async () => {
      await expect(
        adminConfigService.update('totally.unknown.key', '1', 'user-uuid', 'admin'),
      ).rejects.toThrow(NotFoundException);
    });

    it('writes audit log on successful update', async () => {
      await adminConfigService.update('commission.rate_bps', '900', 'user-1', 'admin');
      expect(mockAuditLogService.log).toHaveBeenCalledTimes(1);
    });
  });

});
