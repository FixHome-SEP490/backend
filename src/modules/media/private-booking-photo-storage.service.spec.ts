import { afterEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosInstance } from 'axios';
import { PrivateBookingPhotoStorage } from './private-booking-photo-storage.service';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const OWNER_ID = '7f2fd9d2-e616-4d44-b2c3-9be271029eba';
const OTHER_OWNER_ID = '812fd9d2-e616-4d44-b2c3-9be271029eba';
const PNG_BYTES = Buffer.from('89504e470d0a1a0a00', 'hex');
const PNG_FILE = { buffer: PNG_BYTES, mimetype: 'image/png', size: PNG_BYTES.length };

function configureStorage(): void {
  vi.stubEnv('SUPABASE_URL', 'https://privateproject.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only-secret');
  vi.stubEnv('SUPABASE_BOOKING_PRIVATE_BUCKET', 'booking-private');
  vi.stubEnv('SUPABASE_MEDIA_BUCKET', 'public-media');
  vi.stubEnv('SUPABASE_EVIDENCE_BUCKET', 'order-evidence');
}

function mockProvider() {
  const get = vi.fn().mockResolvedValue({ data: { public: false } });
  const post = vi.fn().mockResolvedValue({ data: { Key: 'provider-controlled-path' } });
  vi.spyOn(axios, 'create').mockReturnValue({ get, post } as unknown as AxiosInstance);
  return { get, post };
}

