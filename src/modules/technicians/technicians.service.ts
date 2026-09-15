// src/modules/technicians/technicians.service.ts
import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechnicianProfile } from './entities/technician-profile.entity';
import { TechnicianSkill } from './entities/technician-skill.entity';
import { ServicesService } from '../services/services.service';
import { Service } from '../services/entities/service.entity';
import { ServicePricingMode } from '../../shared/enums';
import {
  TechnicianServiceOfferingResponseDto,
  UpdateSkillPricingDto,
} from './dto';

@Injectable()
export class TechniciansService {
  constructor(
    @InjectRepository(TechnicianProfile)
    private readonly profileRepo: Repository<TechnicianProfile>,
    @InjectRepository(TechnicianSkill)
    private readonly skillRepo: Repository<TechnicianSkill>,
    private readonly servicesService: ServicesService,
  ) {}

  async getMyProfile(userId: string): Promise<TechnicianProfile> {
    let profile = await this.profileRepo.findOne({
      where: { userId },
      relations: ['skills', 'skills.service', 'serviceAreas'],
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
    return this.toOfferingDto(saved, service);
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
}
