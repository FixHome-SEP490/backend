import 'reflect-metadata';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KycStorageService } from './kyc-storage.service';

describe('KycStorageService', () => {
  const serviceRoleKey = 'service-role-secret-for-test-only';
  let storage: KycStorageService;

  beforeEach(() => {
    storage = new KycStorageService({
      get: (key: string, fallback?: unknown) =>
        ({
          SUPABASE_URL: 'https://project.supabase.co',
          SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
          SUPABASE_KYC_BUCKET: 'kyc-private',
          SUPABASE_KYC_SIGNED_URL_TTL_SECONDS: 300,
        })[key] ?? fallback,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'https://project.supabase.co/storage/v1/object/public/kyc-private/id.jpg',
    '/kyc/tech-uuid-1/id.jpg',
    'kyc/other-tech/id.jpg',
    'kyc/tech-uuid-1/../other/id.jpg',
    'kyc/tech-uuid-1//id.jpg',
  ])('rejects invalid private object path %s', (path) => {
    expect(() => storage.validateObjectPath(path, 'tech-uuid-1')).toThrow(
      BadRequestException,
    );
  });

  it('accepts a path under the technician KYC prefix', () => {
    expect(() =>
      storage.validateObjectPath('kyc/tech-uuid-1/id-front.jpg', 'tech-uuid-1'),
    ).not.toThrow();
  });

  it('requests a bounded signed URL without returning the service-role key', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        signedURL:
          '/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
      },
    } as never);

    const result = await storage.createSignedAccess(
      'kyc/tech-uuid-1/id-front.jpg',
      'tech-uuid-1',
    );

    expect(axios.post).toHaveBeenCalledWith(
      'https://project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg',
      { expiresIn: 300 },
      expect.objectContaining({
        headers: expect.objectContaining({
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        }),
      }),
    );
    expect(result.expiresIn).toBe(300);
    expect(result.signedUrl).toBe(
      'https://project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    );
    expect(JSON.stringify(result)).not.toContain(serviceRoleKey);
  });

  it('keeps the storage prefix when the provider already returns /storage/v1/...', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        signedURL:
          '/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
      },
    } as never);

    const result = await storage.createSignedAccess(
      'kyc/tech-uuid-1/id-front.jpg',
      'tech-uuid-1',
    );

    expect(result.signedUrl).toBe(
      'https://project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    );
  });

  it('accepts a same-origin absolute provider URL', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        signedURL:
          'https://project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
      },
    } as never);

    const result = await storage.createSignedAccess(
      'kyc/tech-uuid-1/id-front.jpg',
      'tech-uuid-1',
    );

    expect(result.signedUrl).toBe(
      'https://project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    );
  });

  it('accepts a same-origin absolute provider URL without the storage prefix', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        signedURL:
          'https://project.supabase.co/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
      },
    } as never);

    const result = await storage.createSignedAccess(
      'kyc/tech-uuid-1/id-front.jpg',
      'tech-uuid-1',
    );

    expect(result.signedUrl).toBe(
      'https://project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    );
  });

  it('preserves an opaque percent-encoded token byte-for-byte', async () => {
    const rawToken = 'opaque%2fToken%3D%2B%25';
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        signedURL: `/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=${rawToken}`,
      },
    } as never);

    const result = await storage.createSignedAccess(
      'kyc/tech-uuid-1/id-front.jpg',
      'tech-uuid-1',
    );

    expect(result.signedUrl).toBe(
      `https://project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=${rawToken}`,
    );
  });

  it('rejects an Astra-style malformed absolute base before URL normalization', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        signedURL:
          'https://project.supabase.co\\../storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
      },
    } as never);

    await expect(
      storage.createSignedAccess('kyc/tech-uuid-1/id-front.jpg', 'tech-uuid-1'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it.each([
    [
      'wrong bucket',
      '/object/sign/other-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    [
      'wrong object',
      '/object/sign/kyc-private/kyc/tech-uuid-1/other.jpg?token=opaque',
    ],
    [
      'public endpoint',
      '/object/public/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    [
      'authenticated endpoint',
      '/object/authenticated/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    [
      'render endpoint',
      '/render/image/public/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    ['generic storage endpoint', '/storage/v1/anything?token=opaque'],
    [
      'traversal endpoint',
      '/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/../other.jpg?token=opaque',
    ],
    [
      'raw extra dot traversal to expected object',
      '/object/sign/kyc-private/kyc/tech-uuid-1/extra/../id-front.jpg?token=opaque',
    ],
    [
      'encoded dot traversal',
      '/object/sign/kyc-private/kyc/tech-uuid-1/extra/%2e%2e/id-front.jpg?token=opaque',
    ],
    [
      'mixed encoded traversal',
      '/object/sign/kyc-private/kyc/tech-uuid-1/extra/%2E%2e/id-front.jpg?token=opaque',
    ],
    [
      'double encoded traversal',
      '/object/sign/kyc-private/kyc/tech-uuid-1/extra/%252e%252e/id-front.jpg?token=opaque',
    ],
    [
      'cross-origin absolute URL',
      'https://evil.example.com/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    [
      'protocol-relative URL',
      '//project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    ['missing token', '/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg'],
    [
      'empty token',
      '/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=',
    ],
    [
      'duplicate token',
      '/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque&token=second',
    ],
    [
      'fragment',
      '/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque#fragment',
    ],
    [
      'raw CR LF in token',
      '/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque\r\ninjected',
    ],
    [
      'raw control character in token',
      '/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque\u0000injected',
    ],
    [
      'userinfo',
      'https://user:pass@project.supabase.co/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    [
      'bare relative path',
      'object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    ],
    ['malformed value', 'not-a-signed-url'],
    ['empty value', ''],
  ])('rejects %s provider response', async (_label, signedURL) => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: { signedURL },
    } as never);

    await expect(
      storage.createSignedAccess('kyc/tech-uuid-1/id-front.jpg', 'tech-uuid-1'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('fails closed when provider credentials are unavailable', async () => {
    const unconfigured = new KycStorageService({
      get: (key: string, fallback?: unknown) =>
        key === 'SUPABASE_KYC_SIGNED_URL_TTL_SECONDS' ? 300 : fallback,
    } as any);

    await expect(
      unconfigured.createSignedAccess('kyc/tech-uuid-1/id.jpg', 'tech-uuid-1'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  describe('createSignedUploadUrl', () => {
    it('mints a technician-scoped object path and returns the upload token', async () => {
      vi.spyOn(axios, 'post').mockResolvedValue({
        data: {
          url: '/object/upload/sign/kyc-private/kyc/tech-uuid-1/generated-id.jpg?token=opaque',
        },
      } as never);

      const result = await storage.createSignedUploadUrl(
        'tech-uuid-1',
        'image/jpeg',
      );

      expect(result.storageObjectPath).toMatch(
        /^kyc\/tech-uuid-1\/[0-9a-f-]+\.jpg$/,
      );
      expect(result.token).toBe('opaque');
      expect(result.uploadUrl).toBe(
        `https://project.supabase.co/storage/v1/object/upload/sign/kyc-private/${result.storageObjectPath}?token=opaque`,
      );
      expect(result.expiresIn).toBe(7200);
      expect(axios.post).toHaveBeenCalledWith(
        `https://project.supabase.co/storage/v1/object/upload/sign/kyc-private/${result.storageObjectPath}`,
        {},
        expect.objectContaining({
          headers: expect.objectContaining({
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          }),
        }),
      );
      expect(JSON.stringify(result)).not.toContain(serviceRoleKey);
    });

    it.each(['application/msword', 'text/plain', ''])(
      'rejects unsupported mimeType %s',
      async (mimeType) => {
        await expect(
          storage.createSignedUploadUrl('tech-uuid-1', mimeType),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('supports application/pdf and returns a .pdf storage path', async () => {
      vi.spyOn(axios, 'post').mockResolvedValue({
        data: {
          url: '/object/upload/sign/kyc-private/kyc/tech-uuid-1/generated-id.pdf?token=opaque',
        },
      } as never);

      const result = await storage.createSignedUploadUrl(
        'tech-uuid-1',
        'application/pdf',
      );

      expect(result.storageObjectPath).toMatch(
        /^kyc\/tech-uuid-1\/[0-9a-f-]+\.pdf$/,
      );
    });

    it('fails closed when the provider does not return a token', async () => {
      vi.spyOn(axios, 'post').mockResolvedValue({
        data: { url: '/object/upload/sign/kyc-private/kyc/tech-uuid-1/id.jpg' },
      } as never);

      await expect(
        storage.createSignedUploadUrl('tech-uuid-1', 'image/jpeg'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('fails closed when the provider request errors', async () => {
      vi.spyOn(axios, 'post').mockRejectedValue(new Error('network down'));

      await expect(
        storage.createSignedUploadUrl('tech-uuid-1', 'image/jpeg'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('fails closed when provider credentials are unavailable', async () => {
      const unconfigured = new KycStorageService({
        get: () => undefined,
      } as any);

      await expect(
        unconfigured.createSignedUploadUrl('tech-uuid-1', 'image/jpeg'),
      ).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
