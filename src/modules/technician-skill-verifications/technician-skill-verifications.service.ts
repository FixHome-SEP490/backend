import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TechnicianSkillVerification } from '../technicians/entities/technician-skill-verification.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { ensurePendingSkillVerification } from '../technicians/skill-verification-request';
import {
  AccountStatus,
  DocumentType,
  SKILL_EVIDENCE_GROUP_BY_TYPE,
  SkillEvidenceReviewStatus,
  OnboardingStatus,
  Role,
  VerificationStatus,
} from '../../shared/enums';
import { PaginationMeta } from '../../shared/dto';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { KycStorageService, KycSignedAccess, KycSignedUpload } from '../technician-verifications/kyc-storage.service';
import {
  AttachSkillEvidenceDto,
  QuerySkillVerificationsDto,
  RejectSkillVerificationDto,
  ReuseSkillEvidenceDto,
  SkillVerificationResponseDto,
  SubmitCategoryEvidenceDto,
  SubmitSkillEvidenceDto,
  UpdateCategoryEvidenceDto,
} from './dto';
import {
  toSkillVerificationResponse,
  toSkillVerificationResponseList,
} from './technician-skill-verifications.mapper';

export const SKILL_EVIDENCE_NOT_UPLOADED =
  'Không tìm thấy tệp chứng chỉ đã tải lên. Vui lòng tải lại tệp rồi gửi.';

const isCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * Metadata columns for a technician's evidence. The trust group comes from the type, never from the client.
 * Details without a type are refused so a row never carries half a description; no type and no details
 * (a client that sends only the file) stores nothing extra.
 */
export function skillEvidenceMetadata(dto: SubmitSkillEvidenceDto | UpdateCategoryEvidenceDto) {
  const { evidenceType, issuer, referenceNumber, issuedAt, expiresAt, claimedYears } = dto;
  if (!evidenceType) {
    if (issuer || referenceNumber || issuedAt || expiresAt || claimedYears !== undefined) {
      throw new BadRequestException('evidenceType is required when evidence details are given');
    }
    return {};
  }
  if ((issuedAt && !isCalendarDate(issuedAt)) || (expiresAt && !isCalendarDate(expiresAt))) {
    throw new BadRequestException('issuedAt and expiresAt must be real calendar dates');
  }
  if (issuedAt && expiresAt && expiresAt < issuedAt) {
    throw new BadRequestException('expiresAt must not be before issuedAt');
  }
  return {
    evidenceType,
    evidenceGroup: SKILL_EVIDENCE_GROUP_BY_TYPE[evidenceType],
    issuer: issuer || null,
    referenceNumber: referenceNumber || null,
    issuedAt: issuedAt ?? null,
    expiresAt: expiresAt ?? null,
    claimedYears: claimedYears ?? null,
    reviewStatus: SkillEvidenceReviewStatus.PENDING,
  };
}

/** A paper row counts as approved once its request, or the skill it sits on, was verified. */
const isApprovedRow = (request: TechnicianSkillVerification) =>
  request.status === VerificationStatus.VERIFIED ||
  request.technicianSkill?.verificationStatus === VerificationStatus.VERIFIED;

/** A request of a skill the technician switched off is not reviewed; it comes back when the skill is switched on. */
const assertSkillTaken = (request: TechnicianSkillVerification) => {
  if (request.technicianSkill?.isActive === false) {
    throw new ConflictException('Kỹ thuật viên đã tắt kỹ năng này, chưa thể duyệt hoặc từ chối.');
  }
};

type PaperIdentity = Pick<VerificationDocument, 'storageObjectPath' | 'evidenceType' | 'referenceNumber'>;
const normalizedNumber = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

/** The same paper twice on one skill: the same stored file, or the same type with the same (non-empty) number. */
const samePaper = (a: PaperIdentity, b: PaperIdentity) =>
  (!!a.storageObjectPath && a.storageObjectPath === b.storageObjectPath) ||
  (!!a.evidenceType && a.evidenceType === b.evidenceType && !!normalizedNumber(a.referenceNumber) && normalizedNumber(a.referenceNumber) === normalizedNumber(b.referenceNumber));

const assertNotExpired = (expiresAt: string | null | undefined) => {
  if (expiresAt && expiresAt < new Date().toISOString().slice(0, 10)) {
    throw new BadRequestException('expiresAt must not be in the past');
  }
};

const VERIFICATION_RELATIONS = [
  'technicianSkill',
  'technicianSkill.service',
  'technicianSkill.technician',
  'technicianSkill.technician.user',
  'documents',
  'reviewedBy',
];

