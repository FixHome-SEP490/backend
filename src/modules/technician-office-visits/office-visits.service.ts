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
import { OnboardingStatus, Role, VerificationStatus } from '../../shared/enums';
import { VN_OFFSET_MS } from '../../shared/utils/vn-time';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BusinessConfigService } from '../system-config/business-config.service';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import {
  BookOfficeVisitDto,
  CreateVisitOfficeDto,
  MarkOfficeVisitDto,
  QueryOfficeVisitsDto,
  UpdateVisitOfficeDto,
} from './dto/office-visit.dto';
import { OfficeVisit, OfficeVisitStatus } from './entities/office-visit.entity';
import { VisitOffice } from './entities/visit-office.entity';
import { computeSlots, isBookableSlot, rankOfficesByDistance } from './office-visit-rules';

const minutes = (time: string | null | undefined): number | null => {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

@Injectable()
export class OfficeVisitsService {
  constructor(
    @InjectRepository(VisitOffice) private readonly offices: Repository<VisitOffice>,
    @InjectRepository(OfficeVisit) private readonly visits: Repository<OfficeVisit>,
    @InjectRepository(TechnicianProfile) private readonly profiles: Repository<TechnicianProfile>,
    private readonly config: BusinessConfigService,
    private readonly audit: AuditLogService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  // ── Cấu hình ───────────────────────────────────────────────────────────

  private async settings() {
    const [maxMissed, daysAhead, minNoticeHours, supportPhone] = await Promise.all([
      this.config.getInt('office.max_missed_visits', 2),
      this.config.getInt('office.visit_days_ahead', 7),
      this.config.getInt('office.min_notice_hours', 2),
      this.config.getString('office.support_phone', ''),
    ]);
    return { maxMissed, daysAhead, minNoticeHours, supportPhone };
  }

  // ── Trụ sở (admin) ─────────────────────────────────────────────────────

  listOffices(): Promise<VisitOffice[]> {
    return this.offices.find({ order: { name: 'ASC' } });
  }

  async createOffice(dto: CreateVisitOfficeDto): Promise<VisitOffice> {
    const office = this.offices.create({ ...dto, latitude: dto.latitude ?? null, longitude: dto.longitude ?? null, phone: dto.phone ?? null });
    this.assertSchedule(office);
    return this.offices.save(office);
  }

  async updateOffice(id: string, dto: UpdateVisitOfficeDto): Promise<VisitOffice> {
    const office = await this.offices.findOne({ where: { id } });
    if (!office) throw new NotFoundException('Không tìm thấy trụ sở');
    Object.assign(office, dto);
    this.assertSchedule(office);
    return this.offices.save(office);
  }

  private assertSchedule(office: VisitOffice): void {
    const open = minutes(office.openTime ?? '08:00') as number;
    const close = minutes(office.closeTime ?? '17:00') as number;
    if (open >= close) throw new BadRequestException('Giờ mở cửa phải trước giờ đóng cửa');
    const lunchStart = minutes(office.lunchStart);
    const lunchEnd = minutes(office.lunchEnd);
    if ((lunchStart === null) !== (lunchEnd === null)) throw new BadRequestException('Nghỉ trưa cần cả giờ bắt đầu và giờ kết thúc');
    if (lunchStart !== null && lunchEnd !== null && (lunchStart >= lunchEnd || lunchStart < open || lunchEnd > close)) {
      throw new BadRequestException('Giờ nghỉ trưa phải nằm trong giờ làm việc');
    }
    if ((office.latitude === null) !== (office.longitude === null)) throw new BadRequestException('Vị trí cần cả vĩ độ và kinh độ');
  }

  // ── Thợ ────────────────────────────────────────────────────────────────

  private async profileOrFail(userId: string): Promise<TechnicianProfile> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) throw new NotFoundException('Technician profile not found');
    return profile;
  }

  private async missedCount(technicianId: string): Promise<number> {
    return this.visits.count({ where: { technicianId, status: OfficeVisitStatus.MISSED } });
  }

  /** Lịch hiện tại, trụ sở sắp theo khoảng cách (gần nhất được gợi ý) và các lượt còn trống của từng trụ sở. */
  async getMine(userId: string) {
    const profile = await this.profileOrFail(userId);
    const cfg = await this.settings();
    const [current, missed, activeOffices] = await Promise.all([
      this.visits.findOne({ where: { technicianId: userId, status: OfficeVisitStatus.SCHEDULED }, relations: ['office'] }),
      this.missedCount(userId),
      this.offices.find({ where: { isActive: true } }),
    ]);
    const attended = await this.visits.exists({ where: { technicianId: userId, status: OfficeVisitStatus.ATTENDED } });
    const blocked = missed >= cfg.maxMissed;
    const canBook = !!profile.identityVerifiedAt && !blocked && !attended && profile.verificationStatus !== VerificationStatus.VERIFIED;

    const now = new Date();
    const upcoming = await this.visits.find({ where: { officeId: In(activeOffices.map((o) => o.id)), status: OfficeVisitStatus.SCHEDULED } });
    const ranked = rankOfficesByDistance(activeOffices, { latitude: profile.latitude ?? null, longitude: profile.longitude ?? null });
    return {
      canBook,
      blocked,
      missedVisits: missed,
      maxMissedVisits: cfg.maxMissed,
      supportPhone: blocked ? cfg.supportPhone || null : null,
      current: current ? this.view(current) : null,
      offices: ranked.map((office) => ({
        id: office.id,
        name: office.name,
        address: office.address,
        phone: office.phone,
        latitude: office.latitude,
        longitude: office.longitude,
        distanceKm: office.distanceKm,
        recommended: office.recommended,
        slots: canBook
          ? computeSlots(office, {
              now,
              daysAhead: cfg.daysAhead,
              minNoticeHours: cfg.minNoticeHours,
              // Lượt của chính thợ không chiếm chỗ khi thợ đổi giờ.
              booked: upcoming.filter((v) => v.officeId === office.id && v.id !== current?.id).map((v) => v.scheduledAt),
            })
          : [],
      })),
    };
  }

  private view(visit: OfficeVisit) {
    return {
      id: visit.id,
      officeId: visit.officeId,
      officeName: visit.office?.name ?? '',
      officeAddress: visit.office?.address ?? '',
      officePhone: visit.office?.phone ?? null,
      scheduledAt: visit.scheduledAt.toISOString(),
      status: visit.status,
    };
  }

  /** Đặt hoặc đổi lịch (đổi giờ hay đổi trụ sở): hủy lượt đang chờ rồi tạo lượt mới trong một transaction. */
  async book(userId: string, dto: BookOfficeVisitDto) {
    const cfg = await this.settings();
    const at = new Date(dto.scheduledAt);
    const result = await this.visits.manager.transaction(async (manager) => {
      const profile = await manager.getRepository(TechnicianProfile).findOne({ where: { userId }, lock: { mode: 'pessimistic_write' } });
      if (!profile) throw new NotFoundException('Technician profile not found');
      if (!profile.identityVerifiedAt) throw new ForbiddenException('Danh tính chưa được xác nhận nên chưa đặt lịch được.');
      if (profile.verificationStatus === VerificationStatus.VERIFIED || profile.onboardingStatus === OnboardingStatus.APPROVED) {
        throw new BadRequestException('Hồ sơ đã được duyệt.');
      }
      const visits = manager.getRepository(OfficeVisit);
      if (await visits.exists({ where: { technicianId: userId, status: OfficeVisitStatus.ATTENDED } })) {
        throw new BadRequestException('Bạn đã gặp trực tiếp, hồ sơ đang chờ duyệt.');
      }
      const missed = await visits.count({ where: { technicianId: userId, status: OfficeVisitStatus.MISSED } });
      if (missed >= cfg.maxMissed) {
        throw new ForbiddenException(
          `Bạn đã vắng ${missed} lần.${cfg.supportPhone ? ` Vui lòng liên hệ quản lý dịch vụ qua số ${cfg.supportPhone} để được hỗ trợ.` : ' Vui lòng liên hệ quản lý dịch vụ để được hỗ trợ.'}`,
        );
      }
      // Khóa trụ sở để hai thợ không cùng chiếm lượt cuối.
      const office = await manager.getRepository(VisitOffice).findOne({ where: { id: dto.officeId, isActive: true }, lock: { mode: 'pessimistic_write' } });
      if (!office) throw new NotFoundException('Không tìm thấy trụ sở');
      await visits.update({ technicianId: userId, status: OfficeVisitStatus.SCHEDULED }, { status: OfficeVisitStatus.CANCELLED });
      const booked = (await visits.find({ where: { officeId: office.id, status: OfficeVisitStatus.SCHEDULED } })).map((v) => v.scheduledAt);
      if (!isBookableSlot(office, at, { now: new Date(), daysAhead: cfg.daysAhead, minNoticeHours: cfg.minNoticeHours, booked })) {
        throw new BadRequestException('Giờ hẹn không hợp lệ hoặc đã hết chỗ. Vui lòng chọn giờ khác.');
      }
      const saved = await visits.save(visits.create({ technicianId: userId, officeId: office.id, scheduledAt: at, status: OfficeVisitStatus.SCHEDULED }));
      return { ...saved, office };
    });
    return this.view(result as OfficeVisit);
  }

  // ── Admin: lịch hẹn ────────────────────────────────────────────────────

  async listVisits(query: QueryOfficeVisitsDto) {
    const qb = this.visits
      .createQueryBuilder('v')
      .leftJoinAndSelect('v.office', 'office')
      .leftJoinAndSelect('v.technician', 'technician')
      .orderBy('v.scheduledAt', 'ASC')
      .take(300);
    if (query.status) qb.andWhere('v.status = :status', { status: query.status });
    if (query.officeId) qb.andWhere('v.officeId = :officeId', { officeId: query.officeId });
    if (query.date) {
      const startUtc = new Date(new Date(`${query.date}T00:00:00Z`).getTime() - VN_OFFSET_MS);
      qb.andWhere('v.scheduledAt >= :from AND v.scheduledAt < :to', { from: startUtc, to: new Date(startUtc.getTime() + 86_400_000) });
    }
    const rows = await qb.getMany();
    return rows.map((v) => ({
      ...this.view(v),
      technicianId: v.technicianId,
      technicianName: v.technician?.fullName ?? '',
      technicianPhone: v.technician?.phoneNumber ?? null,
      note: v.note,
      attendedAt: v.attendedAt?.toISOString() ?? null,
    }));
  }

  private async scheduledVisitOrFail(id: string): Promise<OfficeVisit> {
    const visit = await this.visits.findOne({ where: { id }, relations: ['office'] });
    if (!visit) throw new NotFoundException('Không tìm thấy lịch hẹn');
    if (visit.status !== OfficeVisitStatus.SCHEDULED) throw new ConflictException('Lịch hẹn này đã được xử lý');
    return visit;
  }

  async markAttended(id: string, adminId: string, dto: MarkOfficeVisitDto = {}) {
    const visit = await this.scheduledVisitOrFail(id);
    await this.visits.update(id, { status: OfficeVisitStatus.ATTENDED, attendedAt: new Date(), attendedById: adminId, note: dto.note ?? null });
    await this.audit.log({
      actorUserId: adminId, actorRole: Role.ADMIN, action: 'OFFICE_VISIT_ATTENDED', resourceType: 'technician_office_visit', resourceId: id,
      before: { status: visit.status }, after: { status: OfficeVisitStatus.ATTENDED },
    });
    void this.notifications?.createNotification({
      userId: visit.technicianId,
      title: 'Đã ghi nhận buổi gặp trực tiếp',
      message: 'FixHome đã ghi nhận buổi gặp. Hồ sơ của bạn đang được duyệt, bạn sẽ nhận thông báo khi có kết quả.',
      type: 'OFFICE_VISIT_ATTENDED',
      referenceType: 'technician_office_visit',
      referenceId: id,
    });
    return { id, status: OfficeVisitStatus.ATTENDED };
  }

  /** Vắng: lần đầu cho đặt lại, đủ `office.max_missed_visits` lần thì khóa đặt lịch và báo số hỗ trợ. */
  async markMissed(id: string, adminId: string, dto: MarkOfficeVisitDto = {}) {
    const visit = await this.scheduledVisitOrFail(id);
    await this.visits.update(id, { status: OfficeVisitStatus.MISSED, note: dto.note ?? null });
    const cfg = await this.settings();
    const missed = await this.missedCount(visit.technicianId);
    const blocked = missed >= cfg.maxMissed;
    await this.audit.log({
      actorUserId: adminId, actorRole: Role.ADMIN, action: 'OFFICE_VISIT_MISSED', resourceType: 'technician_office_visit', resourceId: id,
      before: { status: visit.status }, after: { status: OfficeVisitStatus.MISSED, missed, blocked },
    });
    void this.notifications?.createNotification({
      userId: visit.technicianId,
      title: blocked ? 'Bạn đã vắng buổi hẹn nhiều lần - Liên hệ quản lý dịch vụ' : 'Bạn đã vắng buổi hẹn - Vui lòng đặt lại lịch',
      message: blocked
        ? `Bạn đã vắng ${missed} lần nên chưa đặt lịch được nữa.${cfg.supportPhone ? ` Vui lòng liên hệ quản lý dịch vụ qua số ${cfg.supportPhone} để được hỗ trợ.` : ' Vui lòng liên hệ quản lý dịch vụ để được hỗ trợ.'}`
        : `Bạn đã vắng buổi hẹn. Bạn còn ${cfg.maxMissed - missed} lần đặt lại lịch, vui lòng chọn giờ khác.`,
      type: blocked ? 'OFFICE_VISIT_BLOCKED' : 'OFFICE_VISIT_MISSED',
      referenceType: 'technician_office_visit',
      referenceId: id,
    });
    return { id, status: OfficeVisitStatus.MISSED, missedVisits: missed, blocked };
  }

  /** Sau khi đã hỗ trợ thợ bị khóa: các lượt vắng không còn tính, thợ đặt lại được. */
  async resetMissed(technicianId: string, adminId: string) {
    const result = await this.visits.update(
      { technicianId, status: OfficeVisitStatus.MISSED },
      { status: OfficeVisitStatus.CANCELLED, note: 'Admin cho phép đặt lại' },
    );
    await this.audit.log({
      actorUserId: adminId, actorRole: Role.ADMIN, action: 'OFFICE_VISIT_RESET', resourceType: 'technician_profile', resourceId: technicianId,
      before: { cleared: result.affected ?? 0 }, after: {},
    });
    void this.notifications?.createNotification({
      userId: technicianId,
      title: 'Bạn có thể đặt lại lịch lên trụ sở',
      message: 'FixHome đã cho phép bạn đặt lại lịch gặp trực tiếp. Vui lòng chọn trụ sở và giờ hẹn.',
      type: 'OFFICE_VISIT_RESET',
      referenceType: 'technician_profile',
      referenceId: technicianId,
    });
    return { cleared: result.affected ?? 0 };
  }
}
