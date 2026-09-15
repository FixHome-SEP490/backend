// src/modules/technicians/technicians.service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TechniciansService } from './technicians.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ServiceOrderStatus, CommissionDueStatus } from '../../shared/enums';

describe('TechniciansService', () => {
  let service: TechniciansService;
  let mockProfileRepo: any;
  let mockSkillRepo: any;
  let mockScheduleRepo: any;
  let mockTimeOffRepo: any;
  let mockAreaRepo: any;
  let mockAssignmentRepo: any;
  let mockOrderRepo: any;
  let mockCommissionDueRepo: any;

  const mockProfile = {
    id: 'tech-profile-uuid',
    userId: 'user-tech-uuid',
    bio: 'Thợ điện lạnh',
    yearsExperience: 4,
    averageRating: 4.9,
    ratingCount: 15,
    reliabilityScore: 98,
    isAvailable: true,
  };

  beforeEach(() => {
    mockProfileRepo = {
      findOne: vi.fn().mockResolvedValue(mockProfile),
      create: vi.fn((data) => ({ ...data, id: 'new-profile-uuid' })),
      save: vi.fn((data) => Promise.resolve(data)),
    };

    mockSkillRepo = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((data) => data),
      save: vi.fn((data) => Promise.resolve(data)),
    };

    mockScheduleRepo = {
      find: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({ affected: 1 }),
      create: vi.fn((data) => data),
      save: vi.fn((data) => Promise.resolve(data)),
    };

    mockTimeOffRepo = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn().mockResolvedValue(null),
      create: vi.fn((data) => data),
      save: vi.fn((data) => Promise.resolve(data)),
      remove: vi.fn().mockResolvedValue(true),
    };

    mockAreaRepo = {
      find: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({ affected: 1 }),
      create: vi.fn((data) => data),
      save: vi.fn((data) => Promise.resolve(data)),
    };

    mockAssignmentRepo = {
      createQueryBuilder: vi.fn(() => ({
        innerJoinAndSelect: vi.fn().mockReturnThis(),
        leftJoinAndSelect: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getRawMany: vi.fn().mockResolvedValue([
          {
            so_id: 'order-1',
            so_code: 'FH-001',
            so_labor_total: '300000',
            so_grand_total: '300000',
            so_completed_at: new Date('2026-09-10'),
            u_full_name: 'Nguyen Van A',
          },
        ]),
      })),
    };

    mockOrderRepo = {};
    mockCommissionDueRepo = {
      find: vi.fn().mockResolvedValue([
        {
          id: 'due-1',
          technicianId: 'user-tech-uuid',
          dueAmount: '30000',
          status: CommissionDueStatus.PENDING,
        },
      ]),
    };

    service = new TechniciansService(
      mockProfileRepo,
      mockSkillRepo,
      mockScheduleRepo,
      mockTimeOffRepo,
      mockAreaRepo,
      mockAssignmentRepo,
      mockOrderRepo,
      mockCommissionDueRepo,
    );
  });

  describe('updateMySchedule', () => {
    it('should save valid schedules', async () => {
      const schedules = [
        { dayOfWeek: 1, startTime: '08:00', endTime: '18:00' },
        { dayOfWeek: 2, startTime: '08:00', endTime: '18:00' },
      ];

      const result = await service.updateMySchedule('user-tech-uuid', schedules);
      expect(mockScheduleRepo.delete).toHaveBeenCalledWith({ technicianId: 'tech-profile-uuid' });
      expect(result).toHaveLength(2);
    });

    it('should reject invalid dayOfWeek (< 0 or > 6)', async () => {
      const schedules = [{ dayOfWeek: 7, startTime: '08:00', endTime: '18:00' }];
      await expect(service.updateMySchedule('user-tech-uuid', schedules)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('createTimeOff', () => {
    it('should create time-off when endAt > startAt', async () => {
      const result = await service.createTimeOff('user-tech-uuid', {
        startAt: '2026-10-01T08:00:00Z',
        endAt: '2026-10-02T18:00:00Z',
        reason: 'Nghỉ phép',
      });

      expect(result.reason).toBe('Nghỉ phép');
      expect(mockTimeOffRepo.save).toHaveBeenCalled();
    });

    it('should reject if endAt <= startAt', async () => {
      await expect(
        service.createTimeOff('user-tech-uuid', {
          startAt: '2026-10-02T18:00:00Z',
          endAt: '2026-10-01T08:00:00Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deleteTimeOff', () => {
    it('should throw NotFoundException if time off not found', async () => {
      mockTimeOffRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.deleteTimeOff('user-tech-uuid', 'invalid-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should remove if owned by technician', async () => {
      mockTimeOffRepo.findOne.mockResolvedValueOnce({ id: 'timeoff-1', technicianId: 'tech-profile-uuid' });
      const result = await service.deleteTimeOff('user-tech-uuid', 'timeoff-1');
      expect(result.success).toBe(true);
      expect(mockTimeOffRepo.remove).toHaveBeenCalled();
    });
  });

  describe('getMyEarnings', () => {
    it('should calculate real earnings, commission, and pending dues', async () => {
      const earnings = await service.getMyEarnings('user-tech-uuid');

      expect(earnings.totalCompletedOrders).toBe(1);
      expect(earnings.totalGross).toBe(300000);
      expect(earnings.totalCommission).toBe(30000);
      expect(earnings.totalNet).toBe(270000);
      expect(earnings.pendingDueCount).toBe(1);
      expect(earnings.pendingDueAmount).toBe(30000);
      expect(earnings.payouts).toHaveLength(1);
      expect(earnings.payouts[0].customer).toBe('Nguyen Van A');
    });
  });
});
