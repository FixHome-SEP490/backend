import 'reflect-metadata';
import { validateSync } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { Role, ServicePricingMode } from '../../shared/enums';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { PrivateBookingPhotoClaimService } from '../media/private-booking-photo-claim.service';
import { BookingsController } from './bookings.controller';
import { AttachBookingMediaDto, CreateBookingDto } from './booking.dto';
import { BookingsService } from './bookings.service';
import { toBookingMediaResponse } from './booking-privacy.dto';
import { Booking } from './entities/booking.entity';
import { BookingMedia } from './entities/booking-media.entity';

const CUSTOMER_ID = '7f2fd9d2-e616-4d44-b2c3-9be271029eba';
const FOREIGN_CUSTOMER_ID = '9f2fd9d2-e616-4d44-b2c3-9be271029eba';
const BOOKING_ID = '4dd8729b-fb01-4f7b-b1f1-198a1e4a1771';
const UPLOAD_ID = '25b11d61-7c97-4a29-a53b-97ca76ac3435';
const MEDIA_ID = '35b11d61-7c97-4a29-a53b-97ca76ac3435';
const OBJECT_REF = 'storage://booking-private/7f2fd9d2-e616-4d44-b2c3-9be271029eba/private-object-key';
const LEGACY_PUBLIC_URL = 'https://legacy.example.invalid/public/photo.jpg';

type UploadSeed = {
  id: string;
  ownerUserId: string;
  objectRef: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: Date;
  claimedBookingId: string | null;
};

function makeCreateDto(overrides: Partial<CreateBookingDto> = {}): CreateBookingDto {
  return Object.assign(new CreateBookingDto(), {
    serviceId: '6f2fd9d2-e616-4d44-b2c3-9be271029eba',
    addressId: '8f2fd9d2-e616-4d44-b2c3-9be271029eba',
    description: 'Synthetic repair request',
    preferredStartAt: '2030-10-15T03:00:00.000Z',
    preferredEndAt: '2030-10-15T05:00:00.000Z',
    ...overrides,
  });
}

function makeUpload(overrides: Partial<UploadSeed> = {}): UploadSeed {
  return {
    id: UPLOAD_ID,
    ownerUserId: CUSTOMER_ID,
    objectRef: OBJECT_REF,
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    expiresAt: new Date('2030-10-15T00:00:00.000Z'),
    claimedBookingId: null,
    ...overrides,
  };
}

