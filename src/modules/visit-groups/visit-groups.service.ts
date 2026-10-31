import { ForbiddenException, Injectable } from '@nestjs/common';
import { tidyAddressText } from '../../shared/utils/address-text';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { BookingStatus, Role, SupportCaseType } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BookingsService } from '../bookings/bookings.service';
import { InvitationsService } from '../bookings/invitations.service';
import { ScheduleBookingDto } from '../bookings/booking.dto';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { CreateBookingDto } from '../bookings/booking.dto';
import { toBookingResponse } from '../bookings/booking-privacy.dto';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { SupportCasesService } from '../support-cases/support-cases.service';
import { BusinessConfigService } from '../system-config/business-config.service';
import { InvitationStatus } from '../../shared/enums';
import { VisitGroup } from './entities/visit-group.entity';
import { VisitGroupItem } from './entities/visit-group-item.entity';
import { CreateVisitGroupDto, VISIT_GROUP_DEVICE_LIMIT, VisitGroupConsultationDto } from './visit-group.dto';
import { deriveVisitGroupStatus, visitGroupStatusSql, type VisitGroupReadItemStatus, type VisitGroupReadStatus, type VisitGroupTechnicianTab } from './visit-group-read';

type Customer = { id: string; role: string };

/** Configuration keys (system_configs). The group feature stays off until every rail is ready. */
export const VISIT_GROUP_ENABLED_KEY = 'visit_group.enabled';
export const SUPPORT_HOTLINE_KEY = 'support.hotline';

/**
 * Up to three physical devices booked in one visit (PO 21/10/2026). The group is
 * a thin envelope: each device becomes a normal child Booking (quantity 1)
 * through BookingsService.create, inside one transaction, so the device rules
 * (price variant, description, photos, address) are the ones every booking uses.
 */