describe('PrivateBookingPhotoStorage', () => {
  const storage = new PrivateBookingPhotoStorage();

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('fails closed when the dedicated booking bucket configuration is missing', async () => {
    configureStorage();
    vi.stubEnv('SUPABASE_BOOKING_PRIVATE_BUCKET', '');
    const create = vi.spyOn(axios, 'create');

    await expect(storage.upload(OWNER_ID, PNG_FILE)).rejects.toThrow(/not configured/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects unsafe hosts and buckets that reuse another storage bucket', async () => {
    configureStorage();
    vi.stubEnv('SUPABASE_URL', 'https://supabase.co.attacker.example');
    const create = vi.spyOn(axios, 'create');

    await expect(storage.upload(OWNER_ID, PNG_FILE)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();

    vi.stubEnv('SUPABASE_URL', 'https://privateproject.supabase.co');
    vi.stubEnv('SUPABASE_BOOKING_PRIVATE_BUCKET', 'public-media');
    await expect(storage.upload(OWNER_ID, PNG_FILE)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a public or malformed bucket before uploading or downloading an object', async () => {
    configureStorage();
    const { get, post } = mockProvider();
    get.mockResolvedValue({ data: { public: true } });

    await expect(storage.upload(OWNER_ID, PNG_FILE)).rejects.toThrow(/unavailable/i);
    await expect(
      storage.download(`storage://booking-private/${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`, OWNER_ID),
    ).rejects.toThrow(/unavailable/i);

    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledWith('/bucket/booking-private');
  });

  it('uploads to an owner-scoped random path and returns only an opaque private reference', async () => {
    configureStorage();
    const { get, post } = mockProvider();

    const reference = await storage.upload(OWNER_ID, PNG_FILE);

    expect(reference).toMatch(
      new RegExp(`^storage://booking-private/${OWNER_ID}/[0-9a-f-]{36}$`),
    );
    expect(reference).not.toContain('https://');
    expect(reference).not.toContain('provider-controlled-path');
    expect(get).toHaveBeenCalledWith('/bucket/booking-private');
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^/object/booking-private/${OWNER_ID}/[0-9a-f-]{36}$`)),
      PNG_BYTES,
      expect.objectContaining({
        headers: { 'Content-Type': 'image/png' },
        maxBodyLength: MAX_FILE_SIZE,
      }),
    );
    const uploadConfig = post.mock.calls[0][2] as { headers: Record<string, string> };
    expect(uploadConfig.headers['x-upsert']).not.toBe('true');
    expect(uploadConfig.headers['Cache-Control']).toBeUndefined();
  });

  it('downloads bounded bytes and derives a safe MIME type from their signature only', async () => {
    configureStorage();
    const { get } = mockProvider();
    const objectPath = `${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`;
    get.mockResolvedValueOnce({ data: { public: false } });
    get.mockResolvedValueOnce({
      data: PNG_BYTES,
      headers: {
        'content-type': 'text/html',
        'content-disposition': 'attachment; filename="unsafe.html"',
        location: 'https://attacker.example/redirect',
      },
    });

    const result = await storage.download(`storage://booking-private/${objectPath}`, OWNER_ID);

    expect(result).toEqual({ buffer: PNG_BYTES, mimeType: 'image/png' });
    expect(Object.keys(result).sort()).toEqual(['buffer', 'mimeType']);
    expect(get).toHaveBeenNthCalledWith(1, '/bucket/booking-private');
    expect(get).toHaveBeenNthCalledWith(
      2,
      `/object/booking-private/${objectPath}`,
      expect.objectContaining({
        responseType: 'arraybuffer',
        maxContentLength: MAX_FILE_SIZE,
        maxRedirects: 0,
      }),
    );
  });

  it('rejects malformed, forged, oversized, or mismatched image uploads before making provider calls', async () => {
    configureStorage();
    const { get, post } = mockProvider();
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

    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects foreign-owner, malformed, traversal, and remote references before provider calls', async () => {
    configureStorage();
    const create = vi.spyOn(axios, 'create');
    const validObjectId = '2debcf6f-1df5-488d-ae63-48ecbe44af45';
    const references = [
      `storage://booking-private/${OTHER_OWNER_ID}/${validObjectId}`,
      `storage://other-bucket/${OWNER_ID}/${validObjectId}`,
      `storage://booking-private/${OWNER_ID}/../${validObjectId}`,
      `storage://booking-private/${OWNER_ID}/${validObjectId}/extra`,
      `storage://booking-private/${OWNER_ID}/%2e%2e%2fsecret`,
      'https://attacker.example/photo.png',
    ];

    for (const reference of references) {
      await expect(storage.download(reference, OWNER_ID)).rejects.toThrow();
    }
    await expect(storage.download(`storage://booking-private/${OWNER_ID}/${validObjectId}`, OTHER_OWNER_ID)).rejects.toThrow();

    expect(create).not.toHaveBeenCalled();
  });

  it('rejects oversized and malformed provider download responses without exposing provider details', async () => {
    configureStorage();
    const { get } = mockProvider();
    const reference = `storage://booking-private/${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`;
    const secretProviderError = new Error(`failed for ${reference} with test-only-secret`);
    get.mockResolvedValueOnce({ data: { public: false } });
    get.mockResolvedValueOnce({ data: Buffer.alloc(MAX_FILE_SIZE + 1) });

    await expect(storage.download(reference, OWNER_ID)).rejects.toThrow();
    get.mockReset();
    get.mockResolvedValueOnce({ data: { public: false } });
    get.mockResolvedValueOnce({ data: { url: 'https://attacker.example/image.png' } });
    await expect(storage.download(reference, OWNER_ID)).rejects.toThrow(/unavailable/i);
    get.mockReset();
    get.mockResolvedValueOnce({ data: { public: false } });
    get.mockRejectedValueOnce(secretProviderError);
    const failure = await storage.download(reference, OWNER_ID).catch((error: unknown) => error);
    expect((failure as Error).message).toContain('unavailable');
    expect((failure as Error).message).not.toContain(reference);
    expect((failure as Error).message).not.toContain('test-only-secret');
    expect((failure as Error).message).not.toContain('attacker');
  });

  it('rejects malformed bucket metadata without attempting object upload or download', async () => {
    configureStorage();
    const { get, post } = mockProvider();
    get.mockResolvedValue({ data: { public: 'false' } });

    await expect(storage.upload(OWNER_ID, PNG_FILE)).rejects.toThrow(/unavailable/i);
    expect(post).not.toHaveBeenCalled();
  });
});
