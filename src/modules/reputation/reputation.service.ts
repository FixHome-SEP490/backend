import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { BusinessConfigService } from '../system-config/business-config.service';
import { AccountStatus, Role } from '../../shared/enums';
import { startBackgroundJob } from '../../common/background-job';
import { ReputationEvent } from './entities/reputation-event.entity';
import { clampPoints, penaltyFor, REPUTATION_START, suspensionEnd } from './reputation-rules';

export interface ReputationViolation {
  userId: string;
  role: Role;
  reason: string;
  serviceOrderId?: string | null;
  cancellationId?: string | null;
}

/** Reputation points of customers and technicians (PO 08/10/2026), see reputation-rules.ts. */
@Injectable()
export class ReputationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReputationService.name);
  private resetTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(ReputationEvent) private readonly eventRepo: Repository<ReputationEvent>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly configService: BusinessConfigService,
  ) {}

  onModuleInit(): void {
    this.resetTimer = startBackgroundJob('reputation reset', this.logger, async () => { await this.resetSweep(); });
  }

  onModuleDestroy(): void {
    if (this.resetTimer) clearInterval(this.resetTimer);
  }

  /**
   * Deduct the violation points inside the caller's transaction and apply the
   * penalty of the new score. A technician who reported "Cần thay đổi thợ" for
   * this order is not penalised: the Service Manager reviews that case.
   */
  async penalize(manager: EntityManager, v: ReputationViolation): Promise<ReputationEvent | null> {
    if (v.role !== Role.CUSTOMER && v.role !== Role.TECHNICIAN) return null;
    if (v.role === Role.TECHNICIAN && v.serviceOrderId) {
      const reported = await manager.query(
        `SELECT 1 FROM "support_cases" WHERE "service_order_id" = $1 AND "created_by_user_id" = $2 AND "case_type" = 'technician_replacement' LIMIT 1`,
        [v.serviceOrderId, v.userId],
      );
      if (reported.length) return null;
    }
    const user = await manager.findOne(User, { where: { id: v.userId }, lock: { mode: 'pessimistic_write' } });
    if (!user) return null;
    const cost = await this.configService.getInt('reputation.violation_points', 10);
    const before = user.reputationPoints ?? REPUTATION_START;
    const after = clampPoints(before - cost);
    await manager.update(User, user.id, { reputationPoints: after });
    const penalty = await this.applyPenalty(manager, user, v.role, after);
    const event = await manager.save(ReputationEvent, manager.create(ReputationEvent, {
      userId: user.id, kind: 'violation', delta: after - before, pointsAfter: after, reason: v.reason,
      penalty, serviceOrderId: v.serviceOrderId ?? null, cancellationId: v.cancellationId ?? null, actorUserId: null,
    }));
    await manager.insert(Notification, {
      userId: user.id,
      title: 'Bạn bị trừ điểm uy tín',
      message: `Huỷ đơn đã có ${v.role === Role.CUSTOMER ? 'thợ nhận' : 'khách đặt'}: trừ ${before - after} điểm, còn ${after}/100.${penalty ? ' ' + penalty : ''}`,
      type: 'REPUTATION_CHANGED',
      referenceId: v.serviceOrderId ?? null,
      referenceType: v.serviceOrderId ? 'SERVICE_ORDER' : null,
      isRead: false,
    });
    return event;
  }

  /** Suspends or locks by the new score; returns a short Vietnamese description, or null. */
  private async applyPenalty(manager: EntityManager, user: User, role: Role, points: number): Promise<string | null> {
    const penalty = penaltyFor(points);
    if (penalty.kind === 'none') return null;
    if (penalty.kind === 'lock') {
      await manager.update(User, user.id, { status: AccountStatus.LOCKED });
      return 'Tài khoản bị khoá vì hết điểm uy tín.';
    }
    if (role === Role.CUSTOMER) {
      const until = suspensionEnd(user.bookingSuspendedUntil, penalty.hours);
      await manager.update(User, user.id, { bookingSuspendedUntil: until });
    } else {
      const profile = await manager.findOne(TechnicianProfile, { where: { userId: user.id }, lock: { mode: 'pessimistic_write' } });
      if (profile) await manager.update(TechnicianProfile, profile.id, { workSuspendedUntil: suspensionEnd(profile.workSuspendedUntil, penalty.hours) });
    }
    return `Tạm khoá ${role === Role.CUSTOMER ? 'đặt lịch' : 'nhận việc'} ${penalty.label}.`;
  }

  /**
   * Service Manager / admin change with a reason. Lowering applies the penalty
   * of the new score; raising to 70 or more lifts a running suspension (the
   * staff member decided the violation did not stand). A locked account is
   * unlocked by an admin through the user status, not here.
   */
  async adjust(actor: { id: string; role: string }, userId: string, delta: number, reason: string): Promise<{ points: number; event: ReputationEvent }> {
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100) throw new BadRequestException('Số điểm điều chỉnh từ -100 đến 100, khác 0');
    if (!reason?.trim() || reason.trim().length < 5) throw new BadRequestException('Ghi lý do điều chỉnh, tối thiểu 5 ký tự');
    return this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(User, { where: { id: userId }, lock: { mode: 'pessimistic_write' } });
      if (!user || (user.role !== Role.CUSTOMER && user.role !== Role.TECHNICIAN)) throw new NotFoundException('Không tìm thấy khách hàng hoặc kỹ thuật viên');
      const before = user.reputationPoints ?? REPUTATION_START;
      const after = clampPoints(before + delta);
      await manager.update(User, user.id, { reputationPoints: after });
      let penalty: string | null = null;
      if (after < before) {
        penalty = await this.applyPenalty(manager, user, user.role, after);
      } else if (after >= 70) {
        if (user.role === Role.CUSTOMER) await manager.update(User, user.id, { bookingSuspendedUntil: null });
        else await manager.update(TechnicianProfile, { userId: user.id }, { workSuspendedUntil: null });
        penalty = 'Gỡ tạm khoá.';
      }
      const event = await manager.save(ReputationEvent, manager.create(ReputationEvent, {
        userId: user.id, kind: 'adjustment', delta: after - before, pointsAfter: after, reason: reason.trim(), penalty, actorUserId: actor.id,
      }));
      await manager.insert(Notification, {
        userId: user.id,
        title: 'Điểm uy tín được điều chỉnh',
        message: `Quản lý điều chỉnh ${after - before > 0 ? '+' : ''}${after - before} điểm, còn ${after}/100. Lý do: ${reason.trim()}`,
        type: 'REPUTATION_CHANGED',
        isRead: false,
      });
      return { points: after, event };
    });
  }

  /** Back to 100 every reset period; locked accounts are left as they are. */
  async resetSweep(): Promise<number> {
    const months = await this.configService.getInt('reputation.reset_months', 2);
    const rows: Array<{ id: string; before: number }> = await this.dataSource.query(
      `UPDATE "users" u SET "reputation_points" = 100, "reputation_period_start" = now()
         FROM (SELECT "id", "reputation_points" AS before FROM "users"
                WHERE "role" IN ('customer', 'technician') AND "status" <> 'locked'
                  AND "reputation_period_start" <= now() - make_interval(months => $1)
                FOR UPDATE) old
        WHERE u."id" = old."id"
        RETURNING u."id", old.before`,
      [months],
    );
    const changed = rows.filter((r) => Number(r.before) !== REPUTATION_START);
    for (const r of changed) {
      await this.eventRepo.save(this.eventRepo.create({
        userId: r.id, kind: 'reset', delta: REPUTATION_START - Number(r.before), pointsAfter: REPUTATION_START, reason: `Làm mới điểm định kỳ ${months} tháng`,
      }));
    }
    return changed.length;
  }

  async list(query: { role?: string; search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const qb = this.userRepo.createQueryBuilder('u')
      .leftJoin(TechnicianProfile, 'tp', 'tp.userId = u.id')
      .select(['u.id AS id', 'u.fullName AS "fullName"', 'u.email AS email', 'u.phoneNumber AS "phoneNumber"', 'u.role AS role', 'u.status AS status',
        'u.reputationPoints AS "reputationPoints"', 'u.bookingSuspendedUntil AS "bookingSuspendedUntil"', 'tp.workSuspendedUntil AS "workSuspendedUntil"'])
      .where('u.role IN (:...roles)', { roles: query.role === 'customer' || query.role === 'technician' ? [query.role] : ['customer', 'technician'] });
    if (query.search?.trim()) {
      qb.andWhere('(u.fullName ILIKE :s OR u.email ILIKE :s OR u.phoneNumber ILIKE :s)', { s: `%${query.search.trim()}%` });
    }
    const total = await qb.getCount();
    const data = await qb.orderBy('u.reputationPoints', 'ASC').addOrderBy('u.fullName', 'ASC').offset((page - 1) * pageSize).limit(pageSize).getRawMany();
    return { data: data.map((r) => ({ ...r, reputationPoints: Number(r.reputationPoints) })), total, page, pageSize };
  }

  async events(userId: string): Promise<ReputationEvent[]> {
    return this.eventRepo.find({ where: { userId }, order: { createdAt: 'DESC' }, take: 100 });
  }
}
