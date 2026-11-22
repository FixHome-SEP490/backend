import { ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { startBackgroundJob } from '../../common/background-job';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { DocumentType, Role } from '../../shared/enums';
import { OrderEvidenceStorage } from '../media/order-evidence-storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BusinessConfigService } from '../system-config/business-config.service';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { KycStorageService } from '../technician-verifications/kyc-storage.service';
import { User } from '../users/entities/user.entity';
import { CheckinFaceReview, CheckinFaceReviewStatus } from './entities/checkin-face-review.entity';
import { RepairEvidence } from './entities/repair-evidence.entity';
import { ServiceOrder } from './entities/service-order.entity';

export type CheckinFaceReviewListItem = {
  id: string;
  status: CheckinFaceReviewStatus;
  similarity: number | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
  orderId: string;
  orderCode: string;
  technicianId: string;
  technicianName: string;
};

const BATCH = 20;
const MINUTE_MS = 60_000;

/** Service manager review of a check-in face that did not match the registered face, and the alerts around it. */
@Injectable()
export class CheckinFaceReviewService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckinFaceReviewService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(CheckinFaceReview) private readonly reviews: Repository<CheckinFaceReview>,
    @InjectRepository(VerificationDocument) private readonly documents: Repository<VerificationDocument>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly config: BusinessConfigService,
    private readonly evidenceStorage: OrderEvidenceStorage,
    private readonly kyc: KycStorageService,
  ) {}

  onModuleInit(): void {
    this.timer = startBackgroundJob('checkin face review reminder', this.logger, async () => { await this.sweepOverdue(); });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Retake requests since the technician's last outcome for this order. */
  async retakeCount(orderId: string, technicianId: string): Promise<number> {
    const last = await this.reviews.createQueryBuilder('r')
      .select('MAX(r.created_at)', 'at')
      .where('r.service_order_id = :orderId AND r.technician_id = :technicianId AND r.status != :retake', { orderId, technicianId, retake: 'retake' })
      .getRawOne<{ at: Date | null }>();
    const query = this.reviews.createQueryBuilder('r')
      .where('r.service_order_id = :orderId AND r.technician_id = :technicianId AND r.status = :retake', { orderId, technicianId, retake: 'retake' });
    if (last?.at) query.andWhere('r.created_at > :at', { at: last.at });
    return query.getCount();
  }

  async recordRetake(orderId: string, technicianId: string, similarity: number): Promise<void> {
    await this.reviews.save(this.reviews.create({ groupId: randomUUID(), serviceOrderId: orderId, technicianId, similarity, status: 'retake' }));
  }

  /** A face clearly unlike the registered one: managers hear at once, even though the technician may retake. */
  async notifyFlagged(orderId: string, technicianId: string, similarity: number): Promise<void> {
    const { code, name } = await this.describe(orderId, technicianId);
    await this.notifyManagers(
      'CHECKIN_FACE_FLAGGED',
      'Khuôn mặt check-in lệch rõ',
      `Kỹ thuật viên ${name} check-in đơn ${code} nhưng khuôn mặt chỉ khớp ảnh đăng ký ${similarity}%. Hệ thống đã yêu cầu chụp lại.`,
      orderId,
    );
  }

  async notifyReviewRequired(orderId: string, technicianId: string, similarity: number | null): Promise<void> {
    const { code, name } = await this.describe(orderId, technicianId);
    await this.notifyManagers(
      'CHECKIN_FACE_REVIEW_REQUIRED',
      'Cần xác nhận khuôn mặt check-in',
      `Khuôn mặt của kỹ thuật viên ${name} ở đơn ${code} chưa khớp ảnh đăng ký${similarity == null ? '' : ` (${similarity}%)`}. Vui lòng xem và xác nhận.`,
      orderId,
    );
  }

  async list(query: { status?: 'pending' | 'approved' | 'rejected'; page: number; limit: number }) {
    const status = query.status ?? 'pending';
    const inner = `SELECT DISTINCT ON (r.group_id) r.id, r.status, r.similarity, r.created_at, r.reviewed_at, r.review_note,
        o.id AS order_id, o.code AS order_code, u.id AS technician_id, u.full_name AS technician_name
      FROM checkin_face_reviews r
      JOIN service_orders o ON o.id = r.service_order_id
      JOIN users u ON u.id = r.technician_id
      WHERE r.status = $1
      ORDER BY r.group_id, o.code`;
    const [rows, total] = await Promise.all([
      this.dataSource.query(`SELECT * FROM (${inner}) t ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`, [status, query.limit, (query.page - 1) * query.limit]),
      this.dataSource.query('SELECT COUNT(DISTINCT group_id)::int AS n FROM checkin_face_reviews WHERE status = $1', [status]),
    ]);
    const data: CheckinFaceReviewListItem[] = rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      status: r.status as CheckinFaceReviewStatus,
      similarity: r.similarity == null ? null : Number(r.similarity),
      createdAt: new Date(r.created_at as string).toISOString(),
      reviewedAt: r.reviewed_at ? new Date(r.reviewed_at as string).toISOString() : null,
      reviewNote: (r.review_note as string | null) ?? null,
      orderId: r.order_id as string,
      orderCode: r.order_code as string,
      technicianId: r.technician_id as string,
      technicianName: r.technician_name as string,
    }));
    return { data, total: Number(total[0]?.n ?? 0) };
  }

  /** The two photos to compare, as short-lived signed URLs; a photo that cannot be read comes back null. */
  async detail(id: string) {
    const review = await this.reviews.findOneBy({ id });
    if (!review || review.status === 'retake') throw new NotFoundException('Không tìm thấy yêu cầu xác nhận khuôn mặt');
    const [order, technician, evidence, registered, retakeCount] = await Promise.all([
      this.dataSource.manager.findOneBy(ServiceOrder, { id: review.serviceOrderId }),
      this.dataSource.manager.findOneBy(User, { id: review.technicianId }),
      review.evidenceId ? this.dataSource.manager.findOneBy(RepairEvidence, { id: review.evidenceId }) : null,
      this.documents.createQueryBuilder('d').innerJoin('d.verification', 'v')
        .where('v.technician_id = :technicianId', { technicianId: review.technicianId })
        .andWhere('d.document_type = :type', { type: DocumentType.FACE_PHOTO })
        .andWhere('d.storage_object_path IS NOT NULL')
        .orderBy('d.created_at', 'DESC')
        .getOne(),
      this.retakesBefore(review),
    ]);
    const checkinPhotoUrl = evidence ? await this.evidenceStorage.signedUrl(evidence.mediaUrl).catch(() => null) : null;
    const registeredPhotoUrl = registered?.storageObjectPath
      ? await this.kyc.createSignedAccess(registered.storageObjectPath, review.technicianId).then(a => a.signedUrl).catch(() => null)
      : null;
    return {
      id: review.id,
      status: review.status,
      similarity: review.similarity ?? null,
      retakeCount,
      createdAt: review.createdAt.toISOString(),
      reviewedAt: review.reviewedAt?.toISOString() ?? null,
      reviewNote: review.reviewNote ?? null,
      orderId: review.serviceOrderId,
      orderCode: order?.code ?? '',
      technicianId: review.technicianId,
      technicianName: technician?.fullName ?? '',
      checkinPhotoUrl,
      registeredPhotoUrl,
    };
  }

  /** Approve opens the next step for every order of the visit; reject asks the technician to retake. */
  async review(id: string, reviewerId: string, input: { approve: boolean; note?: string }): Promise<void> {
    const note = input.note?.trim() || null;
    if (!input.approve && (!note || note.length < 5)) {
      throw new BusinessException(ErrorCodes.VALIDATION_FAILED, 'Nhập lý do từ chối (ít nhất 5 ký tự).');
    }
    const target = await this.dataSource.transaction(async manager => {
      const row = await manager.findOne(CheckinFaceReview, { where: { id }, lock: { mode: 'pessimistic_write' } });
      if (!row) throw new NotFoundException('Không tìm thấy yêu cầu xác nhận khuôn mặt');
      if (row.status !== 'pending') throw new ConflictException('Yêu cầu này đã được xử lý.');
      await manager.update(CheckinFaceReview, { groupId: row.groupId, status: 'pending' }, {
        status: input.approve ? 'approved' : 'rejected',
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewNote: note,
      });
      return row;
    });
    const { code } = await this.describe(target.serviceOrderId, target.technicianId);
    try {
      await this.notifications.createNotification(input.approve
        ? {
          userId: target.technicianId,
          type: 'CHECKIN_FACE_APPROVED',
          referenceId: target.serviceOrderId,
          referenceType: 'SERVICE_ORDER',
          title: 'Khuôn mặt check-in đã được xác nhận',
          message: `Quản lý dịch vụ đã xác nhận khuôn mặt của bạn ở đơn ${code}. Bạn có thể tiếp tục chụp ảnh trước sửa chữa.`,
        }
        : {
          userId: target.technicianId,
          type: 'CHECKIN_FACE_REJECTED',
          referenceId: target.serviceOrderId,
          referenceType: 'SERVICE_ORDER',
          title: 'Khuôn mặt check-in chưa được xác nhận',
          message: `Lý do: ${note}. Vui lòng chụp lại ảnh khuôn mặt check-in ở đơn ${code}.`,
        });
    } catch (error) {
      this.logger.warn(`Check-in face decision notification failed: ${(error as Error).message}`);
    }
  }

  /** Reminds the managers once about a request that waited longer than the configured minutes. */
  async sweepOverdue(now = new Date()): Promise<void> {
    const minutes = await this.config.getInt('checkin_face.review_sla_minutes', 10);
    const overdue = await this.reviews.find({
      where: { status: 'pending', remindedAt: IsNull(), createdAt: LessThan(new Date(now.getTime() - minutes * MINUTE_MS)) },
      order: { createdAt: 'ASC' },
      take: BATCH,
    });
    const seen = new Set<string>();
    for (const row of overdue) {
      if (seen.has(row.groupId)) continue;
      seen.add(row.groupId);
      try {
        const { code, name } = await this.describe(row.serviceOrderId, row.technicianId);
        await this.notifyManagers(
          'CHECKIN_FACE_REVIEW_OVERDUE',
          'Khuôn mặt check-in đang chờ quá lâu',
          `Kỹ thuật viên ${name} đang chờ xác nhận khuôn mặt ở đơn ${code} hơn ${minutes} phút.`,
          row.serviceOrderId,
        );
        await this.reviews.update({ groupId: row.groupId, status: 'pending' }, { remindedAt: now });
      } catch (error) {
        this.logger.warn(`Check-in face reminder failed: ${(error as Error).message}`);
      }
    }
  }

  private async retakesBefore(review: CheckinFaceReview): Promise<number> {
    const params = { o: review.serviceOrderId, t: review.technicianId, retake: 'retake', at: review.createdAt };
    const previous = await this.reviews.createQueryBuilder('r').select('MAX(r.created_at)', 'at')
      .where('r.service_order_id = :o AND r.technician_id = :t AND r.status != :retake AND r.created_at < :at', params)
      .getRawOne<{ at: Date | null }>();
    const query = this.reviews.createQueryBuilder('r')
      .where('r.service_order_id = :o AND r.technician_id = :t AND r.status = :retake AND r.created_at < :at', params);
    if (previous?.at) query.andWhere('r.created_at > :prev', { prev: previous.at });
    return query.getCount();
  }

  private async describe(orderId: string, technicianId: string): Promise<{ code: string; name: string }> {
    const [order, technician] = await Promise.all([
      this.dataSource.manager.findOneBy(ServiceOrder, { id: orderId }),
      this.dataSource.manager.findOneBy(User, { id: technicianId }),
    ]);
    return { code: order?.code ?? '', name: technician?.fullName ?? '' };
  }

  private async notifyManagers(type: string, title: string, message: string, orderId: string): Promise<void> {
    try {
      const managers = await this.dataSource.manager.find(User, { where: { role: Role.SERVICE_MANAGER, isActive: true }, select: ['id'] });
      await this.notifications.createManyNotifications(managers.map(m => ({
        userId: m.id, title, message, type, referenceId: orderId, referenceType: 'SERVICE_ORDER',
      })));
    } catch (error) {
      this.logger.warn(`Check-in face notification failed: ${(error as Error).message}`);
    }
  }
}
