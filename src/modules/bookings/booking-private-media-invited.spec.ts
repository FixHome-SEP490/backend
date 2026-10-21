import { describe, expect, it, vi } from 'vitest';
import { EntityManager, FindOperator } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { BookingStatus, InvitationStatus, Role } from '../../shared/enums';
import { Booking } from './entities/booking.entity';
import { BookingMedia } from './entities/booking-media.entity';
import { BookingInvitation } from './entities/booking-invitation.entity';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { PrivateBookingPhotoStorage } from '../media/private-booking-photo-storage.service';
import { BookingPrivateMediaContentService } from './booking-private-media-content.service';

const BOOKING_ID = '4c2b539e-1d04-4efb-b908-ea9fd70bd9b1';
const MEDIA_ID = '45897f21-c2df-4bfb-9e8c-28b3fe6b90fa';
const UPLOAD_ID = '690718f8-2e51-4595-9ba7-13ec1e9f7e60';
const CUSTOMER_ID = 'f60c274d-3ab1-4c29-8ad2-982495f7d3e6';
const INVITED_ID = '7bd6466d-900b-4f3f-a03c-fc16b9874e13';
const OTHER_TECH_ID = '065be324-1173-4c8f-a739-b1af7c36d16c';
const LEAD_ID = 'c2a3c7a4-5bb1-4d5f-9d0e-6c0f6c2b9a11';
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

/** PO 18/10/2026: the technician the booking is offered to sees its photos and videos before accepting. */
function harness(opts: {
  bookingStatus?: BookingStatus;
  visitGroupId?: string;
  invitation?: Partial<BookingInvitation> | null;
  mimeType?: string;
  content?: { buffer: Buffer; mimeType: string };
} = {}) {
  const booking = { id: BOOKING_ID, customerId: CUSTOMER_ID, status: opts.bookingStatus ?? BookingStatus.MATCHING, visitGroupId: opts.visitGroupId ?? null };
  const invitation = opts.invitation === undefined
    ? { bookingId: BOOKING_ID, technicianId: INVITED_ID, status: InvitationStatus.PENDING, expiresAt: new Date(Date.now() + 60_000) }
    : opts.invitation;
  const media = { id: MEDIA_ID, bookingId: BOOKING_ID, privateUploadId: UPLOAD_ID, url: '' };
  const upload = { id: UPLOAD_ID, ownerUserId: CUSTOMER_ID, claimedBookingId: BOOKING_ID, objectRef: 'cloudinary://booking-videos/x', mimeType: opts.mimeType ?? 'video/mp4' };
  const matches = (row: Record<string, unknown> | null | undefined, where: Record<string, unknown> = {}) =>
    !!row && Object.entries(where).every(([key, value]) => {
      if (value instanceof FindOperator) {
        if (value.type === 'in') return (value.value as unknown[]).includes(row[key]);
        return value.type === 'moreThan' ? (row[key] as Date) > (value.value as Date) : false;
      }
      return row[key] === value;
    });
  const manager = {
    // The devices of a visit, when the booking is one (PO 21/10/2026).
    find: vi.fn(async () => (opts.visitGroupId ? [{ id: BOOKING_ID }, { id: LEAD_ID }] : [])),
    findOne: vi.fn(async (entity: unknown, options: { where?: Record<string, unknown> }) => {
      const row = entity === Booking ? booking
        : entity === BookingInvitation ? invitation
          : entity === BookingMedia ? media
            : entity === PrivateBookingPhotoUpload ? upload : null;
      return matches(row as Record<string, unknown> | null, options?.where) ? row : null;
    }),
  };
  const storage = { download: vi.fn(async () => opts.content ?? { buffer: MP4, mimeType: 'video/mp4' as const }) };
  const service = new BookingPrivateMediaContentService(
    { transaction: vi.fn(async (cb: (m: EntityManager) => Promise<unknown>) => cb(manager as unknown as EntityManager)) } as never,
    storage as unknown as PrivateBookingPhotoStorage,
  );
  return { service, storage, manager };
}

const invited = { id: INVITED_ID, role: Role.TECHNICIAN };

describe('Invited technician reads booking photos and videos', () => {
  it('serves another device of a visit to the technician invited for the visit on its lead booking (PO 21/10/2026)', async () => {
    const live = { bookingId: LEAD_ID, technicianId: INVITED_ID, status: InvitationStatus.PENDING, expiresAt: new Date(Date.now() + 60_000) };
    const { service } = harness({ visitGroupId: 'visit-1', invitation: live });
    await expect(service.download(BOOKING_ID, MEDIA_ID, invited)).resolves.toBeDefined();
    const outsider = harness({ visitGroupId: 'visit-1', invitation: { ...live, technicianId: OTHER_TECH_ID } });
    await expect(outsider.service.download(BOOKING_ID, MEDIA_ID, invited)).rejects.toBeInstanceOf(BusinessException);
  });

  it('serves a video to the technician holding the live invitation', async () => {
    const { service, storage } = harness();
    await expect(service.download(BOOKING_ID, MEDIA_ID, invited)).resolves.toEqual({ buffer: MP4, mimeType: 'video/mp4' });
    expect(storage.download).toHaveBeenCalledOnce();
  });

  it.each([
    ['another technician', { invitation: undefined }, { id: OTHER_TECH_ID, role: Role.TECHNICIAN }],
    ['an expired invitation', { invitation: { bookingId: BOOKING_ID, technicianId: INVITED_ID, status: InvitationStatus.PENDING, expiresAt: new Date(Date.now() - 1) } }, invited],
    ['a declined invitation', { invitation: { bookingId: BOOKING_ID, technicianId: INVITED_ID, status: InvitationStatus.DECLINED, expiresAt: new Date(Date.now() + 60_000) } }, invited],
    ['a standby invitation', { invitation: { bookingId: BOOKING_ID, technicianId: INVITED_ID, status: InvitationStatus.STANDBY, expiresAt: null } }, invited],
    ['a booking no longer matching', { bookingStatus: BookingStatus.CLOSED }, invited],
    ['a customer who does not own it', {}, { id: OTHER_TECH_ID, role: Role.CUSTOMER }],
  ])('refuses %s without reaching storage', async (_label, opts, actor) => {
    const { service, storage } = harness(opts as never);
    const error = await service.download(BOOKING_ID, MEDIA_ID, actor).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BusinessException);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('refuses content whose kind differs from what was uploaded', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { service } = harness({ mimeType: 'video/mp4', content: { buffer: png, mimeType: 'image/png' } });
    await expect(service.download(BOOKING_ID, MEDIA_ID, invited)).rejects.toThrow('unavailable');
  });

  it('refuses a video over 50 MB', async () => {
    const big = Buffer.alloc(50 * 1024 * 1024 + 1);
    const { service } = harness({ content: { buffer: big, mimeType: 'video/mp4' } });
    await expect(service.download(BOOKING_ID, MEDIA_ID, invited)).rejects.toThrow('unavailable');
  });
});
