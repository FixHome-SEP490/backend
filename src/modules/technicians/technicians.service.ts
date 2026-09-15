// src/modules/technicians/technicians.service.ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechnicianProfile } from './entities/technician-profile.entity';
import { TechnicianSkill } from './entities/technician-skill.entity';
import { TechnicianSchedule } from './entities/technician-schedule.entity';
import { TechnicianTimeOff } from './entities/technician-time-off.entity';
import { TechnicianServiceArea } from './entities/technician-service-area.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { ServiceOrderStatus, CommissionDueStatus } from '../../shared/enums';

export interface UpdateSkillPricingDto {
  listedLaborPrice?: number;
  typicalWarrantyDays?: number;
  level?: string;
  isActive?: boolean;
}

export interface ScheduleItemDto {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface ServiceAreaItemDto {
  provinceCode: string;
  districtCode: string;
}

@Injectable()
export class TechniciansService {
  constructor(
    @InjectRepository(TechnicianProfile)
    private readonly profileRepo: Repository<TechnicianProfile>,
    @InjectRepository(TechnicianSkill)
    private readonly skillRepo: Repository<TechnicianSkill>,
    @InjectRepository(TechnicianSchedule)
    private readonly scheduleRepo: Repository<TechnicianSchedule>,
    @InjectRepository(TechnicianTimeOff)
    private readonly timeOffRepo: Repository<TechnicianTimeOff>,
    @InjectRepository(TechnicianServiceArea)
    private readonly areaRepo: Repository<TechnicianServiceArea>,
    @InjectRepository(TechnicianAssignment)
    private readonly assignmentRepo: Repository<TechnicianAssignment>,
    @InjectRepository(ServiceOrder)
    private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(CommissionDue)
    private readonly commissionDueRepo: Repository<CommissionDue>,
  ) {}

  async getMyProfile(userId: string): Promise<TechnicianProfile> {
    let profile = await this.profileRepo.findOne({
      where: { userId },
      relations: ['skills', 'skills.service', 'serviceAreas', 'schedules', 'timeOffs'],
    });

    if (!profile) {
      profile = this.profileRepo.create({
        userId,
        isAvailable: true,
      });
      profile = await this.profileRepo.save(profile);
    }
    return profile;
  }

  async updateMyProfile(
    userId: string,
    dto: { bio?: string; isAvailable?: boolean; yearsExperience?: number },
  ): Promise<TechnicianProfile> {
    const profile = await this.getMyProfile(userId);
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.isAvailable !== undefined) profile.isAvailable = dto.isAvailable;
    if (dto.yearsExperience !== undefined) profile.yearsExperience = dto.yearsExperience;
    return this.profileRepo.save(profile);
  }

  async getMySkills(userId: string): Promise<TechnicianSkill[]> {
    const profile = await this.getMyProfile(userId);
    return this.skillRepo.find({
      where: { technicianId: profile.id },
      relations: ['service'],
    });
  }

  async setSkillPricing(
    userId: string,
    serviceId: string,
    dto: UpdateSkillPricingDto,
  ): Promise<TechnicianSkill> {
    const profile = await this.getMyProfile(userId);

    let skill = await this.skillRepo.findOne({
      where: { technicianId: profile.id, serviceId },
    });

    if (!skill) {
      skill = this.skillRepo.create({
        technicianId: profile.id,
        serviceId,
        level: dto.level || 'INTERMEDIATE',
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      });
    }

    if (dto.listedLaborPrice !== undefined) skill.listedLaborPrice = dto.listedLaborPrice;
    if (dto.typicalWarrantyDays !== undefined) skill.typicalWarrantyDays = dto.typicalWarrantyDays;
    if (dto.level !== undefined) skill.level = dto.level;
    if (dto.isActive !== undefined) skill.isActive = dto.isActive;

    return this.skillRepo.save(skill);
  }

  async getMySchedule(userId: string): Promise<TechnicianSchedule[]> {
    const profile = await this.getMyProfile(userId);
    return this.scheduleRepo.find({
      where: { technicianId: profile.id },
      order: { dayOfWeek: 'ASC', startTime: 'ASC' },
    });
  }

  async updateMySchedule(userId: string, schedules: ScheduleItemDto[]): Promise<TechnicianSchedule[]> {
    const profile = await this.getMyProfile(userId);

    for (const s of schedules) {
      if (s.dayOfWeek < 0 || s.dayOfWeek > 6) {
        throw new BadRequestException(`dayOfWeek must be between 0 and 6 (got ${s.dayOfWeek})`);
      }
      if (!s.startTime || !s.endTime) {
        throw new BadRequestException('startTime and endTime are required');
      }
    }

    await this.scheduleRepo.delete({ technicianId: profile.id });

    if (!schedules || schedules.length === 0) {
      return [];
    }

    const items = schedules.map((s) =>
      this.scheduleRepo.create({
        technicianId: profile.id,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
      }),
    );

    return this.scheduleRepo.save(items);
  }

