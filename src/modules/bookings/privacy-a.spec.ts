import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { BookingStatus, InvitationStatus, Role, UrgencyLevel } from '../../shared/enums';
import { AiDiagnosis } from '../ai-diagnosis/entities/ai-diagnosis.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { PrivateBookingPhotoClaimService } from '../media/private-booking-photo-claim.service';

const bookingId = 'synthetic-booking-1';
const technicianId = 'synthetic-tech-1';
const customerId = 'synthetic-customer-1';
const expiry = new Date(Date.now() + 60_000);
const preferredStartAt = new Date('2030-01-01T09:00:00.000Z');
const preferredEndAt = new Date('2030-01-01T11:00:00.000Z');

function makeBooking(
  invitationStatus: InvitationStatus = InvitationStatus.PENDING,
  status: BookingStatus = BookingStatus.MATCHING,
) {
  const invitation = {
    id: 'synthetic-invitation-1',
    bookingId,
    technicianId,
    priorityOrder: 1,
    status: invitationStatus,
    invitedAt: new Date('2029-12-31T09:00:00.000Z'),
    expiresAt: expiry,
    respondedAt: null,
  };
  return {
    id: bookingId,
    customerId,
    serviceId: 'synthetic-service-id',
    addressId: 'PRIVATE_ADDRESS_ID_SENTINEL',
    addressTextSnapshot: 'PRIVATE_ADDRESS_TEXT_SENTINEL',
    provinceNameSnapshot: 'Synthetic Province',
    districtNameSnapshot: 'Synthetic District',
    serviceNameSnapshot: 'Synthetic plumbing repair',
    latitudeSnapshot: 10.1234567,
    longitudeSnapshot: 106.1234567,
    description: 'PRIVATE_DESCRIPTION_SENTINEL',
    preferredStartAt,
    preferredEndAt,
    quantity: 2,
    urgency: UrgencyLevel.HIGH,
    status,
    service: {
      id: 'PRIVATE_SERVICE_RELATION_ID_SENTINEL',
      name: 'Synthetic plumbing repair',
      description: 'PRIVATE_SERVICE_DESCRIPTION_SENTINEL',
    },
    address: {
      line1: 'PRIVATE_ADDRESS_LINE_SENTINEL',
      ward: 'PRIVATE_WARD_SENTINEL',
      province: 'Synthetic Province',
      district: 'Synthetic District',
      lat: 10.1234567,
      lng: 106.1234567,
    },
    media: [{ url: 'PRIVATE_MEDIA_URL_SENTINEL', mimeType: 'image/jpeg' }],
    invitations: [
      invitation,
      {
        id: 'PRIVATE_OTHER_INVITATION_SENTINEL',
        bookingId,
        technicianId: 'PRIVATE_OTHER_TECHNICIAN_SENTINEL',
        priorityOrder: 2,
        status: InvitationStatus.STANDBY,
        invitedAt: new Date('2029-12-31T09:01:00.000Z'),
        expiresAt: null,
      },
    ],
  };
}

function makeBookingsHarness(
  booking: ReturnType<typeof makeBooking>,
  options: { order?: Record<string, unknown> | null; assignment?: Record<string, unknown> | null } = {},
) {
  const queryBuilder = {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    execute: vi.fn(async () => undefined),
  };
  const bookingRepo = {
    createQueryBuilder: vi.fn(() => queryBuilder),
    findOne: vi.fn(async () => booking),
  };
  const diagnosis = {
    id: 'PRIVATE_DIAGNOSIS_ID_SENTINEL',
    bookingId,
    rawResponse: { private: 'PRIVATE_DIAGNOSIS_SENTINEL' },
  };
  const manager = {
    findOneBy: vi.fn(async (entity: unknown) => {
      if (entity === ServiceOrder) return options.order ?? null;
      if (entity === TechnicianAssignment) return options.assignment ?? null;
      return null;
    }),
    findOne: vi.fn(async (entity: unknown, _query?: unknown) =>
      entity === Booking ? booking : entity === ServiceOrder ? options.order ?? null : entity === AiDiagnosis ? diagnosis : null),
    find: vi.fn(async (entity: unknown) => entity === BookingInvitation ? booking.invitations : []),
  };
  const dataSource = { manager, transaction: vi.fn(async (callback: (tx: typeof manager) => unknown) => callback(manager)) };
  const service = new BookingsService(
    bookingRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dataSource as never,
    new PrivateBookingPhotoClaimService(),
    {} as never,
  );
  return { service, bookingRepo, manager, diagnosis, dataSource };
}