@Injectable()
export class VisitGroupsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(VisitGroup) private readonly groupRepo: Repository<VisitGroup>,
    @InjectRepository(VisitGroupItem) private readonly itemRepo: Repository<VisitGroupItem>,
    private readonly bookingsService: BookingsService,
    private readonly config: BusinessConfigService,
    private readonly supportCases: SupportCasesService,
    private readonly auditLogService: AuditLogService,
    private readonly invitations: InvitationsService,
    private readonly serviceOrders: ServiceOrdersService,
  ) {}

  /** What a booking screen needs before it offers more than one device. */
  async contact(): Promise<{ enabled: boolean; deviceLimit: number; hotline: string | null }> {
    return { enabled: await this.isEnabled(), deviceLimit: VISIT_GROUP_DEVICE_LIMIT, hotline: await this.hotline() };
  }

  async create(dto: CreateVisitGroupDto, customer: Customer, externalManager?: EntityManager) {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    await this.assertEnabled();
    if (dto.items.length > VISIT_GROUP_DEVICE_LIMIT) {
      throw new BusinessException(
        ErrorCodes.VISIT_GROUP_DEVICE_LIMIT,
        // PO 21/10/2026: the screen locks adding at the limit and says so; no hotline, no "contact us".
        `Mỗi lần đặt được tối đa ${VISIT_GROUP_DEVICE_LIMIT} thiết bị.`,
        { limit: VISIT_GROUP_DEVICE_LIMIT, hotline: await this.hotline() },
      );
    }
    if (dto.idempotencyKey && !externalManager) {
      const earlier = await this.groupRepo.findOneBy({ customerId: customer.id, idempotencyKey: dto.idempotencyKey });
      if (earlier) return this.detail(earlier.id, customer);
    }

    let groupId: string;
    try {
      const createInManager = async (manager: EntityManager) => {
        const group = await manager.save(manager.create(VisitGroup, {
          customerId: customer.id,
          addressId: dto.addressId,
          status: 'submitted',
          // Filled from the first device below; placeholders satisfy NOT NULL until then.
          bookingMode: dto.mode ?? 'scheduled',
          slot: null,
          preferredStartAt: new Date(),
          preferredEndAt: new Date(),
          idempotencyKey: dto.idempotencyKey ?? null,
        }));
        const children: Booking[] = [];
        for (const [index, item] of dto.items.entries()) {
          const childDto: CreateBookingDto = {
            serviceId: item.serviceId,
            addressId: dto.addressId,
            mode: dto.mode,
            date: dto.date,
            slot: dto.slot,
            preferredStartAt: dto.preferredStartAt,
            preferredEndAt: dto.preferredEndAt,
            description: item.description,
            quantity: 1,
            urgency: dto.urgency,
            customerNote: dto.customerNote,
            deviceAttributes: item.deviceAttributes,
            selectedVariantCode: item.selectedVariantCode,
            photoUploadIds: item.photoUploadIds,
            // The conversation leads with the appliance it talked through, which
            // the app puts first; the others carry their own description.
            ...(index === 0 && dto.aiSessionId ? { aiSessionId: dto.aiSessionId } : {}),
          };
          const child = await this.bookingsService.create(childDto, customer, { manager, visitGroupId: group.id });
          children.push(child);
          await manager.insert(VisitGroupItem, {
            groupId: group.id,
            sequence: index + 1,
            bookingId: child.id,
            serviceId: item.serviceId,
            deviceLabel: item.deviceLabel || null,
          });
        }
        // One arrival window for the whole visit: "come now" is computed per call, so
        // every device takes the first one's window to the millisecond.
        const first = children[0];
        const siblings = children.slice(1).map((child) => child.id);
        if (siblings.length) {
          await manager.update(Booking, { id: In(siblings) }, {
            preferredStartAt: first.preferredStartAt,
            preferredEndAt: first.preferredEndAt,
            bookingMode: first.bookingMode,
            slot: first.slot ?? null,
          });
        }
        await manager.update(VisitGroup, group.id, {
          bookingMode: first.bookingMode,
          slot: first.slot ?? null,
          preferredStartAt: first.preferredStartAt!,
          preferredEndAt: first.preferredEndAt!,
        });
        await this.auditLogService.logWithManager(manager, {
          actorUserId: customer.id,
          actorRole: customer.role,
          action: 'VISIT_GROUP_CREATE',
          resourceType: 'visit_group',
          resourceId: group.id,
          after: { devices: children.length, bookingIds: children.map((child) => child.id) },
        });
        return group.id;
      };
      groupId = externalManager ? await createInManager(externalManager) : await this.dataSource.transaction(createInManager);
    } catch (err) {
      // Two submissions with the same key raced: the loser returns the winner's group.
      if (!externalManager && dto.idempotencyKey && (err as { code?: string })?.code === '23505') {
        const winner = await this.groupRepo.findOneBy({ customerId: customer.id, idempotencyKey: dto.idempotencyKey });
        if (winner) return this.detail(winner.id, customer);
      }
      throw err;
    }
    return this.detail(groupId, customer, externalManager);
  }

  async detail(groupId: string, customer: { id: string }, manager?: EntityManager) {
    const group = await (manager ? manager.findOneBy(VisitGroup, { id: groupId, customerId: customer.id }) : this.groupRepo.findOneBy({ id: groupId, customerId: customer.id }));
    if (!group) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Visit group not found');
    const items = await (manager ? manager.find(VisitGroupItem, { where: { groupId }, order: { sequence: 'ASC' } }) : this.itemRepo.find({ where: { groupId }, order: { sequence: 'ASC' } }));
    const bookings = items.length
      ? await (manager ?? this.dataSource).getRepository(Booking).find({ where: { id: In(items.map((item) => item.bookingId)) }, relations: ['media'] })
      : [];
    const byId = new Map(bookings.map((booking) => [booking.id, booking]));
    return {
      ...group,
      // Matching (candidates, shortlist, the invitations) runs on this booking for the whole visit.
      leadBookingId: items[0]?.bookingId ?? null,
      items: items.map((item) => ({
        id: item.id,
        sequence: item.sequence,
        serviceId: item.serviceId,
        deviceLabel: item.deviceLabel ?? null,
        booking: byId.has(item.bookingId) ? toBookingResponse(byId.get(item.bookingId)!) : null,
      })),
    };
  }

  /** The customer's groups, newest first, with each device's service and status. */
  async mine(customer: { id: string }) {
    const groups = await this.groupRepo.find({ where: { customerId: customer.id }, order: { createdAt: 'DESC' }, take: 50 });
    if (!groups.length) return [];
    const items = await this.itemRepo.find({ where: { groupId: In(groups.map((group) => group.id)) }, order: { sequence: 'ASC' } });
    const bookings = items.length
      ? await this.dataSource.getRepository(Booking).findBy({ id: In(items.map((item) => item.bookingId)) })
      : [];
    const byId = new Map(bookings.map((booking) => [booking.id, booking]));
    return groups.map((group) => ({
      ...group,
      items: items.filter((item) => item.groupId === group.id).map((item) => ({
        id: item.id,
        sequence: item.sequence,
        deviceLabel: item.deviceLabel ?? null,
        bookingId: item.bookingId,
        serviceName: byId.get(item.bookingId)?.serviceNameSnapshot ?? null,
        status: byId.get(item.bookingId)?.status ?? null,
      })),
    }));
  }

  /** Server-paginated customer list: the page and count are always VisitGroup parents. */
  async myPage(
    customerId: string,
    options: { page?: number; pageSize?: number; status?: VisitGroupReadStatus; q?: string },
  ) {
    const page = options.page || 1;
    const pageSize = Math.min(options.pageSize || 20, 100);
    const qb = this.groupRepo.createQueryBuilder('vg').where('vg.customerId = :customerId', { customerId });

    if (options.status) qb.andWhere(`(${visitGroupStatusSql('vg')}) = :status`, { status: options.status });
    if (options.q?.trim()) {
      qb.andWhere(`EXISTS (
        SELECT 1 FROM visit_group_items vgi
        JOIN bookings vb ON vb.id = vgi.booking_id
        LEFT JOIN service_orders vo ON vo.booking_id = vb.id
        WHERE vgi.group_id = vg.id
          AND (vgi.device_label ILIKE :groupQuery OR vb.service_name_snapshot ILIKE :groupQuery OR vo.code ILIKE :groupQuery)
      )`, { groupQuery: `%${options.q.trim()}%` });
    }

    qb.orderBy('vg.createdAt', 'DESC').addOrderBy('vg.id', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [groups, total] = await qb.getManyAndCount();
    return this.presentReadPage(groups, total, page, pageSize);
  }

  /** Active children require this technician; a failed terminal child has no active assignment. */
  async assignedPage(
    technicianId: string,
    options: { page?: number; pageSize?: number; tab?: VisitGroupTechnicianTab },
  ) {
    const page = options.page || 1;
    const pageSize = Math.min(options.pageSize || 20, 100);
    const qb = this.groupRepo.createQueryBuilder('vg')
      .where(`EXISTS (
        SELECT 1 FROM visit_group_items vgi
        JOIN service_orders so ON so.booking_id = vgi.booking_id
        JOIN technician_assignments ta ON ta.service_order_id = so.id
        WHERE vgi.group_id = vg.id AND ta.technician_id = :technicianId AND ta.is_active = true
      )`, { technicianId })
      .andWhere(`NOT EXISTS (
        SELECT 1 FROM visit_group_items vgi
        WHERE vgi.group_id = vg.id AND vgi.outcome IS DISTINCT FROM 'failed' AND vgi.outcome IS DISTINCT FROM 'interrupted' AND NOT EXISTS (
          SELECT 1 FROM service_orders so
          JOIN technician_assignments ta ON ta.service_order_id = so.id
          WHERE so.booking_id = vgi.booking_id AND ta.technician_id = :technicianId AND ta.is_active = true
        )
      )`, { technicianId });

    const statusSql = visitGroupStatusSql('vg');
    const tab = options.tab ?? 'all';
    if (tab === 'in_progress') {
      qb.andWhere(`(${statusSql}) IN ('accepted', 'en_route', 'under_repair')`);
    } else if (tab !== 'all') {
      qb.andWhere(`(${statusSql}) = :tab`, { tab });
    }

    qb.orderBy('vg.createdAt', 'DESC').addOrderBy('vg.id', 'DESC').skip((page - 1) * pageSize).take(pageSize);
    const [groups, total] = await qb.getManyAndCount();
    return this.presentReadPage(groups, total, page, pageSize, technicianId);
  }

  private async presentReadPage(
    groups: VisitGroup[],
    total: number,
    page: number,
    pageSize: number,
    technicianId?: string,
  ) {
    if (!groups.length) return { data: [], total, page, pageSize };

    const groupIds = groups.map((group) => group.id);
    const assignmentJoin = technicianId ? 'AND ta.technician_id = $2' : '';
    const parameters = technicianId ? [groupIds, technicianId] : [groupIds];
    const rows = await this.dataSource.query(`
      SELECT
        vgi.id AS "itemId",
        vgi.group_id AS "groupId",
        vgi.sequence AS "sequence",
        vgi.booking_id AS "bookingId",
        vgi.service_id AS "serviceId",
        vgi.device_label AS "deviceLabel",
        vgi.outcome AS "outcome",
        vb.status AS "bookingStatus",
        vb.service_name_snapshot AS "serviceName",
        vb.address_text_snapshot AS "addressText",
        so.id AS "orderId",
        so.code AS "orderCode",
        so.status AS "orderStatus",
        (ta.id IS NOT NULL) AS "hasActiveAssignment"
      FROM visit_group_items vgi
      JOIN bookings vb ON vb.id = vgi.booking_id
      LEFT JOIN service_orders so ON so.booking_id = vb.id
      LEFT JOIN LATERAL (
        SELECT ta.id
        FROM technician_assignments ta
        WHERE ta.service_order_id = so.id AND ta.is_active = true ${assignmentJoin}
        LIMIT 1
      ) ta ON true
      WHERE vgi.group_id = ANY($1::uuid[])
      ORDER BY vgi.group_id, vgi.sequence
    `, parameters) as Array<{
      itemId: string;
      groupId: string;
      sequence: number;
      bookingId: string;
      serviceId: string;
      deviceLabel: string | null;
      outcome: string | null;
      bookingStatus: string;
      serviceName: string | null;
      addressText: string | null;
      orderId: string | null;
      orderCode: string | null;
      orderStatus: string | null;
      hasActiveAssignment: boolean;
    }>;

    const byGroup = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byGroup.get(row.groupId) ?? [];
      list.push(row);
      byGroup.set(row.groupId, list);
    }
    const data = groups.map((group) => {
      const items = byGroup.get(group.id) ?? [];
      const status = deriveVisitGroupStatus(items as VisitGroupReadItemStatus[]);
      return {
        id: group.id,
        createdAt: group.createdAt,
        bookingMode: group.bookingMode,
        slot: group.slot ?? null,
        scheduledAt: group.preferredStartAt,
        scheduledEndAt: group.preferredEndAt,
        status,
        // Every device of a visit shares one address; shown on the card before an order exists.
        addressSummary: tidyAddressText(items[0]?.addressText) || null,
        items: items.map(({ groupId: _groupId, hasActiveAssignment: _active, addressText: _address, ...item }) => item),
      };
    });
    return { data, total, page, pageSize };
  }

  /**
   * Technicians who offer every device of the visit and are free for its
   * session, ranked like a single booking's candidates (PO 21/10/2026: one
   * technician with all the skills takes the whole visit).
   */
  async candidates(groupId: string, customer: Customer) {
    await this.assertEnabled();
    return this.bookingsService.getCandidates(await this.leadBookingId(groupId, customer), customer, { asVisit: true });
  }

  /**
   * Invite one or two technicians for the whole visit, in priority order. The
   * invitation lives on the lead booking; Accept creates every device's order.
   */
  async shortlist(groupId: string, technicianIds: string[], customer: Customer) {
    await this.assertEnabled();
    const lead = await this.leadBookingId(groupId, customer);
    return this.invitations.createShortlist(lead, technicianIds, customer, { asVisit: true });
  }

  /**
   * Move the whole visit to another session, once per visit (PO 21/10/2026),
   * with the same rules as one booking: the technician who holds it must be
   * free then, otherwise matching starts again. Descriptions stay per device.
   */
  async reschedule(groupId: string, dto: ScheduleBookingDto, customer: Customer) {
    const lead = await this.leadBookingId(groupId, customer);
    await this.bookingsService.reschedule(lead, { ...dto, description: undefined }, customer, { asVisit: true });
    return this.detail(groupId, customer);
  }

  /** The technician drops the whole visit before arriving; it is matched again through its lead booking. */
  async withdraw(groupId: string, reason: string, technician: Customer) {
    if (technician.role !== Role.TECHNICIAN) throw new ForbiddenException('Technician role required');
    const orders = await this.serviceOrders.cancelVisit(groupId, { reason }, technician);
    return { visitGroupId: groupId, orderIds: orders.map((order) => order.id) };
  }

  /** The one extension of the live invitation round, for the whole visit. */
  async extendMatching(groupId: string, customer: Customer) {
    return this.invitations.extendPendingInvitationGroup(await this.leadBookingId(groupId, customer), customer);
  }

  private async hasOrders(groupId: string): Promise<boolean> {
    const rows: Array<{ n: number }> = await this.dataSource.query(
      'SELECT COUNT(*)::int AS n FROM service_orders o JOIN bookings b ON b.id = o.booking_id WHERE b.visit_group_id = $1',
      [groupId],
    );
    return (rows[0]?.n ?? 0) > 0;
  }

  private async leadBookingId(groupId: string, customer: { id: string }): Promise<string> {
    const group = await this.groupRepo.findOneBy({ id: groupId, customerId: customer.id });
    if (!group) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Visit group not found');
    if (group.status === 'cancelled') throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Lượt sửa này đã huỷ.');
    const lead = await this.itemRepo.findOne({ where: { groupId }, order: { sequence: 'ASC' } });
    if (!lead) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Visit group not found');
    return lead.bookingId;
  }

  /**
   * Cancel the whole visit before a technician holds it. No device can be
   * cancelled on its own (see refuseLoneGroupedBookingAction).
   */
  async cancel(groupId: string, reason: string, customer: { id: string; role: string }) {
    // Once a technician holds the visit, every order is cancelled by the order rules.
    if (await this.hasOrders(groupId)) {
      await this.serviceOrders.cancelVisit(groupId, { reason }, customer);
      return this.detail(groupId, customer);
    }
    await this.dataSource.transaction(async (manager) => {
      // The lead booking's row is the visit's lock, taken first as Accept and the matching sweep do.
      const lead = await manager.findOne(VisitGroupItem, { where: { groupId }, order: { sequence: 'ASC' } });
      if (lead) await manager.findOne(Booking, { where: { id: lead.bookingId }, lock: { mode: 'pessimistic_write' } });
      const group = await manager.findOne(VisitGroup, { where: { id: groupId, customerId: customer.id }, lock: { mode: 'pessimistic_write' } });
      if (!group) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Visit group not found');
      if (group.status === 'cancelled') return;
      const children = await manager.find(Booking, { where: { visitGroupId: groupId }, order: { id: 'ASC' }, lock: { mode: 'pessimistic_write' } });
      const ids = children.map((child) => child.id);
      if (ids.length && await manager.count(ServiceOrder, { where: { bookingId: In(ids) } })) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Thợ đã nhận lượt sửa này, vui lòng huỷ từ đơn sửa chữa.');
      }
      if (children.some((child) => ![BookingStatus.SUBMITTED, BookingStatus.MATCHING, BookingStatus.CLOSED, BookingStatus.CANCELLED].includes(child.status))) {
        throw new BusinessException(ErrorCodes.ORDER_INVALID_TRANSITION, 'Lượt sửa này không huỷ được ở trạng thái hiện tại.');
      }
      if (ids.length) {
        await manager.createQueryBuilder().update(BookingInvitation)
          .set({ status: InvitationStatus.CANCELLED, respondedAt: new Date() })
          .where('booking_id IN (:...ids) AND status IN (:...open)', { ids, open: [InvitationStatus.PENDING, InvitationStatus.STANDBY] })
          .execute();
        await manager.update(Booking, { id: In(ids) }, { status: BookingStatus.CANCELLED });
      }
      await manager.update(VisitGroup, groupId, { status: 'cancelled' });
      await this.auditLogService.logWithManager(manager, {
        actorUserId: customer.id,
        actorRole: customer.role,
        action: 'VISIT_GROUP_CANCEL',
        resourceType: 'visit_group',
        resourceId: groupId,
        after: { reason, bookingIds: ids },
      });
    });
    return this.detail(groupId, customer);
  }

  /**
   * More devices than one visit takes: the customer leaves a message and the
   * service managers see it as a support case, alongside the hotline.
   */
  async requestConsultation(dto: VisitGroupConsultationDto, customer: Customer) {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    const devices = (dto.devices ?? []).map((name) => name.trim()).filter(Boolean);
    const supportCase = await this.supportCases.openCase({
      caseType: SupportCaseType.OTHER,
      reason: `Tư vấn đặt từ ${VISIT_GROUP_DEVICE_LIMIT + 1} thiết bị trở lên`,
      description: [dto.message, devices.length ? `Thiết bị: ${devices.join('; ')}` : null].filter(Boolean).join('\n'),
      customerId: customer.id,
      createdByUserId: customer.id,
    });
    return { id: supportCase.id, status: supportCase.status, hotline: await this.hotline() };
  }

  private async isEnabled(): Promise<boolean> {
    return (await this.config.getString(VISIT_GROUP_ENABLED_KEY, 'false')).trim().toLowerCase() === 'true';
  }

  private async assertEnabled(): Promise<void> {
    if (!(await this.isEnabled())) {
      throw new BusinessException(ErrorCodes.FEATURE_DISABLED, 'Đặt nhiều thiết bị trong một lượt chưa mở.');
    }
  }

  private async hotline(): Promise<string | null> {
    const value = (await this.config.getString(SUPPORT_HOTLINE_KEY, '')).trim();
    return value || null;
  }
}
