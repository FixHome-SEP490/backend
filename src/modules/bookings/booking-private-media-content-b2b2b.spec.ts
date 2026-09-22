import { BusinessException } from '../../common/exceptions/business.exception';
import { Role, BookingStatus, ServiceOrderStatus } from '../../shared/enums';
import { Booking } from './entities/booking.entity';
import { BookingMedia } from './entities/booking-media.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { PrivateBookingPhotoStorage } from '../media/private-booking-photo-storage.service';
import { BookingPrivateMediaContentService } from './booking-private-media-content.service';
import { BookingsController } from './bookings.controller';
import { EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { normalizeOpenApiResponses } from '../../setup-app';
import type { OpenAPIObject } from '@nestjs/swagger';

const BOOKING_ID = '4c2b539e-1d04-4efb-b908-ea9fd70bd9b1';
const MEDIA_ID = '45897f21-c2df-4bfb-9e8c-28b3fe6b90fa';
const UPLOAD_ID = '690718f8-2e51-4595-9ba7-13ec1e9f7e60';
const CUSTOMER_ID = 'f60c274d-3ab1-4c29-8ad2-982495f7d3e6';
const TECHNICIAN_ID = '7bd6466d-900b-4f3f-a03c-fc16b9874e13';
const FOREIGN_USER_ID = '065be324-1173-4c8f-a739-b1af7c36d16c';
const OBJECT_REF = `storage://booking-private/${CUSTOMER_ID}/${UPLOAD_ID}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type State = {
  booking: Partial<Booking> | null;
  order: Partial<ServiceOrder> | null;
  assignment: Partial<TechnicianAssignment> | null;
  media: Partial<BookingMedia> | null;
  upload: Partial<PrivateBookingPhotoUpload> | null;
};

function createHarness(overrides: Partial<State> = {}) {
  const state: State = {
    booking: { id: BOOKING_ID, customerId: CUSTOMER_ID, status: BookingStatus.MATCHED },
    order: { id: '0c3b3f9f-c0b7-41b5-880f-3596756646f9', bookingId: BOOKING_ID, status: ServiceOrderStatus.ACCEPTED },
    assignment: { serviceOrderId: '0c3b3f9f-c0b7-41b5-880f-3596756646f9', technicianId: TECHNICIAN_ID, isActive: true },
    media: { id: MEDIA_ID, bookingId: BOOKING_ID, privateUploadId: UPLOAD_ID, url: '' },
    upload: { id: UPLOAD_ID, ownerUserId: CUSTOMER_ID, claimedBookingId: BOOKING_ID, objectRef: OBJECT_REF },
    ...overrides,
  };

  const matchesWhere = (row: object | null, where?: Record<string, unknown>) =>
    !!row && Object.entries(where ?? {}).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
  const manager = {
    findOne: vi.fn(async (entity: unknown, options: { where?: Record<string, unknown> }) => {
      const row = entity === Booking ? state.booking
        : entity === ServiceOrder ? state.order
          : entity === TechnicianAssignment ? state.assignment
            : entity === BookingMedia ? state.media
              : entity === PrivateBookingPhotoUpload ? state.upload : null;
      return matchesWhere(row, options?.where) ? row : null;
    }),
  };
  const dataSource = {
    transaction: vi.fn(async (callback: (manager: EntityManager) => Promise<unknown>) =>
      callback(manager as unknown as EntityManager)),
  };
  const storage = {
    download: vi.fn(async () => ({ buffer: PNG, mimeType: 'image/png' as const })),
  };
  const service = new BookingPrivateMediaContentService(
    dataSource as never,
    storage as unknown as PrivateBookingPhotoStorage,
  );

  return { state, manager, dataSource, storage, service };
}

describe('BookingPrivateMediaContentService', () => {
  const owner = { id: CUSTOMER_ID, role: Role.CUSTOMER };
  const technician = { id: TECHNICIAN_ID, role: Role.TECHNICIAN };

  it.each([
    ['booking owner', owner],
    ['admin', { id: FOREIGN_USER_ID, role: Role.ADMIN }],
    ['service manager', { id: FOREIGN_USER_ID, role: Role.SERVICE_MANAGER }],
    ['current active assigned technician on a matched booking', technician],
  ])('downloads private content for %s only after scoped authorization', async (_label, actor) => {
    const { service, storage } = createHarness();

    const content = await service.download(BOOKING_ID, MEDIA_ID, actor);

    expect(content).toEqual({ buffer: PNG, mimeType: 'image/png' });
    expect(storage.download).toHaveBeenCalledOnce();
    expect(storage.download).toHaveBeenCalledWith(OBJECT_REF, CUSTOMER_ID);
    expect(JSON.stringify(content)).not.toContain(OBJECT_REF);
  });

  async function expectDeniedWithoutStorage(
    harness: ReturnType<typeof createHarness>,
    actor: { id: string; role: string },
    bookingId = BOOKING_ID,
    mediaId = MEDIA_ID,
  ) {
    await expect(harness.service.download(bookingId, mediaId, actor)).rejects.toBeInstanceOf(BusinessException);
    expect(harness.storage.download).not.toHaveBeenCalled();
  }

  it('denies foreign customers and roles outside the explicit access set', async () => {
    await expectDeniedWithoutStorage(createHarness(), { id: FOREIGN_USER_ID, role: Role.CUSTOMER });
    await expectDeniedWithoutStorage(createHarness(), { id: FOREIGN_USER_ID, role: 'unknown' });
  });

  it('rejects non-UUID identifiers before opening a transaction or calling storage', async () => {
    const harness = createHarness();
    await expect(harness.service.download('storage://bucket/arbitrary', MEDIA_ID, owner)).rejects.toBeInstanceOf(BusinessException);
    await expect(harness.service.download(BOOKING_ID, 'legacy-public-media-id', owner)).rejects.toBeInstanceOf(BusinessException);
    await expect(harness.service.download(BOOKING_ID, MEDIA_ID, { id: 'not-a-user-uuid', role: Role.ADMIN })).rejects.toBeInstanceOf(BusinessException);
    expect(harness.dataSource.transaction).not.toHaveBeenCalled();
    expect(harness.storage.download).not.toHaveBeenCalled();
  });

  it.each([
    ['submitted booking', { booking: { id: BOOKING_ID, customerId: CUSTOMER_ID, status: BookingStatus.SUBMITTED } }],
    ['matching booking despite invitation access', { booking: { id: BOOKING_ID, customerId: CUSTOMER_ID, status: BookingStatus.MATCHING } }],
    ['cancelled booking', { booking: { id: BOOKING_ID, customerId: CUSTOMER_ID, status: BookingStatus.CANCELLED } }],
    ['missing order', { order: null }],
    ['cancelled order', { order: { id: '0c3b3f9f-c0b7-41b5-880f-3596756646f9', bookingId: BOOKING_ID, status: ServiceOrderStatus.CANCELLED } }],
    ['former technician assignment', { assignment: { serviceOrderId: '0c3b3f9f-c0b7-41b5-880f-3596756646f9', technicianId: TECHNICIAN_ID, isActive: false } }],
    ['another technician active on the order', { assignment: { serviceOrderId: '0c3b3f9f-c0b7-41b5-880f-3596756646f9', technicianId: FOREIGN_USER_ID, isActive: true } }],
    ['losing or unassigned technician', { assignment: null }],
  ])('denies technician access for %s', async (_label, overrides) => {
    await expectDeniedWithoutStorage(createHarness(overrides), technician);
  });

  it('requires a current active assignment even when an invitation could be pending, standby, or accepted', async () => {
    await expectDeniedWithoutStorage(createHarness({ assignment: null }), technician);
  });

  it('denies a missing booking, wrong booking/media pair, and legacy public media', async () => {
    await expectDeniedWithoutStorage(createHarness({ booking: null }), owner);
    await expectDeniedWithoutStorage(createHarness({ media: null }), owner);
    await expectDeniedWithoutStorage(createHarness({
      media: { id: FOREIGN_USER_ID, bookingId: BOOKING_ID, privateUploadId: UPLOAD_ID, url: '' },
    }), owner);
    await expectDeniedWithoutStorage(createHarness({
      media: { id: MEDIA_ID, bookingId: FOREIGN_USER_ID, privateUploadId: UPLOAD_ID, url: '' },
    }), owner);
    await expectDeniedWithoutStorage(createHarness({ media: { id: MEDIA_ID, bookingId: BOOKING_ID, privateUploadId: null, url: 'https://legacy.example/photo.jpg' } }), owner);
  });

  it.each([
    ['missing upload metadata', { upload: null }],
    ['different upload ID', { upload: { id: FOREIGN_USER_ID, ownerUserId: CUSTOMER_ID, claimedBookingId: BOOKING_ID, objectRef: OBJECT_REF } }],
    ['upload claimed by another booking', { upload: { id: UPLOAD_ID, ownerUserId: CUSTOMER_ID, claimedBookingId: FOREIGN_USER_ID, objectRef: OBJECT_REF } }],
    ['upload owned by another user', { upload: { id: UPLOAD_ID, ownerUserId: FOREIGN_USER_ID, claimedBookingId: BOOKING_ID, objectRef: OBJECT_REF } }],
  ])('denies %s without passing its object reference to storage', async (_label, overrides) => {
    await expectDeniedWithoutStorage(createHarness(overrides), owner);
  });

  it('locks Booking before ServiceOrder and ends the transaction before downloading', async () => {
    const harness = createHarness();
    let transactionFinished = false;
    harness.dataSource.transaction.mockImplementation(async callback => {
      const result = await callback(harness.manager as unknown as EntityManager);
      transactionFinished = true;
      return result;
    });
    harness.storage.download.mockImplementation(async () => {
      expect(transactionFinished).toBe(true);
      return { buffer: PNG, mimeType: 'image/png' };
    });

    await harness.service.download(BOOKING_ID, MEDIA_ID, technician);

    const bookingLockCall = harness.manager.findOne.mock.calls.find(call => call[0] === Booking);
    const orderLockCall = harness.manager.findOne.mock.calls.find(call => call[0] === ServiceOrder);
    const assignmentLockCall = harness.manager.findOne.mock.calls.find(call => call[0] === TechnicianAssignment);
    expect(bookingLockCall?.[1]).toMatchObject({ lock: { mode: 'pessimistic_write' } });
    expect(orderLockCall?.[1]).toMatchObject({ lock: { mode: 'pessimistic_write' } });
    expect(assignmentLockCall?.[1]).toMatchObject({ lock: { mode: 'pessimistic_write' } });
    const lockOrder = harness.manager.findOne.mock.calls
      .map(call => call[0])
      .filter(entity => [Booking, ServiceOrder, TechnicianAssignment].includes(entity as never));
    expect(lockOrder).toEqual([Booking, ServiceOrder, TechnicianAssignment]);
    expect(harness.dataSource.transaction).toHaveBeenCalledOnce();
  });

  it('sanitizes storage failures and rejects unsafe binary metadata', async () => {
    const failed = createHarness();
    failed.storage.download.mockRejectedValue(new Error(`provider failure ${OBJECT_REF} service-role-secret`));
    const error = await failed.service.download(BOOKING_ID, MEDIA_ID, owner).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(OBJECT_REF);
    expect(String(error)).not.toContain('service-role-secret');
    expect(String(error)).toContain('Private Booking photo content is unavailable');

    const unsafe = createHarness();
    unsafe.storage.download.mockResolvedValue({ buffer: PNG, mimeType: 'text/html' as never });
    await expect(unsafe.service.download(BOOKING_ID, MEDIA_ID, owner)).rejects.toThrow('Private Booking photo content is unavailable');
  });
});

describe('BookingsController private media content route', () => {
  it('writes only the validated image buffer with private no-store and no-sniff headers', async () => {
    const contentService = { download: vi.fn(async () => ({ buffer: PNG, mimeType: 'image/png' as const })) };
    const controller = new BookingsController(
      {} as never,
      {} as never,
      contentService as never,
    );
    const response = {
      status: vi.fn(function (this: unknown) { return this; }),
      setHeader: vi.fn(),
      end: vi.fn(),
    };

    await controller.getPrivateMediaContent(
      BOOKING_ID,
      MEDIA_ID,
      { user: { id: CUSTOMER_ID, role: Role.CUSTOMER } },
      response as never,
    );

    expect(contentService.download).toHaveBeenCalledWith(BOOKING_ID, MEDIA_ID, { id: CUSTOMER_ID, role: Role.CUSTOMER });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png');
    expect(response.setHeader).toHaveBeenCalledWith('Content-Length', String(PNG.length));
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store, max-age=0');
    expect(response.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(response.end).toHaveBeenCalledWith(PNG);
    expect(response.end.mock.calls[0]).not.toEqual(expect.objectContaining({ data: PNG }));
  });

  it('keeps an explicitly binary OpenAPI success response outside the JSON envelope', () => {
    const document = {
      paths: {
        '/bookings/{bookingId}/media/{mediaId}/content': {
          get: {
            responses: {
              '200': {
                description: 'Private Booking photo',
                content: {
                  'image/jpeg': { schema: { type: 'string', format: 'binary' } },
                  'image/png': { schema: { type: 'string', format: 'binary' } },
                  'image/webp': { schema: { type: 'string', format: 'binary' } },
                },
              },
            },
          },
        },
        '/bookings/{id}': {
          get: {
            responses: {
              '200': {
                description: 'Booking JSON',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
              '404': {
                description: 'Not found',
                content: { 'application/json': { schema: { type: 'object' } } },
              },
            },
          },
        },
      },
    } as unknown as OpenAPIObject;

    normalizeOpenApiResponses(document);

    expect(document.paths['/bookings/{bookingId}/media/{mediaId}/content']?.get?.responses?.['200'])
      .toMatchObject({ content: {
        'image/jpeg': { schema: { type: 'string', format: 'binary' } },
        'image/png': { schema: { type: 'string', format: 'binary' } },
        'image/webp': { schema: { type: 'string', format: 'binary' } },
      } });
    expect(document.paths['/bookings/{id}']?.get?.responses?.['200'])
      .toMatchObject({ content: { 'application/json': { schema: { properties: { data: { type: 'object' } } } } } });
    expect(document.paths['/bookings/{id}']?.get?.responses?.['404'])
      .toMatchObject({ content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiErrorResponseDto' } } } });
  });
});