function makeTransactionFixture(seeds: UploadSeed[] = []) {
  let workingUploads = seeds.map((item) => ({ ...item }));
  const committed = { bookings: [] as Record<string, unknown>[], media: [] as Record<string, unknown>[], uploads: [] as UploadSeed[] };
  let stagedBookings: Record<string, unknown>[] = [];
  let stagedMedia: Record<string, unknown>[] = [];

  const bookingRepository = {
    create: vi.fn((value: Record<string, unknown>) => value),
    save: vi.fn(async (value: Record<string, unknown>) => {
      const saved = { id: BOOKING_ID, ...value };
      stagedBookings.push(saved);
      return saved;
    }),
  };
  const mediaRepository = {
    create: vi.fn((value: Record<string, unknown>) => value),
    save: vi.fn(async (value: Record<string, unknown> | Record<string, unknown>[]) => {
      const rows = (Array.isArray(value) ? value : [value]).map((row) => ({
        id: MEDIA_ID,
        ...row,
      }));
      stagedMedia.push(...rows);
      return Array.isArray(value) ? rows : rows[0];
    }),
  };
  const manager = {
    queryRunner: { isTransactionActive: true },
    getRepository: vi.fn((entity: unknown) => entity === Booking ? bookingRepository : mediaRepository),
    findOne: vi.fn(async (entity: unknown, options: { where?: { id?: string } }) => {
      if (entity !== PrivateBookingPhotoUpload) return null;
      return workingUploads.find((upload) => upload.id.toLowerCase() === options.where?.id?.toLowerCase()) ?? null;
    }),
    update: vi.fn(async (_entity: unknown, criteria: { id: string; ownerUserId: string }, values: Record<string, unknown>) => {
      const upload = workingUploads.find((item) =>
        item.id === criteria.id && item.ownerUserId === criteria.ownerUserId && item.claimedBookingId === null);
      if (!upload) return { affected: 0 };
      Object.assign(upload, values);
      return { affected: 1 };
    }),
  };
  const dataSource = {
    manager: {},
    query: vi.fn(async () => []),
    transaction: vi.fn(async <T>(callback: (transactionManager: typeof manager) => Promise<T>) => {
      stagedBookings = [];
      stagedMedia = [];
      const originalUploads = workingUploads.map((item) => ({ ...item }));
      try {
        const result = await callback(manager);
        committed.bookings.push(...stagedBookings);
        committed.media.push(...stagedMedia);
        committed.uploads = workingUploads.map((item) => ({ ...item }));
        return result;
      } catch (error) {
        workingUploads = originalUploads;
        throw error;
      }
    }),
  };
  const userRepository = { findOneBy: vi.fn(async () => ({ id: CUSTOMER_ID, bookingSuspendedUntil: null })) };
  const serviceRepository = {
    findOneBy: vi.fn(async () => ({
      id: '6f2fd9d2-e616-4d44-b2c3-9be271029eba',
      isActive: true,
      name: 'Synthetic repair',
      pricingMode: ServicePricingMode.INSPECTION_REQUIRED,
      description: 'Synthetic service',
    })),
  };
  const addressRepository = {
    findOneBy: vi.fn(async () => ({
      id: '8f2fd9d2-e616-4d44-b2c3-9be271029eba',
      userId: CUSTOMER_ID,
      line1: 'Synthetic address',
      ward: 'Synthetic Ward',
      district: 'Synthetic District',
      province: 'Synthetic Province',
      lat: 10.12345,
      lng: 106.12345,
      provinceCode: '79',
      districtCode: '760',
    })),
  };
  const audit = { log: vi.fn(async () => undefined) };
  const service = new BookingsService(
    {} as never,
    {} as never,
    userRepository as never,
    serviceRepository as never,
    addressRepository as never,
    {} as never,
    {} as never,
    {} as never,
    audit as never,
    dataSource as never,
    new PrivateBookingPhotoClaimService(),
    {} as never,
  );
  return { service, manager, dataSource, bookingRepository, mediaRepository, committed };
}

