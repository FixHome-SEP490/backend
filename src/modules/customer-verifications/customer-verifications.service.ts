import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { PaginationMeta } from '../../shared/dto';
import { AccountStatus, Role, VerificationStatus } from '../../shared/enums';
import { ageInYearsOnVnToday } from '../../shared/utils/vn-time';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  KycSignedAccess,
  KycSignedUpload,
  KycStorageService,
} from '../technician-verifications/kyc-storage.service';
import { User } from '../users/entities/user.entity';
import {
  VN_FROM,
  VN_TO,
  foldVietnamese,
  phoneDigitsVariants,
} from '../technicians/admin-technicians.service';
import {
  CUSTOMER_KYC_DOCUMENT_TYPES,
  QueryCustomerVerificationsDto,
  RequestCustomerKycUploadUrlDto,
  SubmitCustomerVerificationDto,
} from './dto/customer-verification.dto';
import {
  CustomerKycStatus,
  CustomerVerificationView,
  kycStatusOf,
  toCustomerVerificationView,
  toIsoDate,
} from './customer-verifications.mapper';
import { CustomerVerificationDocument } from './entities/customer-verification-document.entity';
import { CustomerVerification } from './entities/customer-verification.entity';

/** Same rule as technician onboarding: the identity holder must be an adult. */
export const CUSTOMER_KYC_MIN_AGE = 18;

const MIME_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};

export interface CustomerKycState {
  status: CustomerKycStatus;
  rejectionReason: string | null;
  verification: CustomerVerificationView | null;
  /** The profile as it stands, to prefill the form. */
  profile: {
    fullName: string;
    dateOfBirth: string | null;
    gender: string | null;
    citizenIdNumber: string | null;
    address: string | null;
  };
}

/**
 * Identity verification for customers (PO 14/10/2026), the gate in front of
 * saving a bank account and withdrawing the customer wallet.
 *
 * The customer confirms their details as printed on the citizen ID card and
 * uploads both sides of it, nothing else (no face photo, no video). Only an
 * admin reviews, as for technicians (BRX-041). Once approved, the name and
 * date of birth on the profile are locked and the name is frozen on the row
 * for the bank account check.
 */
@Injectable()
export class CustomerVerificationsService {
  private readonly logger = new Logger(CustomerVerificationsService.name);

