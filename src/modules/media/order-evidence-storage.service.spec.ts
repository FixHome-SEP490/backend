import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { OrderEvidenceStorage } from './order-evidence-storage.service';

describe('Private order evidence storage boundary', () => {
  const service = new OrderEvidenceStorage();
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const file = { buffer: png, size: png.length, mimetype: 'image/png' };
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it('rejects empty, oversized and forged image uploads', () => {
    for (const input of [undefined, { ...file, size: 11 * 1024 * 1024 }, { ...file, buffer: Buffer.from('<script>'), size: 8 }, { ...file, mimetype: 'image/svg+xml' }]) expect(() => service.validate(input)).toThrow();
    expect(() => service.validate(file)).not.toThrow();
  });
  it('fails closed when provider configuration is absent', async () => {
    vi.stubEnv('SUPABASE_URL', '');
    await expect(service.upload('order', 'owner', file)).rejects.toThrow('not configured');
  });
  it('refuses a public bucket before uploading', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only');
    vi.stubEnv('SUPABASE_EVIDENCE_BUCKET', 'evidence');
    const post = vi.fn();
    vi.spyOn(axios, 'create').mockReturnValue({ get: vi.fn().mockResolvedValue({ data: { public: true } }), post } as unknown as ReturnType<typeof axios.create>);
    await expect(service.upload('order', 'owner', file)).rejects.toThrow('upload failed');
    expect(post).not.toHaveBeenCalled();
  });
  it('stores an opaque private reference and issues a five-minute signed URL', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only');
    vi.stubEnv('SUPABASE_EVIDENCE_BUCKET', 'evidence');
    const post = vi.fn().mockResolvedValue({ data: { signedURL: '/object/sign/evidence/a?token=test' } });
    vi.spyOn(axios, 'create').mockReturnValue({ get: vi.fn().mockResolvedValue({ data: { public: false } }), post } as unknown as ReturnType<typeof axios.create>);
    const ref = await service.upload('abcdef', '123456', file);
    expect(ref).toMatch(/^storage:\/\/evidence\/abcdef\/123456\//);
    expect(await service.signedUrl(ref)).toBe('https://example.supabase.co/storage/v1/object/sign/evidence/a?token=test');
    expect(post).toHaveBeenLastCalledWith(expect.stringContaining('/object/sign/evidence/'), { expiresIn: 300 });
    await expect(service.signedUrl('https://untrusted.test/fake.png')).rejects.toThrow();
    await expect(service.signedUrl('storage://evidence/../../../secret')).rejects.toThrow();
  });
});