function makeInvitationsHarness(invitation: Record<string, unknown>, booking: ReturnType<typeof makeBooking>) {
  const invitationRepo = {
    find: vi.fn(async (options: { where: unknown }) => {
      if (Array.isArray(options.where)) return [invitation];
      return [invitation];
    }),
  };
  const manager = {
    findOne: vi.fn(async (entity: unknown) => entity === Booking ? booking : null),
    find: vi.fn(async () => [invitation]),
    update: vi.fn(async () => undefined),
  };
  const dataSource = {
    transaction: vi.fn(async (callback: (tx: typeof manager) => unknown) => callback(manager)),
  };
  const service = new InvitationsService(
    invitationRepo as never,
    {} as never,
    dataSource as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, invitationRepo, manager, dataSource };
}

function stringify(response: unknown): string {
  return JSON.stringify(response);
}

async function transformAndSerializeControllerResponse(response: unknown): Promise<unknown> {
  const context = {
    switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }),
  } as unknown as ExecutionContext;
  const handler: CallHandler = { handle: () => of(response) };
  const transformed = await new Promise<unknown>((resolve, reject) => {
    new TransformInterceptor().intercept(context, handler).subscribe({ next: resolve, error: reject });
  });
  return JSON.parse(stringify(transformed));
}

describe('BE-PRIVACY-A synthetic booking reads', () => {
  it('serializes only the safe preview from GET /invitations/my', async () => {
    const booking = makeBooking();
    const invitation = { ...booking.invitations[0], booking };
    const { service, invitationRepo } = makeInvitationsHarness(invitation, booking);
    const controller = new InvitationsController(service);

    const response = await controller.getMyInvitations({ user: { id: technicianId } });

    expect(invitationRepo.find).toHaveBeenCalledTimes(2);
    const serialized = await transformAndSerializeControllerResponse(response);
    expect(serialized).toEqual({
      success: true,
      statusCode: 200,
      message: 'Success',
      data: [{
        id: 'synthetic-invitation-1',
        bookingId,
        priorityOrder: 1,
        status: InvitationStatus.PENDING,
        invitedAt: '2029-12-31T09:00:00.000Z',
        expiresAt: expiry.toISOString(),
        booking: {
          id: bookingId,
          province: 'Synthetic Province',
          district: 'Synthetic District',
          serviceName: 'Synthetic plumbing repair',
          quantity: 2,
          urgency: UrgencyLevel.HIGH,
          preferredStartAt: preferredStartAt.toISOString(),
          preferredEndAt: preferredEndAt.toISOString(),
        },
      }],
    });
    expect(stringify(serialized)).not.toContain('PRIVATE_');
    expect(stringify(serialized)).not.toContain('PRIVATE_OTHER_TECHNICIAN_SENTINEL');
  });

  it('does not return a stale pending invitation after the booking is already matched', async () => {
    const booking = makeBooking(InvitationStatus.PENDING, BookingStatus.MATCHED);
    const invitation = { ...booking.invitations[0], booking };
    const { service } = makeInvitationsHarness(invitation, booking);
    const controller = new InvitationsController(service);

    const response = await controller.getMyInvitations({ user: { id: technicianId } });

    expect(await transformAndSerializeControllerResponse(response)).toEqual({
      success: true,
      statusCode: 200,
      message: 'Success',
      data: [],
    });
  });

  it('denies a stale PENDING invitee on GET /bookings/:id after the booking is matched', async () => {
    const booking = makeBooking(InvitationStatus.PENDING, BookingStatus.MATCHED);
    const { service, bookingRepo, manager } = makeBookingsHarness(booking);
    const controller = new BookingsController(
      service,
      { refreshMatching: vi.fn(async () => undefined) } as never,
    );

    await expect(controller.findById(bookingId, {
      user: { id: technicianId, role: Role.TECHNICIAN },
    })).rejects.toThrow();

    expect(bookingRepo.findOne).toHaveBeenCalledTimes(1);
    expect(manager.findOne).not.toHaveBeenCalledWith(AiDiagnosis, expect.anything());
  });

  it('serializes only the safe preview from GET /bookings/:id for a live invitee', async () => {
    const booking = makeBooking();
    const { service, manager } = makeBookingsHarness(booking);
    const invitationsService = { refreshMatching: vi.fn(async () => undefined) } as never;
    const controller = new BookingsController(service, invitationsService);

    const response = await controller.findById(bookingId, {
      user: { id: technicianId, role: Role.TECHNICIAN },
    });

    const serialized = await transformAndSerializeControllerResponse(response);
    expect(serialized).toEqual({
      success: true,
      statusCode: 200,
      message: 'Success',
      data: {
        id: bookingId,
        province: 'Synthetic Province',
        district: 'Synthetic District',
        serviceName: 'Synthetic plumbing repair',
        quantity: 2,
        urgency: UrgencyLevel.HIGH,
        preferredStartAt: preferredStartAt.toISOString(),
        preferredEndAt: preferredEndAt.toISOString(),
      },
    });
    expect(stringify(serialized)).not.toContain('PRIVATE_');
    expect(manager.findOneBy).not.toHaveBeenCalled();
    expect(manager.findOne).not.toHaveBeenCalledWith(AiDiagnosis, expect.anything());
  });

  it.each([
    InvitationStatus.DECLINED,
    InvitationStatus.EXPIRED,
    InvitationStatus.CANCELLED,
    InvitationStatus.STANDBY,
  ])('denies a technician with a historical %s invitation', async (invitationStatus) => {
    const booking = makeBooking(invitationStatus);
    const { service } = makeBookingsHarness(booking);

    await expect(service.findById(bookingId, { id: technicianId, role: Role.TECHNICIAN })).rejects.toThrow();
  });

  it('denies a PENDING invitation whose expiry has passed', async () => {
    const booking = makeBooking();
    booking.invitations[0].expiresAt = new Date(Date.now() - 1);
    const { service } = makeBookingsHarness(booking);

    await expect(service.findById(bookingId, { id: technicianId, role: Role.TECHNICIAN })).rejects.toThrow();
  });

  it('denies an unrelated technician and does not treat a technician ID as customer ownership', async () => {
    const booking = makeBooking();
    const { service } = makeBookingsHarness(booking);

    await expect(service.findById(bookingId, { id: 'synthetic-unrelated-tech', role: Role.TECHNICIAN })).rejects.toThrow();
    await expect(service.findById(bookingId, { id: customerId, role: Role.TECHNICIAN })).rejects.toThrow();
    await expect(service.findById(bookingId, { id: technicianId, role: Role.CUSTOMER })).rejects.toThrow();
  });

  it('grants full booking details only to the accepted technician with the active assignment', async () => {
    const booking = makeBooking(InvitationStatus.ACCEPTED, BookingStatus.MATCHED);
    const order = { id: 'synthetic-order-1', bookingId };
    const assignment = { serviceOrderId: order.id, technicianId, isActive: true };
    const { service, manager, diagnosis } = makeBookingsHarness(booking, { order, assignment });

    const result = await service.findById(bookingId, { id: technicianId, role: Role.TECHNICIAN });

    expect(result).toMatchObject({
      addressTextSnapshot: 'PRIVATE_ADDRESS_TEXT_SENTINEL',
      serviceOrderId: order.id,
      diagnosis,
    });
    expect(manager.findOneBy).toHaveBeenCalledWith(TechnicianAssignment, {
      serviceOrderId: order.id,
      technicianId,
      isActive: true,
    });
    expect('invitations' in result ? result.invitations : []).toHaveLength(1);
    expect('invitations' in result ? result.invitations[0].technicianId : undefined).toBe(technicianId);
  });

  it('uses the current invitation when an older invitation belongs to the same technician', async () => {
    const booking = makeBooking(InvitationStatus.PENDING, BookingStatus.MATCHING);
    booking.invitations.unshift({
      id: 'historical-expired', bookingId, technicianId, priorityOrder: 0,
      status: InvitationStatus.EXPIRED, invitedAt: new Date('2029-01-01T00:00:00Z'),
      expiresAt: new Date('2029-01-01T00:01:00Z'), respondedAt: new Date('2029-01-01T00:01:00Z'),
    });
    const { service } = makeBookingsHarness(booking);
    const currentPreview = await service.findById(bookingId, { id: technicianId, role: Role.TECHNICIAN });
    expect(currentPreview).toMatchObject({ id: bookingId, serviceName: 'Synthetic plumbing repair' });
    expect(stringify(currentPreview)).not.toContain('PRIVATE_');

    booking.status = BookingStatus.MATCHED;
    booking.invitations[1].status = InvitationStatus.ACCEPTED;
    const order = { id: 'synthetic-order-1', bookingId };
    const active = makeBookingsHarness(booking, {
      order, assignment: { serviceOrderId: order.id, technicianId, isActive: true },
    });
    const accepted = await active.service.findById(bookingId, { id: technicianId, role: Role.TECHNICIAN });
    expect(accepted).toMatchObject({ id: bookingId, serviceOrderId: order.id });
  });
  it('locks Booking and ServiceOrder while loading winner private details', async () => {
    const booking = makeBooking(InvitationStatus.ACCEPTED, BookingStatus.MATCHED);
    const order = { id: 'synthetic-order-1', bookingId };
    const assignment = { serviceOrderId: order.id, technicianId, isActive: true };
    const { service, manager, dataSource } = makeBookingsHarness(booking, { order, assignment });
    await service.findById(bookingId, { id: technicianId, role: Role.TECHNICIAN });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(manager.findOne).toHaveBeenCalledWith(Booking, {
      where: { id: bookingId }, lock: { mode: 'pessimistic_write' },
    });
    expect(manager.findOne).toHaveBeenCalledWith(ServiceOrder, {
      where: { bookingId }, lock: { mode: 'pessimistic_write' },
    });
  });
  it('denies an accepted invitation without a current active assignment', async () => {
    const booking = makeBooking(InvitationStatus.ACCEPTED, BookingStatus.MATCHED);
    const { service, bookingRepo, manager } = makeBookingsHarness(booking, {
      order: { id: 'synthetic-order-1', bookingId },
      assignment: null,
    });

    await expect(service.findById(bookingId, { id: technicianId, role: Role.TECHNICIAN })).rejects.toThrow();
    expect(bookingRepo.findOne).toHaveBeenCalledTimes(1);
    expect(manager.findOne).not.toHaveBeenCalledWith(AiDiagnosis, expect.anything());
  });

  it.each([
    [Role.CUSTOMER, customerId],
    [Role.ADMIN, 'synthetic-admin'],
    [Role.SERVICE_MANAGER, 'synthetic-manager'],
  ])('preserves full booking access for authorized %s users', async (role, id) => {
    const booking = makeBooking(InvitationStatus.PENDING);
    const order = { id: 'synthetic-order-1', bookingId };
    const { service, diagnosis } = makeBookingsHarness(booking, { order });

    const result = await service.findById(bookingId, { id, role });

    expect(result).toMatchObject({
      addressTextSnapshot: 'PRIVATE_ADDRESS_TEXT_SENTINEL',
      media: [{ url: 'PRIVATE_MEDIA_URL_SENTINEL' }],
      serviceOrderId: order.id,
      diagnosis,
    });
  });
});