  constructor(
    @InjectRepository(CustomerVerification)
    private readonly verificationRepo: Repository<CustomerVerification>,
    @InjectRepository(CustomerVerificationDocument)
    private readonly documentRepo: Repository<CustomerVerificationDocument>,
    private readonly storage: KycStorageService,
    private readonly auditLog: AuditLogService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ------------------------------------------------------------ customer side

  async latestOf(customerId: string): Promise<CustomerVerification | null> {
    return this.verificationRepo.findOne({
      where: { customerId },
      order: { submittedAt: 'DESC', createdAt: 'DESC' },
      relations: ['documents'],
    });
  }

  async getMine(customerId: string): Promise<CustomerKycState> {
    const [verification, user] = await Promise.all([
      this.latestOf(customerId),
      this.verificationRepo.manager.getRepository(User).findOne({ where: { id: customerId } }),
    ]);
    if (!user) throw new NotFoundException('Không tìm thấy tài khoản');
    return {
      status: kycStatusOf(verification),
      rejectionReason:
        verification?.status === VerificationStatus.REJECTED ? verification.rejectionReason : null,
      verification: verification ? toCustomerVerificationView(verification) : null,
      profile: {
        fullName: user.fullName,
        dateOfBirth: toIsoDate(user.dateOfBirth as unknown as string | Date | null),
        gender: user.gender ?? null,
        citizenIdNumber: user.citizenIdNumber ?? null,
        address: user.fullAddress ?? null,
      },
    };
  }

  /** KYC status in one word, for the wallet screen. */
  async statusOf(customerId: string): Promise<{ status: CustomerKycStatus; rejectionReason: string | null }> {
    const verification = await this.verificationRepo.findOne({
      where: { customerId },
      order: { submittedAt: 'DESC', createdAt: 'DESC' },
    });
    return {
      status: kycStatusOf(verification),
      rejectionReason:
        verification?.status === VerificationStatus.REJECTED ? verification.rejectionReason : null,
    };
  }

  /**
   * The name a bank account holder must match: the one frozen at approval.
   * Anything short of an approved KYC is refused with what to do next.
   */
  async requireVerifiedName(customerId: string, purpose: 'bank_account' | 'withdraw'): Promise<string> {
    const verified = await this.verificationRepo.findOne({
      where: { customerId, status: VerificationStatus.VERIFIED },
      order: { reviewedAt: 'DESC' },
    });
    if (verified?.verifiedFullName?.trim()) return verified.verifiedFullName;
    if (verified) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Hồ sơ xác minh danh tính chưa ghi nhận họ tên. Vui lòng liên hệ FixHome.',
      );
    }
    const { status } = await this.statusOf(customerId);
    const action = purpose === 'withdraw' ? 'rút tiền' : 'khai báo tài khoản nhận tiền';
    const message =
      status === 'pending'
        ? `Hồ sơ xác minh danh tính của bạn đang chờ duyệt. Bạn có thể ${action} sau khi hồ sơ được duyệt.`
        : status === 'rejected'
          ? `Hồ sơ xác minh danh tính của bạn chưa được duyệt. Vui lòng gửi lại hồ sơ trước khi ${action}.`
          : `Bạn cần xác minh danh tính (CCCD) trước khi ${action}.`;
    throw new BusinessException(ErrorCodes.VALIDATION_FAILED, message);
  }

  async createUploadUrl(customerId: string, dto: RequestCustomerKycUploadUrlDto): Promise<KycSignedUpload> {
    const user = await this.verificationRepo.manager.getRepository(User).findOne({ where: { id: customerId } });
    this.assertActiveCustomer(user);
    if (!MIME_EXTENSIONS[dto.mimeType]) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Chỉ nhận ảnh JPG, PNG hoặc WEBP');
    }
    return this.storage.createSignedUploadUrl(customerId, dto.mimeType);
  }

  async submit(customerId: string, dto: SubmitCustomerVerificationDto): Promise<CustomerKycState> {
    this.validateIdentity(dto);
    this.validateDocuments(customerId, dto);

    const fullName = dto.fullName.trim().replace(/\s+/g, ' ');
    const address = dto.address.trim().replace(/\s+/g, ' ');

    const saved = await this.verificationRepo.manager.transaction(async (manager) => {
      const user = await manager.getRepository(User).findOne({
        where: { id: customerId },
        lock: { mode: 'pessimistic_write' },
      });
      this.assertActiveCustomer(user);

      const verifications = manager.getRepository(CustomerVerification);
      const open = await verifications.findOne({
        where: [
          { customerId, status: VerificationStatus.PENDING },
          { customerId, status: VerificationStatus.VERIFIED },
        ],
      });
      if (open?.status === VerificationStatus.PENDING) {
        throw new ConflictException('Hồ sơ xác minh của bạn đang chờ duyệt, vui lòng đợi kết quả.');
      }
      if (open) {
        throw new ConflictException('Danh tính của bạn đã được xác minh, không cần gửi lại.');
      }

      const taken = await manager
        .getRepository(User)
        .createQueryBuilder('u')
        .where('u.citizen_id_number = :cccd', { cccd: dto.citizenIdNumber })
        .andWhere('u.id <> :id', { id: customerId })
        .getExists();
      if (taken) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Số CCCD này đã được sử dụng bởi tài khoản khác.',
        );
      }

      const verification = await verifications.save(
        verifications.create({
          customerId,
          status: VerificationStatus.PENDING,
          fullName,
          dateOfBirth: dto.dateOfBirth,
          gender: dto.gender,
          citizenIdNumber: dto.citizenIdNumber,
          fullAddress: address,
          submittedAt: new Date(),
          reviewedAt: null,
          reviewedById: null,
          rejectionReason: null,
          verifiedFullName: null,
        }),
      );
      const documentRepo = manager.getRepository(CustomerVerificationDocument);
      verification.documents = await documentRepo.save(
        dto.documents.map((doc) =>
          documentRepo.create({
            verificationId: verification.id,
            documentType: doc.documentType,
            storageObjectPath: doc.storageObjectPath,
            fileName: doc.fileName,
            fileSize: doc.fileSize,
            mimeType: doc.mimeType,
          }),
        ),
      );

      // The details confirmed against the card become the profile (PO 14/10/2026).
      await manager.getRepository(User).update(customerId, {
        fullName,
        dateOfBirth: dto.dateOfBirth as unknown as Date,
        gender: dto.gender,
        citizenIdNumber: dto.citizenIdNumber,
        fullAddress: address,
      });

      await this.auditLog.logWithManagerStrict(manager, {
        actorUserId: customerId,
        actorRole: Role.CUSTOMER,
        action: 'CUSTOMER_KYC_SUBMITTED',
        resourceType: 'customer_verification',
        resourceId: verification.id,
        after: {
          status: VerificationStatus.PENDING,
          citizenIdTail: dto.citizenIdNumber.slice(-4),
          documents: dto.documents.map((d) => d.documentType),
        },
      });
      return verification;
    });

    this.logger.log(`Customer ${customerId} submitted KYC ${saved.id}`);
    return this.getMine(customerId);
  }

  async getMyDocumentAccess(customerId: string, documentId: string): Promise<KycSignedAccess> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
      relations: ['verification'],
    });
    // Someone else's document reads as missing, not forbidden.
    if (!document?.verification || document.verification.customerId !== customerId) {
      throw new NotFoundException('Không tìm thấy giấy tờ');
    }
    return this.storage.createSignedAccess(document.storageObjectPath, customerId);
  }

  // --------------------------------------------------------------- admin side

  async list(query: QueryCustomerVerificationsDto): Promise<{ data: CustomerVerificationView[]; meta: PaginationMeta }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const qb = this.verificationRepo
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.customer', 'c')
      .leftJoinAndSelect('v.documents', 'd')
      .leftJoinAndSelect('v.reviewedBy', 'r');
    if (query.status) qb.andWhere('v.status = :status', { status: query.status });

    const text = query.search?.trim() ?? '';
    if (text) {
      const folded = foldVietnamese(text).replace(/[\\%_]/g, (ch) => '\\' + ch);
      const like = text.replace(/[\\%_]/g, (ch) => '\\' + ch);
      qb.andWhere(
        new Brackets((w) => {
          w.where(`translate(lower(COALESCE(v.full_name, '')), :vnFrom, :vnTo) LIKE :folded ESCAPE '\\'`, {
            vnFrom: VN_FROM,
            vnTo: VN_TO,
            folded: `%${folded}%`,
          })
            .orWhere(`translate(lower(COALESCE(c.full_name, '')), :vnFrom, :vnTo) LIKE :folded ESCAPE '\\'`)
            .orWhere(`c.email ILIKE :like ESCAPE '\\'`, { like: `%${like}%` });
          phoneDigitsVariants(text).forEach((digits, i) => {
            w.orWhere(`regexp_replace(COALESCE(c.phone_number, ''), '\\D', '', 'g') LIKE :phone${i}`, {
              [`phone${i}`]: `%${digits}%`,
            });
          });
          const cccd = text.replace(/\D/g, '');
          if (cccd.length >= 3) w.orWhere('v.citizen_id_number LIKE :cccd', { cccd: `${cccd}%` });
        }),
      );
    }

    // Newest first; the reviewer filters on status=pending for the queue.
    qb.orderBy('v.submittedAt', 'DESC')
      .addOrderBy('v.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      data: rows.map(toCustomerVerificationView),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async detail(id: string): Promise<CustomerVerificationView> {
    const verification = await this.verificationRepo.findOne({
      where: { id },
      relations: ['customer', 'documents', 'reviewedBy'],
    });
    if (!verification) throw new NotFoundException('Không tìm thấy hồ sơ xác minh');
    return toCustomerVerificationView(verification);
  }

  async documentAccess(verificationId: string, documentId: string): Promise<KycSignedAccess> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId, verificationId },
      relations: ['verification'],
    });
    if (!document?.verification) throw new NotFoundException('Không tìm thấy giấy tờ');
    return this.storage.createSignedAccess(document.storageObjectPath, document.verification.customerId);
  }

  async approve(id: string, reviewerId: string): Promise<CustomerVerificationView> {
    return this.review(id, reviewerId, VerificationStatus.VERIFIED, null);
  }

  async reject(id: string, reviewerId: string, rejectionReason: string): Promise<CustomerVerificationView> {
    const reason = rejectionReason?.trim() ?? '';
    if (reason.length < 5) {
      throw new BadRequestException('Lý do từ chối tối thiểu 5 ký tự');
    }
    return this.review(id, reviewerId, VerificationStatus.REJECTED, reason);
  }

  private async review(
    id: string,
    reviewerId: string,
    status: VerificationStatus.VERIFIED | VerificationStatus.REJECTED,
    rejectionReason: string | null,
  ): Promise<CustomerVerificationView> {
    const reviewed = await this.verificationRepo.manager.transaction(async (manager) => {
      const verifications = manager.getRepository(CustomerVerification);
      const verification = await verifications.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!verification) throw new NotFoundException('Không tìm thấy hồ sơ xác minh');
      if (verification.status !== VerificationStatus.PENDING) {
        throw new ConflictException('Hồ sơ này đã được xử lý trước đó');
      }
      const customer = await manager.getRepository(User).findOne({
        where: { id: verification.customerId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!customer || customer.role !== Role.CUSTOMER) {
        throw new NotFoundException('Không tìm thấy khách hàng của hồ sơ này');
      }

      const now = new Date();
      await verifications.update(
        { id, status: VerificationStatus.PENDING },
        {
          status,
          reviewedById: reviewerId,
          reviewedAt: now,
          rejectionReason,
          ...(status === VerificationStatus.VERIFIED ? { verifiedFullName: verification.fullName } : {}),
        },
      );

      if (status === VerificationStatus.VERIFIED) {
        // What the admin approved is what the profile keeps from now on: any
        // edit made while the request waited is replaced by the checked values.
        await manager.getRepository(User).update(customer.id, {
          fullName: verification.fullName,
          dateOfBirth: toIsoDate(verification.dateOfBirth) as unknown as Date,
          gender: verification.gender,
          citizenIdNumber: verification.citizenIdNumber,
          fullAddress: verification.fullAddress,
        });
      }

      await this.auditLog.logWithManagerStrict(manager, {
        actorUserId: reviewerId,
        actorRole: Role.ADMIN,
        action: status === VerificationStatus.VERIFIED ? 'CUSTOMER_KYC_APPROVED' : 'CUSTOMER_KYC_REJECTED',
        resourceType: 'customer_verification',
        resourceId: id,
        before: { status: verification.status },
        after: { status, customerId: verification.customerId, rejectionReason },
      });
      return verification;
    });

    this.notifyDecision(reviewed.customerId, reviewed.id, status, rejectionReason);
    return this.detail(id);
  }

  // ------------------------------------------------------------------ helpers

  private notifyDecision(
    customerId: string,
    verificationId: string,
    status: VerificationStatus,
    rejectionReason: string | null,
  ): void {
    if (!this.notifications) return;
    const notice =
      status === VerificationStatus.VERIFIED
        ? {
            title: 'Đã xác minh danh tính',
            message:
              'Hồ sơ xác minh danh tính của bạn đã được duyệt. Bạn có thể khai báo tài khoản ngân hàng và rút tiền từ ví.',
            type: 'CUSTOMER_KYC_APPROVED',
          }
        : {
            title: 'Hồ sơ xác minh danh tính chưa được duyệt',
            message: `Hồ sơ xác minh danh tính của bạn chưa đạt yêu cầu. Lý do: ${rejectionReason ?? 'Vui lòng kiểm tra lại thông tin và ảnh CCCD'}. Bạn có thể gửi lại hồ sơ.`,
            type: 'CUSTOMER_KYC_REJECTED',
          };
    void this.notifications
      .createNotification({
        userId: customerId,
        ...notice,
        referenceType: 'customer_verification',
        referenceId: verificationId,
      })
      .catch((error: unknown) =>
        this.logger.warn(`KYC notification failed: ${error instanceof Error ? error.message : String(error)}`),
      );
  }

  private assertActiveCustomer(user: User | null): asserts user is User {
    if (!user || user.role !== Role.CUSTOMER) {
      throw new ForbiddenException('Chức năng này chỉ dành cho khách hàng');
    }
    if (user.status !== AccountStatus.ACTIVE || !user.isActive) {
      throw new ForbiddenException('Tài khoản của bạn đang không hoạt động');
    }
  }

  private validateIdentity(dto: SubmitCustomerVerificationDto): void {
    const year = Number(dto.dateOfBirth.slice(0, 4));
    const age = ageInYearsOnVnToday(dto.dateOfBirth);
    if (!Number.isFinite(age) || year < 1900 || age < 0) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Ngày sinh không hợp lệ');
    }
    if (age < CUSTOMER_KYC_MIN_AGE) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        `Phải đủ ${CUSTOMER_KYC_MIN_AGE} tuổi trở lên để xác minh danh tính và rút tiền.`,
      );
    }
  }

  /** Exactly the front and the back of the card, both uploaded by this customer. */
  private validateDocuments(customerId: string, dto: SubmitCustomerVerificationDto): void {
    const documents = dto.documents ?? [];
    const types = documents.map((d) => d.documentType).sort();
    if (
      documents.length !== CUSTOMER_KYC_DOCUMENT_TYPES.length ||
      types.join(',') !== [...CUSTOMER_KYC_DOCUMENT_TYPES].sort().join(',')
    ) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Cần đúng hai ảnh: mặt trước và mặt sau CCCD.',
      );
    }
    if (new Set(documents.map((d) => d.storageObjectPath)).size !== documents.length) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Ảnh mặt trước và mặt sau phải là hai ảnh khác nhau.',
      );
    }
    for (const doc of documents) {
      try {
        this.storage.validateObjectPath(doc.storageObjectPath, customerId);
      } catch {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Ảnh giấy tờ không thuộc hồ sơ của bạn. Vui lòng tải ảnh lên lại.',
        );
      }
      const extension = doc.fileName.split('.').pop()?.toLowerCase() ?? '';
      const pathExtension = doc.storageObjectPath.split('.').pop()?.toLowerCase() ?? '';
      const allowed = MIME_EXTENSIONS[doc.mimeType];
      if (!allowed || !allowed.includes(extension) || !allowed.includes(pathExtension)) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'Định dạng ảnh không khớp. Chỉ nhận ảnh JPG, PNG hoặc WEBP.',
        );
      }
    }
  }
}
