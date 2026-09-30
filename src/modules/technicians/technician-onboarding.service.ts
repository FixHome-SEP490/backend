// src/modules/technicians/technician-onboarding.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TechnicianProfile } from './entities/technician-profile.entity';
import { TechnicianSkill } from './entities/technician-skill.entity';
import { TechnicianServiceArea } from './entities/technician-service-area.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { TechnicianVerification } from '../technician-verifications/entities/technician-verification.entity';
import {
  Gender,
  OnboardingStatus,
  Role,
  VerificationStatus,
} from '../../shared/enums';
import {
  SavePersonalInfoDto,
  SaveSkillsDto,
  SaveAddressDto,
  OnboardingStatusResponseDto,
} from './dto';
import { ageInYearsOnVnToday } from '../../shared/utils/vn-time';

@Injectable()
export class TechnicianOnboardingService {
  constructor(
    @InjectRepository(TechnicianProfile)
    private readonly profileRepo: Repository<TechnicianProfile>,
    @InjectRepository(TechnicianSkill)
    private readonly skillRepo: Repository<TechnicianSkill>,
    @InjectRepository(TechnicianServiceArea)
    private readonly areaRepo: Repository<TechnicianServiceArea>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Service)
    private readonly serviceRepo: Repository<Service>,
    @InjectRepository(TechnicianVerification)
    private readonly verificationRepo: Repository<TechnicianVerification>,
  ) {}

  // ── Helpers ────────────────────────────────────────────────────────────

  private async getProfileOrFail(userId: string): Promise<TechnicianProfile> {
    const profile = await this.profileRepo.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Technician profile not found');
    }
    return profile;
  }

  private assertOnboardingAllowed(profile: TechnicianProfile): void {
    if (profile.onboardingStatus === OnboardingStatus.APPROVED) {
      throw new BadRequestException(
        'Onboarding is already completed and approved.',
      );
    }
  }

  // ── GET Status ─────────────────────────────────────────────────────────

  async getOnboardingStatus(userId: string): Promise<OnboardingStatusResponseDto> {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user || user.role !== Role.TECHNICIAN) {
      throw new ForbiddenException('Technician account required');
    }

    const profile = await this.getProfileOrFail(userId);

    // Check each section completion
    const personalInfoCompleted = !!(
      user.dateOfBirth &&
      user.gender &&
      user.citizenIdNumber
    );

    const latestKyc = await this.verificationRepo.findOne({
      where: { technicianId: userId },
      order: { submittedAt: 'DESC' },
    });
    const kycSubmitted = !!latestKyc;

    const skillCount = await this.skillRepo.count({
      where: { technicianId: profile.id },
    });
    const skillsSelected = skillCount > 0;

    const addressSet = !!profile.fullAddress;

    const areas = await this.areaRepo.find({
      where: { technicianId: profile.id },
    });

    let rejectionReason: string | null = null;
    let shouldSave = false;

    // Self-heal and sync onboarding status with KYC verification status
    if (
      profile.verificationStatus === VerificationStatus.VERIFIED ||
      latestKyc?.status === VerificationStatus.VERIFIED
    ) {
      if (profile.verificationStatus !== VerificationStatus.VERIFIED) {
        profile.verificationStatus = VerificationStatus.VERIFIED;
        shouldSave = true;
      }
      if (profile.onboardingStatus !== OnboardingStatus.APPROVED) {
        profile.onboardingStatus = OnboardingStatus.APPROVED;
        shouldSave = true;
      }
    } else if (latestKyc?.status === VerificationStatus.PENDING) {
      if (profile.verificationStatus !== VerificationStatus.PENDING) {
        profile.verificationStatus = VerificationStatus.PENDING;
        shouldSave = true;
      }
      rejectionReason = null;
    } else if (
      profile.verificationStatus === VerificationStatus.REJECTED ||
      latestKyc?.status === VerificationStatus.REJECTED
    ) {
      if (profile.onboardingStatus !== OnboardingStatus.SUBMITTED) {
        rejectionReason = latestKyc?.rejectionReason || null;
        if (
          profile.onboardingStatus !== OnboardingStatus.REJECTED &&
          profile.onboardingStatus !== OnboardingStatus.IN_PROGRESS
        ) {
          profile.onboardingStatus = OnboardingStatus.REJECTED;
          shouldSave = true;
        }
      }
    }

    if (profile.onboardingStatus === OnboardingStatus.REJECTED && !rejectionReason) {
      rejectionReason = latestKyc?.rejectionReason || null;
    }

    if (shouldSave) {
      await this.profileRepo.save(profile);
    }

    const skills = await this.skillRepo.find({
      where: { technicianId: profile.id },
    });

    let formattedDob: string | undefined;
    if (user.dateOfBirth) {
      formattedDob =
        user.dateOfBirth instanceof Date
          ? user.dateOfBirth.toISOString().slice(0, 10)
          : String(user.dateOfBirth).slice(0, 10);
    }

    return {
      onboardingStatus: profile.onboardingStatus,
      verificationStatus: profile.verificationStatus,
      currentStep: profile.onboardingStep,
      rejectionReason,
      personalInfoCompleted,
      kycSubmitted,
      skillsSelected,
      addressSet,
      fullAddress: profile.fullAddress,
      latitude: profile.latitude ? Number(profile.latitude) : undefined,
      longitude: profile.longitude ? Number(profile.longitude) : undefined,
      serviceRadiusKm: profile.serviceRadiusKm ? Number(profile.serviceRadiusKm) : undefined,
      serviceAreas: areas.map((a) => ({
        provinceCode: a.provinceCode,
        districtCode: a.districtCode,
      })),
      fullName: user.fullName || undefined,
      dateOfBirth: formattedDob,
      gender: (user.gender as Gender) || undefined,
      citizenIdNumber: user.citizenIdNumber || undefined,
      phoneNumber: user.phoneNumber || undefined,
      yearsExperience: profile.yearsExperience,
      bio: profile.bio || undefined,
      selectedServiceIds: skills.map((s) => s.serviceId),
    };
  }

  // ── Step 1: Personal Info ──────────────────────────────────────────────

  async savePersonalInfo(userId: string, dto: SavePersonalInfoDto): Promise<OnboardingStatusResponseDto> {
    const profile = await this.getProfileOrFail(userId);
    this.assertOnboardingAllowed(profile);

    // Validate age >= 18
    const dob = new Date(dto.dateOfBirth);
    // Birth date is a calendar date; "today" is today in Vietnam, not on the server.
    const effectiveAge = ageInYearsOnVnToday(dto.dateOfBirth);
    if (!(effectiveAge >= 18)) {
      throw new BadRequestException('Phải đủ 18 tuổi trở lên để đăng ký làm thợ.');
    }

    // Check CCCD uniqueness
    const existingCccd = await this.userRepo.findOne({
      where: { citizenIdNumber: dto.citizenIdNumber },
    });
    if (existingCccd && existingCccd.id !== userId) {
      throw new BadRequestException('Số CCCD này đã được sử dụng bởi tài khoản khác.');
    }

    // Update user fields
    await this.userRepo.update(userId, {
      fullName: dto.fullName.trim(),
      dateOfBirth: dob,
      gender: dto.gender,
      citizenIdNumber: dto.citizenIdNumber,
      ...(dto.phoneNumber ? { phoneNumber: dto.phoneNumber } : {}),
    });

    // Advance onboarding step
    if (profile.onboardingStep < 2) {
      profile.onboardingStep = 2;
    }
    profile.onboardingStatus = OnboardingStatus.IN_PROGRESS;
    await this.profileRepo.save(profile);

    return this.getOnboardingStatus(userId);
  }

  // ── Step 3: Skills Selection ───────────────────────────────────────────

  async saveSkills(userId: string, dto: SaveSkillsDto): Promise<OnboardingStatusResponseDto> {
    const profile = await this.getProfileOrFail(userId);
    this.assertOnboardingAllowed(profile);

    // Validate all service IDs exist and are active
    const services = await this.serviceRepo
      .createQueryBuilder('s')
      .where('s.id IN (:...ids)', { ids: dto.serviceIds })
      .andWhere('s.is_active = true')
      .getMany();

    if (services.length !== dto.serviceIds.length) {
      throw new BadRequestException(
        'Một số dịch vụ không tồn tại hoặc đã bị vô hiệu hóa.',
      );
    }

    // Upsert skills (delete old ones not in new list, create new ones)
    const existingSkills = await this.skillRepo.find({
      where: { technicianId: profile.id },
    });
    const existingServiceIds = new Set(existingSkills.map((s) => s.serviceId));
    const newServiceIds = new Set(dto.serviceIds);

    // Remove skills not in new list
    const toRemove = existingSkills.filter((s) => !newServiceIds.has(s.serviceId));
    if (toRemove.length > 0) {
      await this.skillRepo.remove(toRemove);
    }

    // Add new skills
    const toAdd = dto.serviceIds.filter((id) => !existingServiceIds.has(id));
    if (toAdd.length > 0) {
      const newSkills = toAdd.map((serviceId) =>
        this.skillRepo.create({
          technicianId: profile.id,
          serviceId,
          level: 'INTERMEDIATE',
          isActive: true,
        }),
      );
      await this.skillRepo.save(newSkills);
    }

    // Update profile
    profile.yearsExperience = dto.yearsExperience;
    if (dto.bio !== undefined) {
      profile.bio = dto.bio || null;
    }
    if (profile.onboardingStep < 4) {
      profile.onboardingStep = 4;
    }
    profile.onboardingStatus = OnboardingStatus.IN_PROGRESS;
    await this.profileRepo.save(profile);

    return this.getOnboardingStatus(userId);
  }

  // ── Step 4: Address & Service Area ─────────────────────────────────────

  async saveAddress(userId: string, dto: SaveAddressDto): Promise<OnboardingStatusResponseDto> {
    const profile = await this.getProfileOrFail(userId);
    this.assertOnboardingAllowed(profile);

    profile.fullAddress = dto.fullAddress;
    if (dto.latitude !== undefined) profile.latitude = dto.latitude;
    if (dto.longitude !== undefined) profile.longitude = dto.longitude;
    if (dto.serviceRadiusKm !== undefined) profile.serviceRadiusKm = dto.serviceRadiusKm;

    // Replace service areas
    await this.areaRepo.delete({ technicianId: profile.id });
    if (dto.serviceAreas.length > 0) {
      const areas = dto.serviceAreas.map((a) =>
        this.areaRepo.create({
          technicianId: profile.id,
          provinceCode: a.provinceCode,
          districtCode: a.districtCode,
        }),
      );
      await this.areaRepo.save(areas);
    }

    if (profile.onboardingStep < 5) {
      profile.onboardingStep = 5;
    }
    profile.onboardingStatus = OnboardingStatus.IN_PROGRESS;
    await this.profileRepo.save(profile);

    return this.getOnboardingStatus(userId);
  }

  // ── Step 5: Submit for Review ──────────────────────────────────────────

  async submitOnboarding(userId: string): Promise<OnboardingStatusResponseDto> {
    const profile = await this.getProfileOrFail(userId);
    this.assertOnboardingAllowed(profile);

    // Validate all steps are completed
    const status = await this.getOnboardingStatus(userId);

    if (!status.personalInfoCompleted) {
      throw new BadRequestException('Vui lòng hoàn tất thông tin cá nhân (Bước 1).');
    }
    if (!status.kycSubmitted) {
      throw new BadRequestException('Vui lòng nộp ảnh xác minh danh tính (Bước 2).');
    }
    if (!status.skillsSelected) {
      throw new BadRequestException('Vui lòng chọn ít nhất 1 kỹ năng chuyên môn (Bước 3).');
    }
    if (!status.addressSet) {
      throw new BadRequestException('Vui lòng cập nhật địa chỉ và khu vực phục vụ (Bước 4).');
    }

    const latestKyc = await this.verificationRepo.findOne({
      where: { technicianId: userId },
      order: { submittedAt: 'DESC' },
    });
    if (latestKyc && latestKyc.status === VerificationStatus.REJECTED) {
      latestKyc.status = VerificationStatus.PENDING;
      latestKyc.submittedAt = new Date();
      latestKyc.rejectionReason = null;
      latestKyc.reviewedAt = null;
      latestKyc.reviewedById = null;
      await this.verificationRepo.save(latestKyc);
    }

    profile.onboardingStatus = OnboardingStatus.SUBMITTED;
    profile.verificationStatus = VerificationStatus.PENDING;
    profile.onboardingStep = 5;
    await this.profileRepo.save(profile);

    return this.getOnboardingStatus(userId);
  }
}
