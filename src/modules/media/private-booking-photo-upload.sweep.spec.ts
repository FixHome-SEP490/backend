import { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { PrivateBookingPhotoUpload } from './entities/private-booking-photo-upload.entity';
import { PrivateBookingPhotoUploadService } from './private-booking-photo-upload.service';
import { PrivateBookingPhotoStorage } from './private-booking-photo-storage.service';

const OWNER = '7f2fd9d2-e616-4d44-b2c3-9be271029eba';
const ref = (n: number) => `cloudinary://booking-photos/fixhome/booking-photos/${OWNER}/2debcf6f-1df5-488d-ae63-48ecbe44af4${n}`;

describe('PrivateBookingPhotoUploadService.sweepExpiredUploads', () => {
  it('deletes object then row, and keeps the row when the object cannot be deleted', async () => {
    const stale = [{ id: 'a', objectRef: ref(1), ownerUserId: OWNER }, { id: 'b', objectRef: ref(2), ownerUserId: OWNER }];
    const repo = { find: vi.fn().mockResolvedValue(stale), delete: vi.fn().mockResolvedValue({}) };
    const storage = { delete: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('down')) };
    const service = new PrivateBookingPhotoUploadService(
      repo as unknown as Repository<PrivateBookingPhotoUpload>,
      storage as unknown as PrivateBookingPhotoStorage,
    );

    expect(await service.sweepExpiredUploads()).toBe(1);
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(repo.delete).toHaveBeenCalledTimes(1);
    expect(repo.delete.mock.calls[0][0]).toMatchObject({ id: 'a' });
  });
});