  async getMyTimeOff(userId: string): Promise<TechnicianTimeOff[]> {
    const profile = await this.getMyProfile(userId);
    return this.timeOffRepo.find({
      where: { technicianId: profile.id },
      order: { startAt: 'DESC' },
    });
  }

  async createTimeOff(
    userId: string,
    dto: { startAt: string | Date; endAt: string | Date; reason?: string },
  ): Promise<TechnicianTimeOff> {
    const profile = await this.getMyProfile(userId);
    const start = new Date(dto.startAt);
    const end = new Date(dto.endAt);

    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('Invalid date range for time off. endAt must be after startAt.');
    }

    const timeOff = this.timeOffRepo.create({
      technicianId: profile.id,
      startAt: start,
      endAt: end,
      reason: dto.reason || null,
    });

    return this.timeOffRepo.save(timeOff);
  }

  async deleteTimeOff(userId: string, timeOffId: string): Promise<{ success: boolean }> {
    const profile = await this.getMyProfile(userId);
    const item = await this.timeOffRepo.findOne({
      where: { id: timeOffId, technicianId: profile.id },
    });

    if (!item) {
      throw new NotFoundException('Time off record not found');
    }

    await this.timeOffRepo.remove(item);
    return { success: true };
  }

  async getMyServiceAreas(userId: string): Promise<TechnicianServiceArea[]> {
    const profile = await this.getMyProfile(userId);
    return this.areaRepo.find({
      where: { technicianId: profile.id },
    });
  }

  async updateMyServiceAreas(
    userId: string,
    areas: ServiceAreaItemDto[],
  ): Promise<TechnicianServiceArea[]> {
    const profile = await this.getMyProfile(userId);

    await this.areaRepo.delete({ technicianId: profile.id });

    if (!areas || areas.length === 0) {
      return [];
    }

    const items = areas.map((a) =>
      this.areaRepo.create({
        technicianId: profile.id,
        provinceCode: a.provinceCode,
        districtCode: a.districtCode,
      }),
    );

    return this.areaRepo.save(items);
  }

  async getMyEarnings(userId: string) {
    const profile = await this.getMyProfile(userId);

    const completedAssignments = await this.assignmentRepo
      .createQueryBuilder('ta')
      .innerJoinAndSelect('service_orders', 'so', 'so.id = ta.service_order_id')
      .leftJoinAndSelect('bookings', 'b', 'b.id = so.booking_id')
      .leftJoinAndSelect('users', 'u', 'u.id = b.customer_id')
      .where('ta.technician_id = :userId', { userId })
      .andWhere('so.status = :status', { status: ServiceOrderStatus.COMPLETED })
      .orderBy('so.completed_at', 'DESC')
      .getRawMany();

    const commissionDues = await this.commissionDueRepo.find({
      where: { technicianId: userId },
    });

    let totalGrossLabor = 0;
    let totalCommission = 0;

    const payouts = completedAssignments.map((row) => {
      const gross = Number(row.so_labor_total || row.so_grand_total || 0);
      const fee = Math.round(gross * 0.1);
      const net = gross - fee;

      totalGrossLabor += gross;
      totalCommission += fee;

      return {
        orderId: row.so_id,
        orderCode: row.so_code || `#ORD-${String(row.so_id).slice(0, 8)}`,
        date: row.so_completed_at
          ? new Date(row.so_completed_at).toLocaleDateString('vi-VN')
          : new Date(row.ta_created_at).toLocaleDateString('vi-VN'),
        customer: row.u_full_name || 'Khách hàng FixHome',
        gross,
        platformFee: fee,
        net,
        status: 'COMPLETED',
      };
    });

    const pendingDues = commissionDues.filter((d) => d.status === CommissionDueStatus.PENDING);
    const pendingDueTotal = pendingDues.reduce((acc, cur) => acc + Number(cur.dueAmount || 0), 0);

    return {
      totalCompletedOrders: payouts.length,
      totalGross: totalGrossLabor,
      totalCommission,
      totalNet: totalGrossLabor - totalCommission,
      pendingDueCount: pendingDues.length,
      pendingDueAmount: pendingDueTotal,
      rating: Number(profile.averageRating) || 5.0,
      ratingCount: profile.ratingCount || 0,
      reliability: profile.reliabilityScore || 100,
      commissionRatePercent: 10,
      payouts,
    };
  }
}
