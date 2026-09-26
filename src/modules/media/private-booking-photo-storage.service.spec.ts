import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateBookingPhotoStorage } from './private-booking-photo-storage.service';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const OWNER_ID = '7f2fd9d2-e616-4d44-b2c3-9be271029eba';
const OTHER_OWNER_ID = '812fd9d2-e616-4d44-b2c3-9be271029eba';
const PNG_BYTES = Buffer.from('89504e470d0a1a0a00', 'hex');
const PNG_FILE = { buffer: PNG_BYTES, mimetype: 'image/png', size: PNG_BYTES.length };

const mockUploadStream = vi.fn();
const mockUrl = vi.fn();

const mockCloudinary = {
  uploader: { upload_stream: mockUploadStream },
  url: mockUrl,
} as any;

describe('PrivateBookingPhotoStorage', () => {
  const storage = new PrivateBookingPhotoStorage(mockCloudinary);
  const storageUnconfigured = new PrivateBookingPhotoStorage(null);

  afterEach(() => {
    vi.restoreAllMocks();
    mockUploadStream.mockReset();
    mockUrl.mockReset();
  });

  it('fails closed when Cloudinary is not configured', async () => {
    await expect(storageUnconfigured.upload(OWNER_ID, PNG_FILE)).rejects.toThrow(/not configured/i);
  });

  it('uploads to an owner-scoped random path and returns only an opaque private reference', async () => {
    mockUploadStream.mockImplementation((_opts: any, cb: any) => {
      const writable = new (require('stream').Writable)({
        write(_chunk: any, _encoding: any, callback: any) { callback(); },
      });
      writable.on('finish', () => cb(null, { secure_url: 'https://res.cloudinary.com/test/image/authenticated/fixhome/booking-photos/uuid.png' }));
      return writable;
    });

    const reference = await storage.upload(OWNER_ID, PNG_FILE);

    expect(reference).toMatch(/^cloudinary:\/\/booking-photos\/fixhome\/booking-photos\//);
    expect(reference).toContain(OWNER_ID.toLowerCase());
    expect(reference).not.toContain('https://');
    expect(mockUploadStream).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'image',
        type: 'authenticated',
        overwrite: false,
      }),
      expect.any(Function),
    );
  });

  it('rejects malformed, forged, oversized, or mismatched image uploads before making provider calls', async () => {
    const invalidFiles = [
      undefined,
      { ...PNG_FILE, buffer: Buffer.alloc(0), size: 0 },
      { ...PNG_FILE, size: PNG_FILE.size + 1 },
      { ...PNG_FILE, buffer: Buffer.alloc(MAX_FILE_SIZE + 1), size: MAX_FILE_SIZE + 1 },
      { ...PNG_FILE, buffer: Buffer.from('<script>'), size: 8 },
      { ...PNG_FILE, mimetype: 'image/jpeg' },
      { ...PNG_FILE, mimetype: 'image/svg+xml' },
    ];

    for (const file of invalidFiles) {
      await expect(storage.upload(OWNER_ID, file as Parameters<typeof storage.upload>[1])).rejects.toThrow();
    }

    expect(mockUploadStream).not.toHaveBeenCalled();
  });

  it('rejects invalid references for download', async () => {
    const validObjectId = '2debcf6f-1df5-488d-ae63-48ecbe44af45';
    const references = [
      `cloudinary://booking-photos/fixhome/booking-photos/${OTHER_OWNER_ID}/${validObjectId}`,
      'https://attacker.example/photo.png',
      `storage://booking-private/${OWNER_ID}/${validObjectId}`,
    ];

    for (const reference of references) {
      await expect(storage.download(reference, OWNER_ID)).rejects.toThrow();
    }
  });

  it('downloads via signed URL and detects MIME type from magic bytes', async () => {
    // Mock getOwnedPublicId to return a valid publicId — but the actual check
    // is that the reference format matches correctly. Use a valid format.
    const validRef = `cloudinary://booking-photos/fixhome/booking-photos/${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`;
    const expectedPublicId = `fixhome/booking-photos/${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`;

    mockUrl.mockReturnValue('https://res.cloudinary.com/signed-download');

    const { default: axios } = await import('axios');
    const getSpy = vi.spyOn(axios, 'get').mockResolvedValue({ data: PNG_BYTES });

    const result = await storage.download(validRef, OWNER_ID);

    expect(result).toEqual({ buffer: PNG_BYTES, mimeType: 'image/png' });
    expect(mockUrl).toHaveBeenCalledWith(expectedPublicId, expect.objectContaining({
      type: 'authenticated',
      sign_url: true,
      secure: true,
    }));

    getSpy.mockRestore();
  });
});
