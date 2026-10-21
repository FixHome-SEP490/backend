import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { BookingStatus, Role, SupportCaseType } from '../../shared/enums';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BookingsService } from '../bookings/bookings.service';
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
  ) {}

  /** What a booking screen needs before it offers more than one device. */
  async contact(): Promise<{ enabled: boolean; deviceLimit: number; hotline: string | null }> {
    return { enabled: await this.isEnabled(), deviceLimit: VISIT_GROUP_DEVICE_LIMIT, hotline: await this.hotline() };
  }

  async create(dto: CreateVisitGroupDto, customer: Customer) {
    if (customer.role !== Role.CUSTOMER) throw new ForbiddenException('Customer role required');
    await this.assertEnabled();
    if (dto.items.length > VISIT_GROUP_DEVICE_LIMIT) {
      throw new BusinessException(
        ErrorCodes.VISIT_GROUP_DEVICE_LIMIT,
        `Mỗi lần đặt được tối đa ${VISIT_GROUP_DEVICE_LIMIT} thiết bị. Từ thiết bị thứ ${VISIT_GROUP_DEVICE_LIMIT + 1}, bạn gọi hotline hoặc gửi yêu cầu tư vấn để FixHome sắp xếp.`,
        { limit: VISIT_GROUP_DEVICE_LIMIT, hotline: await this.hotline() },
      );
    }
    if (dto.idempotencyKey) {
      const earlier = await this.groupRepo.findOneBy({ customerId: customer.id, idempotencyKey: dto.idempotencyKey });
      if (earlier) return this.detail(earlier.id, customer);
    }

    let groupId: string;
    try {
      groupId = await this.dataSource.transaction(async (manager) => {
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
      });
    } catch (err) {
      // Two submissions with the same key raced: the loser returns the winner's group.
      if (dto.idempotencyKey && (err as { code?: string })?.code === '23505') {
        const winner = await this.groupRepo.findOneBy({ customerId: customer.id, idempotencyKey: dto.idempotencyKey });
        if (winner) return this.detail(winner.id, customer);
      }
      throw err;
    }
    return this.detail(groupId, customer);
  }

  async detail(groupId: string, customer: { id: string }) {
    const group = await this.groupRepo.findOneBy({ id: groupId, customerId: customer.id });
    if (!group) throw new BusinessException(ErrorCodes.OWNERSHIP_DENIED, 'Visit group not found');
    const items = await this.itemRepo.find({ where: { groupId }, order: { sequence: 'ASC' } });
    const bookings = items.length
      ? await this.dataSource.getRepository(Booking).find({ where: { id: In(items.map((item) => item.bookingId)) }, relations: ['media'] })
      : [];
    const byId = new Map(bookings.map((booking) => [booking.id, booking]));
    return {
      ...group,
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

  /**
   * Cancel the whole visit before a technician holds it. No device can be
   * cancelled on its own (see refuseLoneGroupedBookingAction).
   */
  async cancel(groupId: string, reason: string, customer: { id: string; role: string }) {
    await this.dataSource.transaction(async (manager) => {
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