@Injectable()
export class TechnicianSkillVerificationsService {
  constructor(
    @InjectRepository(TechnicianSkillVerification)
    private readonly verificationRepo: Repository<TechnicianSkillVerification>,
    @InjectRepository(TechnicianSkill)
    private readonly skillRepo: Repository<TechnicianSkill>,
    @InjectRepository(TechnicianProfile)
    private readonly profileRepo: Repository<TechnicianProfile>,
    @InjectRepository(VerificationDocument)
    private readonly documentRepo: Repository<VerificationDocument>,
    private readonly auditLogService: AuditLogService,
    private readonly storageService: KycStorageService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() @InjectRepository(User) private readonly userRepo?: Repository<User>,
  ) {}

  /**
   * The request a new paper is put on. A refused skill stays refused until the technician asks again (resubmitSkill): its
   * new papers wait on the latest refused request, which resubmitSkill carries over, so adding one paper never sends
   * every refused skill back to review. Any other skill gets (or keeps) its open request.
   */
  private async requestToAttachTo(skill: TechnicianSkill): Promise<TechnicianSkillVerification | null> {
    if (skill.isActive && skill.verificationStatus === VerificationStatus.REJECTED) {
      const open = await this.verificationRepo.findOne({ where: { technicianSkillId: skill.id, status: VerificationStatus.PENDING } });
      if (!open) {
        const refused = await this.verificationRepo.findOne({
          where: { technicianSkillId: skill.id, status: VerificationStatus.REJECTED },
          order: { submittedAt: 'DESC' },
        });
        if (refused) return refused;
      }
    }
    return ensurePendingSkillVerification(this.verificationRepo, skill);
  }

  /** Tells the technician how a skill review ended. Never fails the review: a notice that cannot be saved is dropped. */
  private notifyTechnician(verification: TechnicianSkillVerification, outcome: 'approved' | 'rejected') {
    const skill = verification.technicianSkill;
    const userId = skill?.technician?.userId;
    if (!userId) return;
    const name = skill.service?.name ?? 'dịch vụ';
    void this.notifications
      ?.createNotification(
        outcome === 'approved'
          ? { userId, title: 'Kỹ năng đã được duyệt', message: `Kỹ năng ${name} đã được FixHome duyệt.`, type: 'SKILL_VERIFICATION_APPROVED', referenceType: 'technician_skill', referenceId: skill.id }
          : {
              userId,
              title: 'Kỹ năng chưa được duyệt',
              message: `Kỹ năng ${name} chưa được duyệt. Lý do: ${verification.rejectionReason ?? 'chưa nêu lý do'}. Bạn có thể sửa giấy tờ rồi gửi lại.`,
              type: 'SKILL_VERIFICATION_REJECTED',
              referenceType: 'technician_skill',
              referenceId: skill.id,
            },
      )
      .catch(() => undefined);
  }

  /** Tells the active service managers that a technician sent skills back for review. */
  private async notifyResubmitted(technicianUserId: string, requestIds: string[], names: string[]) {
    if (!this.notifications || !this.userRepo || requestIds.length === 0) return;
    try {
      const [technician, managers] = await Promise.all([
        this.userRepo.findOne({ where: { id: technicianUserId }, select: { id: true, fullName: true } }),
        this.userRepo.find({ where: { role: Role.SERVICE_MANAGER, isActive: true, status: AccountStatus.ACTIVE }, select: { id: true } }),
      ]);
      await this.notifications.createManyNotifications(
        managers.map((manager) => ({
          userId: manager.id,
          title: 'Kỹ năng được gửi lại để xét duyệt',
          message: `${technician?.fullName ?? 'Kỹ thuật viên'} gửi lại kỹ năng ${names.join(', ')}.`,
          type: 'SKILL_VERIFICATION_RESUBMITTED',
          referenceId: requestIds[0],
          referenceType: 'technician_skill_verification',
        })),
      );
    } catch {
      // The request is already open; a missed notice must not undo it.
    }
  }

  /** Adds how many times each skill was reviewed before, and why the last one was refused, so the reviewer can compare. */
  private async withHistory(items: SkillVerificationResponseDto[]): Promise<SkillVerificationResponseDto[]> {
    const skillIds = [...new Set(items.map((item) => item.technicianSkillId))];
    if (skillIds.length === 0) return items;
    const all = await this.verificationRepo.find({
      where: { technicianSkillId: In(skillIds) },
      select: { id: true, technicianSkillId: true, status: true, submittedAt: true, rejectionReason: true },
    });
    return items.map((item) => {
      const earlier = all
        .filter((r) => r.technicianSkillId === item.technicianSkillId && r.submittedAt < item.submittedAt)
        .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
      return {
        ...item,
        attemptNumber: earlier.length + 1,
        previousRejectionReason: earlier.find((r) => r.status === VerificationStatus.REJECTED)?.rejectionReason ?? null,
      };
    });
  }

