import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrderEvidenceStorage } from './order-evidence-storage.service';

const mockUploadStream = vi.fn();
const mockDestroy = vi.fn();
const mockUrl = vi.fn();

const mockCloudinary = {
  uploader: {
    upload_stream: mockUploadStream,
    destroy: mockDestroy,
  },
  url: mockUrl,
} as any;

describe('Private order evidence storage boundary', () => {
  const service = new OrderEvidenceStorage(mockCloudinary);
  const serviceUnconfigured = new OrderEvidenceStorage(null);
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = { buffer: png, size: png.length, mimetype: 'image/png' };
  afterEach(() => { vi.clearAllMocks(); });

  it('rejects empty, oversized and forged image uploads', () => {
    for (const input of [undefined, { ...file, size: 11 * 1024 * 1024 }, { ...file, buffer: Buffer.from('<script>'), size: 8 }, { ...file, mimetype: 'image/svg+xml' }]) expect(() => service.validate(input)).toThrow();
    expect(() => service.validate(file)).not.toThrow();
  });

  it('fails closed when Cloudinary is not configured', async () => {
    await expect(serviceUnconfigured.upload('order', 'owner', file)).rejects.toThrow('not configured');
  });

  it('uploads to Cloudinary and returns an opaque reference', async () => {
    mockUploadStream.mockImplementation((_opts: any, cb: any) => {
      const writable = new (require('stream').Writable)({
        write(_chunk: any, _encoding: any, callback: any) { callback(); },
      });
      writable.on('finish', () => cb(null, { secure_url: 'https://res.cloudinary.com/test/image/authenticated/fixhome/evidence/order/owner/uuid.png' }));
      return writable;
    });

    const ref = await service.upload('abcdef', '123456', file);
    expect(ref).toMatch(/^cloudinary:\/\/evidence\/fixhome\/evidence\/abcdef\/123456\//);
    expect(mockUploadStream).toHaveBeenCalledWith(
      expect.objectContaining({ resource_type: 'image', type: 'authenticated', overwrite: false }),
      expect.any(Function),
    );
  });

  it('issues a signed URL for valid references', async () => {
    const publicId = 'fixhome/evidence/order-1/owner-1/abc-def';
    const reference = `cloudinary://evidence/${publicId}`;
    mockUrl.mockReturnValue('https://res.cloudinary.com/signed');

    const url = await service.signedUrl(reference);
    expect(url).toBe('https://res.cloudinary.com/signed');
    expect(mockUrl).toHaveBeenCalledWith(publicId, expect.objectContaining({
      type: 'authenticated',
      sign_url: true,
      resource_type: 'image',
      secure: true,
    }));
  });

  it('rejects legacy Supabase references', async () => {
    await expect(service.signedUrl('storage://evidence/a/b/c')).rejects.toThrow('Legacy evidence');
  });

  it('rejects invalid references', async () => {
    await expect(service.signedUrl('https://untrusted.test/fake.png')).rejects.toThrow();
    await expect(service.signedUrl('cloudinary://evidence/../../../secret')).rejects.toThrow();
  });

  it('deletes from Cloudinary for valid references', async () => {
    const publicId = 'fixhome/evidence/order-1/owner-1/abc-def';
    mockDestroy.mockResolvedValue({ result: 'ok' });
    await service.delete(`cloudinary://evidence/${publicId}`);
    expect(mockDestroy).toHaveBeenCalledWith(publicId, { resource_type: 'image', type: 'authenticated' });
  });

  it('silently skips non-matching references on delete', async () => {
    await service.delete('storage://evidence/old-ref');
    expect(mockDestroy).not.toHaveBeenCalled();
  });
});
