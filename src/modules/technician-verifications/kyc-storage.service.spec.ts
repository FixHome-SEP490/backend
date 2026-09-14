import 'reflect-metadata';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
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
      storage.validateObjectPath(
        'kyc/tech-uuid-1/id-front.jpg',
        'tech-uuid-1',
      ),
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

  it('rejects a cross-origin absolute provider URL', async () => {
    vi.spyOn(axios, 'post').mockResolvedValue({
      data: {
        signedURL:
          'https://evil.example.com/storage/v1/object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
      },
    } as never);

    await expect(
      storage.createSignedAccess('kyc/tech-uuid-1/id-front.jpg', 'tech-uuid-1'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it.each([
    'object/sign/kyc-private/kyc/tech-uuid-1/id-front.jpg?token=opaque',
    'not-a-signed-url',
    '//evil.example.com/storage/v1/object/sign/x?token=opaque',
    '/object/public/kyc-private/kyc/tech-uuid-1/id-front.jpg',
    '',
  ])('rejects malformed relative provider response %s', async (signedURL) => {
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
});