  // ---- Technician-facing ----

  async createEvidenceUploadUrl(
    technicianUserId: string,
    mimeType: string,
  ): Promise<KycSignedUpload> {
    return this.storageService.createSignedUploadUrl(technicianUserId, mimeType);
  }

  /**
   * One paper for every skill the technician has in the chosen categories (PO 24/11/2026): one document row per skill,
   * all pointing at the same stored file, so the reviewer still sees the evidence per skill. Confirmed and inactive
   * skills are skipped. The requests are opened before the insert, outside any transaction, because a unique
   * violation inside one would abort it; the insert itself is a single atomic save.
   */
  async attachEvidenceToCategories(
    technicianUserId: string,
    dto: SubmitCategoryEvidenceDto,
  ): Promise<{ attachedSkills: number; serviceIds: string[] }> {
    const metadata = skillEvidenceMetadata(dto);
    assertNotExpired(dto.expiresAt);
    this.storageService.validateObjectPath(dto.storageObjectPath, technicianUserId);

    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');

    const skills = await this.skillRepo.find({
      where: { technicianId: profile.id, isActive: true, service: { categoryId: In(dto.categoryIds) } },
      relations: ['service'],
    });
    const waiting = skills.filter((skill) => skill.verificationStatus !== VerificationStatus.VERIFIED);
    if (waiting.length === 0) {
      throw new NotFoundException('Bạn chưa có kỹ năng nào chờ xác minh thuộc các nhóm đã chọn.');
    }
    await this.assertUploaded(dto.storageObjectPath, technicianUserId);

    const paper = { storageObjectPath: dto.storageObjectPath, evidenceType: dto.evidenceType ?? null, referenceNumber: dto.referenceNumber ?? null };
    const targets: { serviceId: string; request: TechnicianSkillVerification }[] = [];
    const duplicates: string[] = [];
    for (const skill of waiting) {
      const request = await this.requestToAttachTo(skill);
      if (!request) continue;
      if (await this.hasPaper(request.id, paper)) {
        duplicates.push(skill.service?.name ?? 'dịch vụ');
        continue;
      }
      targets.push({ serviceId: skill.serviceId, request });
    }
    if (targets.length === 0) {
      if (duplicates.length > 0) throw new ConflictException(`Giấy tờ này đã có ở kỹ năng ${duplicates.join(', ')}.`);
      throw new ConflictException('Các kỹ năng này chưa có yêu cầu xác minh để đính giấy tờ.');
    }

    await this.documentRepo.save(
      targets.map(({ request }) =>
        this.documentRepo.create({
          skillVerificationId: request.id,
          documentType: DocumentType.CERTIFICATE,
          storageObjectPath: dto.storageObjectPath,
          fileName: dto.fileName,
          fileSize: dto.fileSize,
          mimeType: dto.mimeType,
          issuedById: null,
          ...metadata,
        }),
      ),
    );
    await this.auditEvidence(technicianUserId, 'SKILL_EVIDENCE_ATTACHED', null, {
      evidenceType: dto.evidenceType ?? null,
      serviceIds: targets.map((target) => target.serviceId),
    });
    return { attachedSkills: targets.length, serviceIds: targets.map((target) => target.serviceId) };
  }

  /** Whether the request already holds this paper (same file, or same type and number). */
  private async hasPaper(requestId: string, paper: PaperIdentity): Promise<boolean> {
    const held = await this.documentRepo.find({ where: { skillVerificationId: requestId } });
    return held.some((row) => samePaper(row, paper));
  }

