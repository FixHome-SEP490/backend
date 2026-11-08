import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { OnboardingStatus, Role, VerificationStatus } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BusinessConfigService } from '../system-config/business-config.service';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { TechnicianVerification } from '../technician-verifications/entities/technician-verification.entity';
import { Wallet } from '../wallet/entities/wallet.entity';
import { ApproveProfileDto, RejectProfileDto } from './dto/office-visit.dto';
import { OfficeVisit, OfficeVisitStatus } from './entities/office-visit.entity';
import { deriveReviewStage } from './office-visit-rules';

/**
 * Duyệt hồ sơ cuối (Admin): sau khi danh tính đã được xác nhận và thợ đã gặp trực tiếp, admin kiểm bản công chứng,
 * xác nhận cấp độ từng kỹ năng rồi chuyển hồ sơ sang APPROVED (PO 09/11/2026).
 */
@Injectable()
export class ProfileReviewService {
  constructor(
    @InjectRepository(TechnicianProfile) private readonly profiles: Repository<TechnicianProfile>,
    @InjectRepository(OfficeVisit) private readonly visits: Repository<OfficeVisit>,
    @InjectRepository(TechnicianVerification) private readonly verifications: Repository<TechnicianVerification>,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditLogService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  private async stageOf(profile: TechnicianProfile, visits: OfficeVisit[], kycRejected: boolean) {
    const maxMissed = await this.config.getInt('office.max_missed_visits', 2);
    return deriveReviewStage({
      onboardingStatus: profile.onboardingStatus,
      profileVerified: profile.verificationStatus === VerificationStatus.VERIFIED,
      identityVerified: !!profile.identityVerifiedAt,
      kycRejected,
      profileRejectionReason: profile.profileReviewRejectionReason ?? null,
      hasScheduledVisit: visits.some((v) => v.status === OfficeVisitStatus.SCHEDULED),
      hasAttendedVisit: visits.some((v) => v.status === OfficeVisitStatus.ATTENDED),
      missedVisits: visits.filter((v) => v.status === OfficeVisitStatus.MISSED).length,
      maxMissedVisits: maxMissed,
    });
  }

  /** Thợ đã được xác nhận danh tính nhưng chưa được duyệt hồ sơ. */
  async list() {
    const profiles = await this.profiles.find({
      where: { identityVerifiedAt: Not(IsNull()), verificationStatus: Not(VerificationStatus.VERIFIED) },
      relations: ['user'],
      order: { identityVerifiedAt: 'DESC' },
      take: 200,
    });
    const visits = profiles.length
      ? await this.visits.find({ where: { technicianId: In(profiles.map((p) => p.userId)) }, relations: ['office'], order: { scheduledAt: 'DESC' } })
      : [];
    return Promise.all(
      profiles.map(async (profile) => {
        const own = visits.filter((v) => v.technicianId === profile.userId);
        const next = own.find((v) => v.status === OfficeVisitStatus.SCHEDULED) ?? own.find((v) => v.status === OfficeVisitStatus.ATTENDED) ?? null;
        return {
          technicianId: profile.userId,
          fullName: profile.user?.fullName ?? '',
          email: profile.user?.email ?? '',
          phoneNumber: profile.user?.phoneNumber ?? null,
          identityVerifiedAt: profile.identityVerifiedAt?.toISOString() ?? null,
          stage: await this.stageOf(profile, own, false),
          visit: next ? { id: next.id, status: next.status, scheduledAt: next.scheduledAt.toISOString(), officeName: next.office?.name ?? '' } : null,
          missedVisits: own.filter((v) => v.status === OfficeVisitStatus.MISSED).length,
        };
      }),
    );
  }

  async get(technicianId: string) {
    const profile = await this.profiles.findOne({
      where: { userId: technicianId },
      relations: ['user', 'skills', 'skills.service', 'serviceAreas'],
      relationLoadStrategy: 'query',
    });
    if (!profile) throw new NotFoundException('Technician profile not found');
    const [visits, kyc] = await Promise.all([
      this.visits.find({ where: { technicianId }, relations: ['office'], order: { scheduledAt: 'DESC' } }),
      this.verifications.findOne({ where: { technicianId }, relations: ['documents'], order: { submittedAt: 'DESC' } }),
    ]);
    return {
      technicianId,
      stage: await this.stageOf(profile, visits, kyc?.status === VerificationStatus.REJECTED),
      technician: {
        fullName: profile.user?.fullName ?? '',
        email: profile.user?.email ?? '',
        phoneNumber: profile.user?.phoneNumber ?? null,
        citizenIdNumber: profile.user?.citizenIdNumber ?? null,
      },
      profile: {
        yearsExperience: profile.yearsExperience,
        bio: profile.bio ?? null,
        fullAddress: profile.fullAddress ?? null,
        serviceRadiusKm: profile.serviceRadiusKm,
        serviceAreas: (profile.serviceAreas ?? []).map((a) => ({ provinceCode: a.provinceCode, districtCode: a.districtCode })),
        rejectionReason: profile.profileReviewRejectionReason ?? null,
      },
      skills: (profile.skills ?? []).map((s) => ({
        id: s.id,
        serviceName: s.service?.name ?? '',
        declaredLevel: s.declaredLevel ?? null,
        level: s.level,
        verificationStatus: s.verificationStatus,
      })),
      // Ảnh bản công chứng nộp cùng hồ sơ xác minh (`certificate`); xem qua endpoint truy cập tài liệu của hồ sơ xác minh.
      verificationId: kyc?.id ?? null,
      faceMatchScore: kyc?.faceMatchScore ?? null,
      documents: (kyc?.documents ?? []).map((d) => ({ id: d.id, documentType: d.documentType, fileName: d.fileName })),
      visits: visits.map((v) => ({
        id: v.id,
        status: v.status,
        scheduledAt: v.scheduledAt.toISOString(),
        officeName: v.office?.name ?? '',
        note: v.note,
      })),
    };
  }

  async approve(technicianId: string, adminId: string, dto: ApproveProfileDto) {
    if (!dto.skills.some((s) => s.approved)) throw new BadRequestException('Cần xác nhận ít nhất một kỹ năng.');
    const result = await this.profiles.manager.transaction(async (manager) => {
      const profile = await manager.getRepository(TechnicianProfile).findOne({ where: { userId: technicianId }, lock: { mode: 'pessimistic_write' } });
      if (!profile) throw new NotFoundException('Technician profile not found');
      if (!profile.identityVerifiedAt) throw new BadRequestException('Danh tính chưa được xác nhận.');
      if (profile.verificationStatus === VerificationStatus.VERIFIED) throw new ConflictException('Hồ sơ đã được duyệt.');
      const attended = await manager.getRepository(OfficeVisit).exists({ where: { technicianId, status: OfficeVisitStatus.ATTENDED } });
      if (!attended) throw new BadRequestException('Chỉ duyệt hồ sơ sau khi đã gặp trực tiếp tại trụ sở.');

      const skills = await manager.getRepository(TechnicianSkill).find({ where: { technicianId: profile.id } });
      const byId = new Map(skills.map((s) => [s.id, s]));
      const skillReviews = manager.getRepository(TechnicianSkillVerification);
      const now = new Date();
      for (const decision of dto.skills) {
        const skill = byId.get(decision.skillId);
        if (!skill) throw new BadRequestException('Có kỹ năng không thuộc hồ sơ của thợ này.');
        const status = decision.approved ? VerificationStatus.VERIFIED : VerificationStatus.REJECTED;
        skill.level = decision.level;
        skill.verificationStatus = status;
        await manager.getRepository(TechnicianSkill).save(skill);
        // Phiếu duyệt kỹ năng: đóng phiếu đang mở hoặc tạo phiếu đã xử lý, để không vi phạm index một phiếu mở mỗi kỹ năng.
        const open = await skillReviews.findOne({ where: { technicianSkillId: skill.id, status: VerificationStatus.PENDING } });
        if (open) await skillReviews.update(open.id, { status, reviewedById: adminId, reviewedAt: now });
        else await skillReviews.save(skillReviews.create({ technicianSkillId: skill.id, status, reviewedById: adminId, reviewedAt: now }));
      }

      profile.verificationStatus = VerificationStatus.VERIFIED;
      profile.onboardingStatus = OnboardingStatus.APPROVED;
      profile.profileReviewRejectionReason = null;
      await manager.getRepository(TechnicianProfile).save(profile);

      const wallets = manager.getRepository(Wallet);
      if (!(await wallets.findOne({ where: { technicianId } }))) await wallets.save(wallets.create({ technicianId, balance: 0 }));

      await this.audit.logWithManagerStrict(manager, {
        actorUserId: adminId,
        actorRole: Role.ADMIN,
        action: 'TECHNICIAN_PROFILE_APPROVED',
        resourceType: 'technician_profile',
        resourceId: technicianId,
        before: { onboardingStatus: OnboardingStatus.SUBMITTED },
        after: { onboardingStatus: OnboardingStatus.APPROVED, skills: dto.skills },
      });
      return { technicianId, onboardingStatus: OnboardingStatus.APPROVED };
    });
    void this.notifications?.createNotification({
      userId: technicianId,
      title: 'Hồ sơ đã được duyệt - Nạp tiền ví để nhận việc',
      message:
        'Chúc mừng bạn đã trở thành Đối tác Kỹ thuật viên FixHome! Số dư ví ban đầu là 0 ₫. Vui lòng nạp tối thiểu 200.000 ₫ vào ví để bắt đầu tiếp nhận các đơn sửa chữa từ khách hàng.',
      type: 'WALLET_TOPUP_REQUIRED',
      referenceType: 'wallet',
      referenceId: technicianId,
    });
    return result;
  }

  async reject(technicianId: string, adminId: string, dto: RejectProfileDto) {
    const profile = await this.profiles.findOne({ where: { userId: technicianId } });
    if (!profile) throw new NotFoundException('Technician profile not found');
    if (!profile.identityVerifiedAt) throw new BadRequestException('Danh tính chưa được xác nhận.');
    if (profile.verificationStatus === VerificationStatus.VERIFIED) throw new ConflictException('Hồ sơ đã được duyệt.');
    await this.profiles.update(profile.id, { onboardingStatus: OnboardingStatus.REJECTED, profileReviewRejectionReason: dto.reason });
    await this.audit.log({
      actorUserId: adminId, actorRole: Role.ADMIN, action: 'TECHNICIAN_PROFILE_REJECTED', resourceType: 'technician_profile', resourceId: technicianId,
      before: { onboardingStatus: profile.onboardingStatus }, after: { onboardingStatus: OnboardingStatus.REJECTED, reason: dto.reason },
    });
    void this.notifications?.createNotification({
      userId: technicianId,
      title: 'Hồ sơ cần bổ sung',
      message: `Hồ sơ của bạn chưa đạt yêu cầu. Lý do: ${dto.reason}.`,
      type: 'PROFILE_REJECTED',
      referenceType: 'technician_profile',
      referenceId: technicianId,
    });
    return { technicianId, onboardingStatus: OnboardingStatus.REJECTED };
  }
}
