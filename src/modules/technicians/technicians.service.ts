// src/modules/technicians/technicians.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechnicianProfile } from './entities/technician-profile.entity';
import { TechnicianSkill } from './entities/technician-skill.entity';
import { TechnicianSkillVerification } from './entities/technician-skill-verification.entity';
import { TechnicianSchedule } from './entities/technician-schedule.entity';
import { TechnicianTimeOff } from './entities/technician-time-off.entity';
import { TechnicianServiceArea } from './entities/technician-service-area.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import {
  ServiceOrderStatus,
  CommissionDueStatus,
  ServicePricingMode,
  VerificationStatus,
} from '../../shared/enums';
import { ServicesService } from '../services/services.service';
import { Service } from '../services/entities/service.entity';
import {
  TechnicianServiceOfferingResponseDto,
  UpdateSkillPricingDto,
} from './dto';

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
  private readonly profileRepo: Repository<TechnicianProfile>;
  private readonly skillRepo: Repository<TechnicianSkill>;
  private readonly scheduleRepo!: Repository<TechnicianSchedule>;
  private readonly timeOffRepo!: Repository<TechnicianTimeOff>;
  private readonly areaRepo!: Repository<TechnicianServiceArea>;
  private readonly assignmentRepo!: Repository<TechnicianAssignment>;
  private readonly orderRepo!: Repository<ServiceOrder>;
  private readonly commissionDueRepo!: Repository<CommissionDue>;
  private readonly servicesService!: ServicesService;
  private readonly skillVerificationRepo!: Repository<TechnicianSkillVerification>;

  constructor(
    @InjectRepository(TechnicianProfile)
    profileRepo: Repository<TechnicianProfile>,
    @InjectRepository(TechnicianSkill)
    skillRepo: Repository<TechnicianSkill>,
    @InjectRepository(TechnicianSchedule)
    @Optional()
    scheduleRepoOrServicesService?: Repository<TechnicianSchedule> | ServicesService,
    @InjectRepository(TechnicianTimeOff)
    @Optional()
    timeOffRepo?: Repository<TechnicianTimeOff>,
    @InjectRepository(TechnicianServiceArea)
    @Optional()
    areaRepo?: Repository<TechnicianServiceArea>,
    @InjectRepository(TechnicianAssignment)
    @Optional()
    assignmentRepo?: Repository<TechnicianAssignment>,
    @InjectRepository(ServiceOrder)
    @Optional()
    orderRepo?: Repository<ServiceOrder>,
    @InjectRepository(CommissionDue)
    @Optional()
    commissionDueRepo?: Repository<CommissionDue>,
    @Optional()
    servicesService?: ServicesService,
    @InjectRepository(TechnicianSkillVerification)
    @Optional()
    skillVerificationRepo?: Repository<TechnicianSkillVerification>,
  ) {
    this.profileRepo = profileRepo;
    this.skillRepo = skillRepo;
    if (skillVerificationRepo) this.skillVerificationRepo = skillVerificationRepo;

    if (
      scheduleRepoOrServicesService &&
      'findById' in (scheduleRepoOrServicesService as object) &&
      typeof (scheduleRepoOrServicesService as any).findById === 'function'
    ) {
      this.servicesService = scheduleRepoOrServicesService as ServicesService;
    } else {
      this.scheduleRepo = scheduleRepoOrServicesService as Repository<TechnicianSchedule>;
      if (timeOffRepo) this.timeOffRepo = timeOffRepo;
      if (areaRepo) this.areaRepo = areaRepo;
      if (assignmentRepo) this.assignmentRepo = assignmentRepo;
      if (orderRepo) this.orderRepo = orderRepo;
      if (commissionDueRepo) this.commissionDueRepo = commissionDueRepo;
      if (servicesService) this.servicesService = servicesService;
    }
  }

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
    dto: { bio?: string; isAvailable?: boolean; yearsExperience?: number; serviceRadiusKm?: number },
  ): Promise<TechnicianProfile> {
    const profile = await this.getMyProfile(userId);
    if (dto.bio !== undefined) profile.bio = dto.bio;
    if (dto.isAvailable !== undefined) profile.isAvailable = dto.isAvailable;
    if (dto.yearsExperience !== undefined) profile.yearsExperience = dto.yearsExperience;
    if (dto.serviceRadiusKm !== undefined) profile.serviceRadiusKm = dto.serviceRadiusKm;
    return this.profileRepo.save(profile);
  }

  async getMySkills(
    userId: string,
  ): Promise<TechnicianServiceOfferingResponseDto[]> {
    const profile = await this.getMyProfile(userId);
    const skills = await this.skillRepo.find({
      where: { technicianId: profile.id },
      relations: ['service'],
    });
    return skills.map((skill) => this.toOfferingDto(skill));
  }

  async setSkillPricing(
    userId: string,
    serviceId: string,
    dto: UpdateSkillPricingDto,
  ): Promise<TechnicianServiceOfferingResponseDto> {
    const profile = await this.getMyProfile(userId);

    // Canonical Service existence check (404 when missing).
    const service = await this.servicesService.findById(serviceId);

    let skill = await this.skillRepo.findOne({
      where: { technicianId: profile.id, serviceId },
    });

    const wouldBeActive =
      dto.isActive !== undefined
        ? dto.isActive
        : (skill?.isActive ?? true);

    if (
      (!service.isActive ||
        (service.category && !service.category.isActive)) &&
      wouldBeActive
    ) {
      throw new BadRequestException(
        'Cannot create or activate an offering for an inactive service or category',
      );
    }

    if (
      service.pricingMode === ServicePricingMode.FIXED_PRICE &&
      dto.listedLaborPrice !== undefined &&
      dto.listedLaborPrice !== null
    ) {
      throw new BadRequestException(
        'Technician cannot override the fixed base price for a FIXED_PRICE service',
      );
    }

    if (!skill) {
      skill = this.skillRepo.create({
        technicianId: profile.id,
        serviceId,
        level:
          dto.level !== undefined ? dto.level.trim() : 'INTERMEDIATE',
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      });
    }

    if (dto.listedLaborPrice !== undefined)
      skill.listedLaborPrice = dto.listedLaborPrice;
    if (dto.typicalWarrantyDays !== undefined)
      skill.typicalWarrantyDays = dto.typicalWarrantyDays;
    if (dto.level !== undefined) skill.level = dto.level.trim();
    if (dto.isActive !== undefined) skill.isActive = dto.isActive;

    if (service.pricingMode === ServicePricingMode.FIXED_PRICE) {
      skill.listedLaborPrice = null;
    }

    const saved = await this.skillRepo.save(skill);
    await this.ensurePendingSkillVerification(saved);
    return this.toOfferingDto(saved, service);
  }

  // A technician toggling a skill active never makes it bookable by itself —
  // it only (re)opens a verification request. The DB partial unique index
  // (idx_one_open_skill_verification) is the real guard against duplicates;
  // this check just avoids throwing on the common "already pending" path.
  private async ensurePendingSkillVerification(skill: TechnicianSkill): Promise<void> {
    if (!this.skillVerificationRepo || !skill.isActive) return;
    if (skill.verificationStatus === VerificationStatus.VERIFIED) return;

    const hasOpenVerification = await this.skillVerificationRepo.exists({
      where: [
        { technicianSkillId: skill.id, status: VerificationStatus.PENDING },
        { technicianSkillId: skill.id, status: VerificationStatus.VERIFIED },
      ],
    });
    if (hasOpenVerification) return;

    await this.skillVerificationRepo.save(
      this.skillVerificationRepo.create({
        technicianSkillId: skill.id,
        status: VerificationStatus.PENDING,
      }),
    );
    if (skill.verificationStatus !== VerificationStatus.PENDING) {
      skill.verificationStatus = VerificationStatus.PENDING;
      await this.skillRepo.update(skill.id, {
        verificationStatus: VerificationStatus.PENDING,
      });
    }
  }

  private toOfferingDto(
    skill: TechnicianSkill,
    service?: Service,
  ): TechnicianServiceOfferingResponseDto {
    const listedLaborPrice =
      skill.listedLaborPrice === undefined ||
      skill.listedLaborPrice === null ||
      (skill.listedLaborPrice as unknown as string) === ''
        ? null
        : Number(skill.listedLaborPrice);
    const typicalWarrantyDays =
      skill.typicalWarrantyDays === undefined ||
      skill.typicalWarrantyDays === null ||
      (skill.typicalWarrantyDays as unknown as string) === ''
        ? null
        : Number(skill.typicalWarrantyDays);

    const source = skill.service ?? service ?? null;
    const isFixedPrice =
      source?.pricingMode === ServicePricingMode.FIXED_PRICE;

    return {
      id: skill.id,
      serviceId: skill.serviceId,
      listedLaborPrice:
        isFixedPrice || listedLaborPrice === null || !Number.isFinite(listedLaborPrice)
          ? null
          : listedLaborPrice,
      typicalWarrantyDays:
        typicalWarrantyDays === null || !Number.isFinite(typicalWarrantyDays)
          ? null
          : typicalWarrantyDays,
      level: skill.level,
      verificationStatus: skill.verificationStatus ?? VerificationStatus.PENDING,
      isActive: skill.isActive,
      service: source
        ? {
            id: source.id,
            name: source.name,
            pricingMode: source.pricingMode,
            isActive: source.isActive,
          }
        : null,
    };
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