  /**
   * Puts papers the technician already sent on one more skill, without uploading again. A paper the skill already holds is
   * skipped, not an error, so picking several papers never fails because of one that is there. The copies follow the same
   * rules as a new upload (a refused skill keeps them waiting; an approved skill takes none).
   */
  async reuseMyEvidence(technicianUserId: string, serviceId: string, dto: ReuseSkillEvidenceDto): Promise<{ attached: number; skipped: number }> {
    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');
    const skill = await this.skillRepo.findOne({ where: { technicianId: profile.id, serviceId }, relations: ['service'] });
    if (!skill) throw new NotFoundException('Skill not found');

    const sources = await this.documentRepo.find({ where: { id: In(dto.documentIds) }, relations: ['skillVerification', 'skillVerification.technicianSkill'] });
    const owned = sources.filter((d) => !d.issuedById && d.skillVerification?.technicianSkill?.technicianId === profile.id);
    if (owned.length !== dto.documentIds.length) throw new NotFoundException('Verification document not found');
    for (const source of owned) assertNotExpired(source.expiresAt);

    const request = await this.requestToAttachTo(skill);
    if (!request) throw new ConflictException('This skill has no pending verification request to attach evidence to');
    const held: PaperIdentity[] = await this.documentRepo.find({ where: { skillVerificationId: request.id } });
    const fresh: VerificationDocument[] = [];
    for (const source of owned) {
      if (held.some((row) => samePaper(row, source))) continue;
      held.push(source);
      fresh.push(
        this.documentRepo.create({
          skillVerificationId: request.id,
          documentType: DocumentType.CERTIFICATE,
          storageObjectPath: source.storageObjectPath,
          fileName: source.fileName,
          fileSize: source.fileSize,
          mimeType: source.mimeType,
          issuedById: null,
          evidenceType: source.evidenceType,
          evidenceGroup: source.evidenceGroup,
          issuer: source.issuer,
          referenceNumber: source.referenceNumber,
          issuedAt: source.issuedAt,
          expiresAt: source.expiresAt,
          claimedYears: source.claimedYears,
          reviewStatus: SkillEvidenceReviewStatus.PENDING,
        }),
      );
    }
    if (fresh.length > 0) await this.documentRepo.save(fresh);
    await this.auditEvidence(technicianUserId, 'SKILL_EVIDENCE_ATTACHED', null, { serviceId, reused: true, attached: fresh.length });
    return { attached: fresh.length, skipped: owned.length - fresh.length };
  }

  /** Traces what the technician does to a paper after it was sent, so the reviewer can see changes; the file itself is not logged. */
  private auditEvidence(technicianUserId: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
    return this.auditLogService.log({
      actorUserId: technicianUserId,
      actorRole: Role.TECHNICIAN,
      action,
      resourceType: 'skill_evidence',
      before,
      after,
    });
  }

  async attachEvidence(
    technicianUserId: string,
    serviceId: string,
    dto: SubmitSkillEvidenceDto,
  ): Promise<SkillVerificationResponseDto> {
    const metadata = skillEvidenceMetadata(dto);
    this.storageService.validateObjectPath(dto.storageObjectPath, technicianUserId);

    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');

    const skill = await this.skillRepo.findOne({
      where: { technicianId: profile.id, serviceId },
      relations: ['service'],
    });
    if (!skill) throw new NotFoundException('Skill not found');

    const verification = await this.requestToAttachTo(skill);
    if (!verification) {
      throw new ConflictException(
        'This skill has no pending verification request to attach evidence to',
      );
    }
    const paper = { storageObjectPath: dto.storageObjectPath, evidenceType: dto.evidenceType ?? null, referenceNumber: dto.referenceNumber ?? null };
    if (await this.hasPaper(verification.id, paper)) {
      throw new ConflictException(`Giấy tờ này đã có ở kỹ năng ${skill.service?.name ?? 'này'}.`);
    }
    // The path proves the owner, the bucket proves the upload: a path that was
    // never uploaded through the signed upload URL is refused before anything
    // is saved (storage unreachable is a 503 from objectExists).
    await this.assertUploaded(dto.storageObjectPath, technicianUserId);

    await this.documentRepo.save(
      this.documentRepo.create({
        skillVerificationId: verification.id,
        documentType: DocumentType.CERTIFICATE,
        storageObjectPath: dto.storageObjectPath,
        fileName: dto.fileName,
        fileSize: dto.fileSize,
        mimeType: dto.mimeType,
        issuedById: null,
        ...metadata,
      }),
    );

    return this.findById(verification.id);
  }

  /** The technician asks for a new review of a skill FixHome refused: opens a request that carries the papers already sent. */
  async resubmitSkill(technicianUserId: string, serviceId: string): Promise<SkillVerificationResponseDto> {
    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');
    const skill = await this.skillRepo.findOne({ where: { technicianId: profile.id, serviceId }, relations: ['service'] });
    if (!skill) throw new NotFoundException('Skill not found');
    if (!skill.isActive || skill.verificationStatus !== VerificationStatus.REJECTED) {
      throw new ConflictException('Chỉ gửi lại được kỹ năng đang bật và đã bị từ chối.');
    }
    const request = await ensurePendingSkillVerification(this.verificationRepo, skill);
    if (!request) throw new ConflictException('Kỹ năng này chưa mở lại được yêu cầu xác minh.');
    await this.notifyResubmitted(technicianUserId, [request.id], [skill.service?.name ?? 'dịch vụ']);
    await this.auditEvidence(technicianUserId, 'SKILL_RESUBMITTED', null, { serviceId, requestId: request.id });
    return this.findById(request.id);
  }

  async getMySkillVerification(
    technicianUserId: string,
    serviceId: string,
  ): Promise<SkillVerificationResponseDto | null> {
    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) return null;

