import { Readable } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FindOperator } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { BookingStatus, InvitationStatus, Role } from '../../shared/enums';
import { MediaStreamTokens } from '../../shared/cloudinary';
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
const OBJECT = '11111111-2222-4333-8444-555555555555';
const tokens = new MediaStreamTokens({ getOrThrow: () => 'test-access-secret-at-least-32-characters' } as never);

/** PO 18/10/2026: videos are watched through a short-lived viewing link instead of a full download. */
function harness(opts: { mimeType?: string; invitationExpiresAt?: Date } = {}) {
  const booking = { id: BOOKING_ID, customerId: CUSTOMER_ID, status: BookingStatus.MATCHING };
  const invitation = { bookingId: BOOKING_ID, technicianId: INVITED_ID, status: InvitationStatus.PENDING, expiresAt: opts.invitationExpiresAt ?? new Date(Date.now() + 60_000) };
  const media = { id: MEDIA_ID, bookingId: BOOKING_ID, privateUploadId: UPLOAD_ID, url: '' };
  const upload = {
    id: UPLOAD_ID, ownerUserId: CUSTOMER_ID, claimedBookingId: BOOKING_ID, mimeType: opts.mimeType ?? 'video/quicktime',
    objectRef: `cloudinary://booking-videos/fixhome/booking-videos/${CUSTOMER_ID}/${OBJECT}?r=mp4`,
  };
  const matches = (row: Record<string, unknown> | null | undefined, where: Record<string, unknown> = {}) =>
    !!row && Object.entries(where).every(([key, value]) =>
      value instanceof FindOperator ? (row[key] as Date) > (value.value as Date) : row[key] === value);
  const manager = {
    findOne: vi.fn(async (entity: unknown, options: { where?: Record<string, unknown>; lock?: unknown }) => {
      const row = entity === Booking ? booking : entity === BookingInvitation ? invitation : entity === BookingMedia ? media : entity === PrivateBookingPhotoUpload ? upload : null;
      return matches(row as Record<string, unknown> | null, options?.where) ? row : null;
    }),
  };
  const videos = {
    configured: true,
    open: vi.fn(async () => ({ status: 206, headers: { 'content-type': 'video/mp4' }, body: Readable.from([]), processing: false })),
    openPoster: vi.fn(async () => null),
  };
  const service = new BookingPrivateMediaContentService(
    { manager, transaction: vi.fn() } as never,
    new PrivateBookingPhotoStorage(null),
    videos as never,
    tokens,
  );
  return { service, manager, videos, invitation };
}

const invited = { id: INVITED_ID, role: Role.TECHNICIAN };

afterEach(() => vi.useRealTimers());

describe('Booking video viewing links', () => {
  it('gives the invited technician a link, without locking rows, and streams the video with their range', async () => {
    const { service, manager, videos } = harness();
    const link = await service.videoLink(BOOKING_ID, MEDIA_ID, invited);
    expect(link.url).toMatch(/^\/bookings\/media\/stream\/[\w-]+\.[\w-]+$/);
    expect(link.posterUrl).toBe(`${link.url}/poster`);
    expect(manager.findOne.mock.calls.every(([, options]) => !options?.lock)).toBe(true);

    const token = link.url.split('/').pop()!;
    await service.openVideo(token, 'bytes=100-', 'video');
    expect(videos.open).toHaveBeenCalledWith(`fixhome/booking-videos/${CUSTOMER_ID}/${OBJECT}`, 'mp4', 'video/quicktime', 'bytes=100-');
    await service.openVideo(token, undefined, 'poster');
    expect(videos.openPoster).toHaveBeenCalledWith(`fixhome/booking-videos/${CUSTOMER_ID}/${OBJECT}`, expect.stringMatching(/^(orig|mp4)$/));
  });

  it('refuses a link for a photo or for someone without the right', async () => {
    await expect(harness({ mimeType: 'image/jpeg' }).service.videoLink(BOOKING_ID, MEDIA_ID, invited)).rejects.toBeInstanceOf(BusinessException);
    await expect(harness().service.videoLink(BOOKING_ID, MEDIA_ID, { id: CUSTOMER_ID.replace('f6', 'a6'), role: Role.TECHNICIAN })).rejects.toBeInstanceOf(BusinessException);
  });

  it('opens nothing for a forged link or a chat link', async () => {
    const { service, videos } = harness();
    expect(await service.openVideo('forged.token', undefined, 'video')).toBeNull();
    const chat = tokens.issue({ k: 'm', id: MEDIA_ID, u: INVITED_ID, r: Role.TECHNICIAN }).token;
    expect(await service.openVideo(chat, undefined, 'video')).toBeNull();
    expect(videos.open).not.toHaveBeenCalled();
  });

  it('checks the right again a minute later: an expired invitation stops the stream', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, videos, invitation } = harness();
    const token = (await service.videoLink(BOOKING_ID, MEDIA_ID, invited)).url.split('/').pop()!;
    await service.openVideo(token, undefined, 'video');
    await service.openVideo(token, 'bytes=0-', 'video');
    expect(videos.open).toHaveBeenCalledTimes(2);

    invitation.expiresAt = new Date(Date.now() + 30_000);
    vi.setSystemTime(Date.now() + 61_000);
    expect(await service.openVideo(token, undefined, 'video')).toBeNull();
    expect(videos.open).toHaveBeenCalledTimes(2);
  });
});