describe('B2b2 Booking private photo wiring', () => {
  it('accepts at most five unique UUID upload IDs in the create contract', () => {
    const valid = makeCreateDto({
      photoUploadIds: [
        UPLOAD_ID,
        '45b11d61-7c97-4a29-a53b-97ca76ac3435',
        '55b11d61-7c97-4a29-a53b-97ca76ac3435',
        '65b11d61-7c97-4a29-a53b-97ca76ac3435',
        '75b11d61-7c97-4a29-a53b-97ca76ac3435',
      ],
    });
    expect(validateSync(valid).some((error) => error.property === 'photoUploadIds')).toBe(false);

    const tooMany = makeCreateDto({
      photoUploadIds: [...valid.photoUploadIds!, '85b11d61-7c97-4a29-a53b-97ca76ac3435'],
    });
    expect(validateSync(tooMany).some((error) => error.property === 'photoUploadIds')).toBe(true);

    const duplicates = makeCreateDto({ photoUploadIds: [UPLOAD_ID, UPLOAD_ID] });
    expect(validateSync(duplicates).some((error) => error.property === 'photoUploadIds')).toBe(true);

    const malformed = makeCreateDto({ photoUploadIds: ['not-a-uuid'] });
    expect(validateSync(malformed).some((error) => error.property === 'photoUploadIds')).toBe(true);
  });

  it('rejects a create request that mixes private upload IDs with legacy public URLs before opening a transaction', async () => {
    const fixture = makeTransactionFixture([makeUpload()]);
    await expect(fixture.service.create(
      makeCreateDto({ photoUploadIds: [UPLOAD_ID], mediaUrls: [LEGACY_PUBLIC_URL] }),
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
    )).rejects.toThrow(/cannot combine|use one Booking photo source/i);
    expect(fixture.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('claims uploads and stores only private upload IDs and metadata in one Booking transaction', async () => {
    const fixture = makeTransactionFixture([makeUpload()]);
    const booking = await fixture.service.create(
      makeCreateDto({ photoUploadIds: [UPLOAD_ID] }),
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
    );

    expect(fixture.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.bookingRepository.save).toHaveBeenCalledTimes(1);
    expect(fixture.manager.findOne).toHaveBeenCalledWith(
      PrivateBookingPhotoUpload,
      expect.objectContaining({ where: { id: UPLOAD_ID } }),
    );
    expect(fixture.manager.update).toHaveBeenCalledTimes(1);
    expect(fixture.mediaRepository.save).toHaveBeenCalledTimes(1);
    expect(fixture.committed.bookings).toHaveLength(1);
    expect(fixture.committed.uploads[0].claimedBookingId).toBe(BOOKING_ID);
    expect(fixture.committed.media).toMatchObject([{
      bookingId: BOOKING_ID,
      privateUploadId: UPLOAD_ID,
      url: '',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
    }]);
    expect(JSON.stringify(booking)).not.toContain(OBJECT_REF);
    expect(JSON.stringify(fixture.committed.media)).not.toContain(OBJECT_REF);
  });

  it('rolls back the new Booking and upload claim when any requested upload is unavailable', async () => {
    const fixture = makeTransactionFixture([makeUpload({ ownerUserId: FOREIGN_CUSTOMER_ID })]);
    await expect(fixture.service.create(
      makeCreateDto({ photoUploadIds: [UPLOAD_ID] }),
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
    )).rejects.toThrow();
    expect(fixture.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.committed.bookings).toHaveLength(0);
    expect(fixture.committed.media).toHaveLength(0);
    expect(fixture.committed.uploads).toHaveLength(0);
  });

  it('rolls back the upload claim if private BookingMedia persistence fails inside the transaction', async () => {
    const fixture = makeTransactionFixture([makeUpload()]);
    fixture.mediaRepository.save.mockRejectedValueOnce(new Error('synthetic persistence failure'));
    await expect(fixture.service.create(
      makeCreateDto({ photoUploadIds: [UPLOAD_ID] }),
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
    )).rejects.toThrow(/synthetic persistence failure/i);
    expect(fixture.manager.update).toHaveBeenCalledTimes(1);
    expect(fixture.committed.bookings).toHaveLength(0);
    expect(fixture.committed.media).toHaveLength(0);
    expect(fixture.committed.uploads).toHaveLength(0);
  });

  it('keeps legacy public URLs but rejects private storage references from the legacy create field', async () => {
    const legacy = makeTransactionFixture();
    const booking = await legacy.service.create(
      makeCreateDto({ mediaUrls: [LEGACY_PUBLIC_URL] }),
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
    );
    expect(JSON.stringify(booking)).toContain(LEGACY_PUBLIC_URL);

    const privateRef = makeTransactionFixture();
    await expect(privateRef.service.create(
      makeCreateDto({ mediaUrls: [OBJECT_REF] }),
      { id: CUSTOMER_ID, role: Role.CUSTOMER },
    )).rejects.toThrow(/legacy public URL|http/i);
    expect(privateRef.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('does not expose an object reference from the legacy attach route contract', () => {
    const body = Object.assign(new AttachBookingMediaDto(), {
      url: LEGACY_PUBLIC_URL,
      photoUploadIds: [UPLOAD_ID],
    });
    expect(validateSync(body, { whitelist: true, forbidNonWhitelisted: true })
      .some((error) => error.property === 'photoUploadIds')).toBe(true);
    expect(validateSync(Object.assign(new AttachBookingMediaDto(), { url: OBJECT_REF }))
      .some((error) => error.property === 'url')).toBe(true);
  });

  it('serializes private media without URL, upload metadata IDs, or object references', () => {
    const response = toBookingMediaResponse({
      id: MEDIA_ID,
      bookingId: BOOKING_ID,
      privateUploadId: UPLOAD_ID,
      url: '',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      objectRef: OBJECT_REF,
    } as unknown as BookingMedia);

    expect(response).toEqual({
      id: MEDIA_ID,
      url: null,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      isPrivate: true,
      legacyInsecure: false,
    });
    expect(JSON.stringify(response)).not.toContain(OBJECT_REF);
    expect(JSON.stringify(response)).not.toContain(UPLOAD_ID);
  });

  it('keeps and labels existing public URLs as legacy insecure media', () => {
    expect(toBookingMediaResponse({
      id: MEDIA_ID,
      bookingId: BOOKING_ID,
      privateUploadId: null,
      url: LEGACY_PUBLIC_URL,
      mimeType: 'image/jpeg',
      sizeBytes: null,
    } as BookingMedia)).toEqual({
      id: MEDIA_ID,
      url: LEGACY_PUBLIC_URL,
      mimeType: 'image/jpeg',
      sizeBytes: null,
      isPrivate: false,
      legacyInsecure: true,
    });
    expect(toBookingMediaResponse({
      id: MEDIA_ID,
      bookingId: BOOKING_ID,
      privateUploadId: null,
      url: OBJECT_REF,
      mimeType: 'image/jpeg',
      sizeBytes: null,
      objectRef: OBJECT_REF,
    } as unknown as BookingMedia)).toMatchObject({
      url: null,
      isPrivate: false,
      legacyInsecure: true,
    });
  });

  it('sanitizes create, customer list, detail, technician detail, staff list, and attach responses', async () => {
    const privateMedia = {
      id: MEDIA_ID,
      bookingId: BOOKING_ID,
      privateUploadId: UPLOAD_ID,
      url: '',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      objectRef: OBJECT_REF,
    };
    const booking = {
      id: BOOKING_ID,
      media: [
        privateMedia,
        {
          id: '45b11d61-7c97-4a29-a53b-97ca76ac3435',
          bookingId: BOOKING_ID,
          privateUploadId: null,
          url: OBJECT_REF,
          mimeType: 'image/jpeg',
          sizeBytes: 1024,
          objectRef: OBJECT_REF,
        },
      ],
    };
    const service = {
      create: vi.fn(async () => booking),
      findMyBookings: vi.fn(async () => ({ data: [booking], total: 1 })),
      findAllForStaff: vi.fn(async () => ({ data: [booking], total: 1 })),
      findById: vi.fn(async () => booking),
      attachMedia: vi.fn(async () => privateMedia),
      reschedule: vi.fn(async () => booking),
      cancelBooking: vi.fn(async () => booking),
      rebook: vi.fn(async () => booking),
    };
    const controller = new BookingsController(
      service as never,
      { refreshMatching: vi.fn(async () => undefined) } as never,
      {} as never,
    );
    const attachBody = Object.assign(new AttachBookingMediaDto(), { url: LEGACY_PUBLIC_URL });
    const responses = [
      await controller.create(makeCreateDto(), { user: { id: CUSTOMER_ID, role: Role.CUSTOMER } }),
      await controller.findMy({ user: { id: CUSTOMER_ID } }),
      await controller.findAll(),
      await controller.findById(BOOKING_ID, { user: { id: CUSTOMER_ID, role: Role.CUSTOMER } }),
      await controller.findById(BOOKING_ID, { user: { id: FOREIGN_CUSTOMER_ID, role: Role.TECHNICIAN } }),
      await controller.attachMedia(BOOKING_ID, attachBody, {
        user: { id: CUSTOMER_ID, role: Role.CUSTOMER },
      }),
      await controller.reschedule(BOOKING_ID, {} as never, { user: { id: CUSTOMER_ID } }),
      await controller.cancelBooking(BOOKING_ID, { reason: 'synthetic' }, { user: { id: CUSTOMER_ID } }),
      await controller.rebook(BOOKING_ID, {} as never, { user: { id: CUSTOMER_ID, role: Role.CUSTOMER } }),
    ];

    for (const response of responses) {
      const json = JSON.stringify(response);
      expect(json).not.toContain(OBJECT_REF);
      expect(json).not.toContain('storage://');
      expect(json).not.toContain('"privateUploadId":"' + UPLOAD_ID + '"');
    }
    expect(JSON.stringify(responses[0])).toContain('"isPrivate":true');
    expect(service.findById).toHaveBeenCalledTimes(4);
  });
});