    const skill = await this.skillRepo.findOne({
      where: { technicianId: profile.id, serviceId },
    });
    if (!skill) return null;

    // The technician sees the outcome, not the reviewing admin's account
    // (email, status), so the reviewer relation is not loaded here.
    const verification = await this.verificationRepo.findOne({
      where: { technicianSkillId: skill.id },
      order: { submittedAt: 'DESC' },
      relations: VERIFICATION_RELATIONS.filter((relation) => relation !== 'reviewedBy'),
    });
    return verification ? toSkillVerificationResponse(verification) : null;
  }

  /**
   * The papers the technician has sent, one entry per stored file with the categories it covers: a paper attached to a
   * whole category is saved as one document row per skill, so the rows are folded by file. FixHome-issued certificates
   * are not the technician's papers and are left out. `serviceId` is any one skill the paper sits on, for the
   * per-service document access route. `editable` is false once the paper was used to approve a skill (or while the
   * profile waits for review): edit and delete are refused then, so the app hides them.
   */
  async listMyEvidence(technicianUserId: string) {
    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) return [];
    const requests = await this.verificationRepo.find({
      where: { technicianSkill: { technicianId: profile.id, isActive: true } },
      relations: ['technicianSkill', 'technicianSkill.service', 'technicianSkill.service.category', 'documents'],
    });
    const byFile = new Map<
      string,
      {
        document: VerificationDocument;
        serviceId: string;
        categories: Map<string, string>;
        serviceIds: Set<string>;
        approved: boolean;
        pending: boolean;
        rejectionReason: string | null;
      }
    >();
    for (const request of requests) {
      const service = request.technicianSkill.service;
      for (const document of request.documents ?? []) {
        if (document.issuedById) continue;
        const key = document.storageObjectPath ?? document.id;
        const entry = byFile.get(key) ?? {
          document,
          serviceId: request.technicianSkill.serviceId,
          categories: new Map<string, string>(),
          serviceIds: new Set<string>(),
          approved: false,
          pending: false,
          rejectionReason: null,
        };
        if (isApprovedRow(request)) entry.approved = true;
        else if (request.status === VerificationStatus.PENDING) entry.pending = true;
        else if (request.status === VerificationStatus.REJECTED) entry.rejectionReason ??= request.rejectionReason ?? null;
        entry.categories.set(service.categoryId, service.category?.name ?? 'Khác');
        entry.serviceIds.add(request.technicianSkill.serviceId);
        byFile.set(key, entry);
      }
    }
    const inReview = profile.onboardingStatus === OnboardingStatus.SUBMITTED;
    return [...byFile.values()]
      .sort((a, b) => a.document.createdAt.getTime() - b.document.createdAt.getTime())
      .map(({ document: d, serviceId, serviceIds, categories, approved, pending, rejectionReason }) => {
        // Same rule as `editableEvidenceRows`: a paper used to approve any skill is locked, whatever else it sits on.
        const status = inReview ? 'in_review' : approved ? 'approved' : pending ? 'pending' : 'rejected';
        return {
        status,
        rejectionReason: status === 'rejected' ? rejectionReason : null,
        editable: status === 'pending' || status === 'rejected',
        documentId: d.id,
        serviceId,
        // Every skill the paper sits on, so the app can tell which papers a skill already holds.
        serviceIds: [...serviceIds],
        fileName: d.fileName,
        mimeType: d.mimeType,
        evidenceType: d.evidenceType ?? null,
        evidenceGroup: d.evidenceGroup ?? null,
        issuer: d.issuer ?? null,
        referenceNumber: d.referenceNumber ?? null,
        issuedAt: d.issuedAt ?? null,
        expiresAt: d.expiresAt ?? null,
        claimedYears: d.claimedYears ?? null,
        reviewStatus: d.reviewStatus ?? null,
        categories: [...categories].map(([id, name]) => ({ id, name })),
        };
      });
  }

  /**
   * The rows of one stored paper the technician may still change: the ones still waiting for review or whose skill was
   * rejected. A paper that already helped approve any skill is refused whole, so it cannot be re-pointed at other groups.
   * A technician waiting for the review cannot edit anything (same rule as the registration steps).
   */
  private async editableEvidenceRows(technicianUserId: string, documentId: string) {
    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');
    if (profile.onboardingStatus === OnboardingStatus.SUBMITTED) {
      throw new BadRequestException('Hồ sơ đang chờ xét duyệt, không thể chỉnh sửa lúc này.');
    }
    const relations = ['skillVerification', 'skillVerification.technicianSkill', 'skillVerification.technicianSkill.service'];
    const document = await this.documentRepo.findOne({ where: { id: documentId }, relations });
    if (!document || document.issuedById || document.skillVerification?.technicianSkill?.technicianId !== profile.id) {
      throw new NotFoundException('Verification document not found');
    }
    const rows = document.storageObjectPath
      ? await this.documentRepo.find({
          where: { storageObjectPath: document.storageObjectPath, skillVerification: { technicianSkill: { technicianId: profile.id } } },
          relations,
        })
      : [document];
    const editable = rows.filter(
      (row) =>
        row.skillVerification &&
        row.skillVerification.status !== VerificationStatus.VERIFIED &&
        row.skillVerification.technicianSkill.verificationStatus !== VerificationStatus.VERIFIED,
    );
    if (editable.length === 0 || rows.some((row) => row.skillVerification && isApprovedRow(row.skillVerification))) {
      throw new ConflictException('Giấy tờ này đã dùng để duyệt kỹ năng, không thể sửa hoặc xóa.');
    }
    return { profile, document, editable };
  }

  /** The stored file goes once no row points at it; one that cannot be removed is left for the storage clean-up. */
  private async removeFileIfUnused(path: string | null) {
    if (!path || (await this.documentRepo.count({ where: { storageObjectPath: path } })) > 0) return;
    try {
      await this.storageService.remove([path]);
    } catch {
      // The rows no longer point at it.
    }
  }

  /**
   * Takes a paper off one skill only; the same file stays on the other skills it sits on and goes from storage once no row
   * points at it. Same rules as deleting the whole paper: a skill already approved, or a profile waiting for review, refuses.
   */
  async deleteMyEvidenceFromSkill(technicianUserId: string, serviceId: string, documentId: string): Promise<{ removed: number }> {
    const profile = await this.profileRepo.findOne({ where: { userId: technicianUserId } });
    if (!profile) throw new NotFoundException('Technician profile not found');
    if (profile.onboardingStatus === OnboardingStatus.SUBMITTED) {
      throw new BadRequestException('Hồ sơ đang chờ xét duyệt, không thể chỉnh sửa lúc này.');
    }
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
      relations: ['skillVerification', 'skillVerification.technicianSkill'],
    });
    const skill = document?.skillVerification?.technicianSkill;
    if (!document || document.issuedById || skill?.technicianId !== profile.id || skill.serviceId !== serviceId) {
      throw new NotFoundException('Verification document not found');
    }
    if (isApprovedRow(document.skillVerification!)) {
      throw new ConflictException('Giấy tờ này đã dùng để duyệt kỹ năng, không thể xóa.');
    }
    await this.documentRepo.remove(document);
    await this.removeFileIfUnused(document.storageObjectPath);
    await this.auditEvidence(technicianUserId, 'SKILL_EVIDENCE_DELETED', { documentId, serviceId, evidenceType: document.evidenceType }, null);
    return { removed: 1 };
  }

  /** Removes a paper from every skill it sits on; the stored file goes too once no row points at it. */
  async deleteMyEvidence(technicianUserId: string, documentId: string): Promise<{ removed: number }> {
    const { editable, document } = await this.editableEvidenceRows(technicianUserId, documentId);
    await this.documentRepo.remove(editable);
    await this.removeFileIfUnused(document.storageObjectPath);
    await this.auditEvidence(technicianUserId, 'SKILL_EVIDENCE_DELETED', { documentId, evidenceType: document.evidenceType }, null);
    return { removed: editable.length };
  }

  /** Changes the details and the categories of a paper already sent, then returns the technician's papers. */
  async updateMyEvidence(technicianUserId: string, documentId: string, dto: UpdateCategoryEvidenceDto) {
    assertNotExpired(dto.expiresAt);
    const { profile, document, editable } = await this.editableEvidenceRows(technicianUserId, documentId);
    const empty = {
      evidenceType: null, evidenceGroup: null, issuer: null, referenceNumber: null,
      issuedAt: null, expiresAt: null, claimedYears: null, reviewStatus: null,
    };
    const patch = { ...empty, ...skillEvidenceMetadata(dto) } as Partial<VerificationDocument>;

    const skills = await this.skillRepo.find({
      where: { technicianId: profile.id, isActive: true, service: { categoryId: In(dto.categoryIds) } },
      relations: ['service'],
    });
    const targets = skills.filter((skill) => skill.verificationStatus !== VerificationStatus.VERIFIED);
    if (targets.length === 0) {
      throw new NotFoundException('Bạn chưa có kỹ năng nào chờ xác minh thuộc các nhóm đã chọn.');
    }
    const targetIds = new Set(targets.map((skill) => skill.id));
    const keep = editable.filter((row) => targetIds.has(row.skillVerification.technicianSkillId));
    const drop = editable.filter((row) => !targetIds.has(row.skillVerification.technicianSkillId));
    const covered = new Set(keep.map((row) => row.skillVerification.technicianSkillId));

    const additions: { request: TechnicianSkillVerification }[] = [];
    for (const skill of targets.filter((s) => !covered.has(s.id))) {
      const request = await this.requestToAttachTo(skill);
      if (request) additions.push({ request });
    }

    if (drop.length > 0) await this.documentRepo.remove(drop);
    if (keep.length > 0) await this.documentRepo.update(keep.map((row) => row.id), patch);
    if (additions.length > 0) {
      await this.documentRepo.save(
        additions.map(({ request }) =>
          this.documentRepo.create({
            skillVerificationId: request.id,
            documentType: DocumentType.CERTIFICATE,
            storageObjectPath: document.storageObjectPath,
            fileName: document.fileName,
            fileSize: document.fileSize,
            mimeType: document.mimeType,
            issuedById: null,
            ...patch,
          }),
        ),
      );
    }
    await this.auditEvidence(
      technicianUserId,
      'SKILL_EVIDENCE_UPDATED',
      { documentId, evidenceType: document.evidenceType, issuer: document.issuer, claimedYears: document.claimedYears },
      { evidenceType: dto.evidenceType ?? null, issuer: dto.issuer ?? null, claimedYears: dto.claimedYears ?? null, categoryIds: dto.categoryIds },
    );
    return this.listMyEvidence(technicianUserId);
  }

  // ---- Admin-facing ----

  async findAll(
    query: QuerySkillVerificationsDto,
  ): Promise<{ data: SkillVerificationResponseDto[]; meta: PaginationMeta }> {
    const qb = this.verificationRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.technicianSkill', 'skill')
      .leftJoinAndSelect('skill.service', 'service')
      .leftJoinAndSelect('skill.technician', 'profile')
      .leftJoinAndSelect('profile.user', 'user')
      .leftJoinAndSelect('v.documents', 'documents')
      .leftJoinAndSelect('v.reviewedBy', 'reviewedBy');

    // A technician still going through onboarding is reviewed once, in the profile review; this list keeps the
    // skills added after the profile was approved.
    qb.andWhere('profile.verificationStatus = :approved', { approved: VerificationStatus.VERIFIED });
    // A skill the technician switched off is not theirs to be reviewed: its request waits, out of the queue, until it is switched on again.
    qb.andWhere('skill.isActive = true');

    if (query.status) {
      qb.andWhere('v.status = :status', { status: query.status });
    }

    qb.orderBy('v.submittedAt', 'DESC');
    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();

    const meta: PaginationMeta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };

    return { data: await this.withHistory(toSkillVerificationResponseList(data)), meta };
  }

  async findById(id: string): Promise<SkillVerificationResponseDto> {
    const verification = await this.verificationRepo.findOne({
      where: { id },
      relations: VERIFICATION_RELATIONS,
    });
    if (!verification) throw new NotFoundException('Skill verification request not found');
    const [withHistory] = await this.withHistory([toSkillVerificationResponse(verification)]);
    return withHistory;
  }

  async approve(
    id: string,
    reviewerId: string,
    dto: AttachSkillEvidenceDto,
  ): Promise<SkillVerificationResponseDto> {
    // The issued certificate must be in the bucket too. Checked before the
    // transaction so no database connection waits on the storage call.
    const target = await this.verificationRepo.findOne({
      where: { id },
      relations: ['technicianSkill', 'technicianSkill.technician'],
    });
    if (!target) throw new NotFoundException('Skill verification request not found');
    await this.assertUploaded(
      dto.storageObjectPath,
      target.technicianSkill.technician.userId,
    );

    const reviewed = await this.verificationRepo.manager.transaction(async (manager) => {
      const verifications = manager.getRepository(TechnicianSkillVerification);
      const verification = await verifications.findOne({
        where: { id },
        relations: ['technicianSkill', 'technicianSkill.technician', 'technicianSkill.technician.user'],
      });
      if (!verification) throw new NotFoundException('Skill verification request not found');
      assertSkillTaken(verification);

      const technicianUserId = verification.technicianSkill.technician.userId;
      this.storageService.validateObjectPath(dto.storageObjectPath, technicianUserId);

      const result = await verifications.update(
        { id, status: VerificationStatus.PENDING },
        { status: VerificationStatus.VERIFIED, reviewedById: reviewerId, reviewedAt: new Date() },
      );
      if (result.affected !== 1) {
        throw new ConflictException('Verification request is already processed');
      }

      await manager.getRepository(VerificationDocument).save(
        manager.getRepository(VerificationDocument).create({
          skillVerificationId: id,
          documentType: DocumentType.CERTIFICATE,
          storageObjectPath: dto.storageObjectPath,
          fileName: dto.fileName,
          fileSize: dto.fileSize,
          mimeType: dto.mimeType,
          issuedById: reviewerId,
        }),
      );

      const skillResult = await manager
        .getRepository(TechnicianSkill)
        .update(verification.technicianSkillId, {
          verificationStatus: VerificationStatus.VERIFIED,
        });
      if (skillResult.affected !== 1) {
        throw new NotFoundException('Technician skill not found');
      }

      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: reviewerId,
        actorRole: Role.SERVICE_MANAGER,
        action: 'SKILL_VERIFICATION_APPROVED',
        resourceType: 'technician_skill_verification',
        resourceId: id,
        before: { status: verification.status },
        after: { status: VerificationStatus.VERIFIED, reviewedById: reviewerId },
      });

      const updated = await verifications.findOne({ where: { id }, relations: VERIFICATION_RELATIONS });
      if (!updated) throw new NotFoundException('Skill verification request not found');
      return updated;
    });
    this.notifyTechnician(reviewed, 'approved');
    return toSkillVerificationResponse(reviewed);
  }

  async reject(
    id: string,
    reviewerId: string,
    dto: RejectSkillVerificationDto,
  ): Promise<SkillVerificationResponseDto> {
    const reviewed = await this.verificationRepo.manager.transaction(async (manager) => {
      const verifications = manager.getRepository(TechnicianSkillVerification);
      const verification = await verifications.findOne({ where: { id }, relations: ['technicianSkill'] });
      if (!verification) throw new NotFoundException('Skill verification request not found');
      assertSkillTaken(verification);

      const result = await verifications.update(
        { id, status: VerificationStatus.PENDING },
        {
          status: VerificationStatus.REJECTED,
          reviewedById: reviewerId,
          reviewedAt: new Date(),
          rejectionReason: dto.rejectionReason.trim(),
        },
      );
      if (result.affected !== 1) {
        throw new ConflictException('Verification request is already processed');
      }

      const skillResult = await manager
        .getRepository(TechnicianSkill)
        .update(verification.technicianSkillId, {
          verificationStatus: VerificationStatus.REJECTED,
        });
      if (skillResult.affected !== 1) {
        throw new NotFoundException('Technician skill not found');
      }

      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: reviewerId,
        actorRole: Role.SERVICE_MANAGER,
        action: 'SKILL_VERIFICATION_REJECTED',
        resourceType: 'technician_skill_verification',
        resourceId: id,
        before: { status: verification.status },
        after: {
          status: VerificationStatus.REJECTED,
          reviewedById: reviewerId,
          rejectionReason: dto.rejectionReason.trim(),
        },
      });

      const updated = await verifications.findOne({ where: { id }, relations: VERIFICATION_RELATIONS });
      if (!updated) throw new NotFoundException('Skill verification request not found');
      return updated;
    });
    this.notifyTechnician(reviewed, 'rejected');
    return toSkillVerificationResponse(reviewed);
  }

  private async assertUploaded(
    storageObjectPath: string,
    technicianUserId: string,
  ): Promise<void> {
    this.storageService.validateObjectPath(storageObjectPath, technicianUserId);
    const exists = await this.storageService.objectExists(
      storageObjectPath,
      technicianUserId,
    );
    if (!exists) throw new BadRequestException(SKILL_EVIDENCE_NOT_UPLOADED);
  }

  async createCertificateUploadUrl(
    verificationId: string,
    mimeType: string,
  ): Promise<KycSignedUpload> {
    const verification = await this.verificationRepo.findOne({
      where: { id: verificationId },
      relations: ['technicianSkill', 'technicianSkill.technician'],
    });
    if (!verification) throw new NotFoundException('Skill verification request not found');

    return this.storageService.createSignedUploadUrl(
      verification.technicianSkill.technician.userId,
      mimeType,
    );
  }

  async getSignedDocumentAccess(
    documentId: string,
    actor: { id: string; role: Role },
  ): Promise<KycSignedAccess> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
      relations: ['skillVerification', 'skillVerification.technicianSkill', 'skillVerification.technicianSkill.technician'],
    });
    if (!document || !document.skillVerification) {
      throw new NotFoundException('Verification document not found');
    }

    const technicianUserId = document.skillVerification.technicianSkill.technician.userId;
    const isAdmin = actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER;
    const isOwner = actor.role === Role.TECHNICIAN && technicianUserId === actor.id;
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException('You do not have permission to access this document');
    }
    if (!document.storageObjectPath) {
      throw new NotFoundException('This document has no private storage reference');
    }

    return this.storageService.createSignedAccess(document.storageObjectPath, technicianUserId);
  }
}
