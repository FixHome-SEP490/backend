import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface KycSignedAccess {
  signedUrl: string;
  expiresIn: number;
  expiresAt: string;
}

const DEFAULT_KYC_BUCKET = 'kyc-private';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;
const KYC_OBJECT_PREFIX = 'kyc';
const OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUPABASE_STORAGE_API_PREFIX = '/storage/v1';
const SUPABASE_OBJECT_SIGN_PREFIX = '/object/sign/';

@Injectable()
export class KycStorageService {
  constructor(private readonly config: ConfigService) {}

  validateObjectPath(storageObjectPath: string, technicianId: string): void {
    if (
      typeof storageObjectPath !== 'string' ||
      storageObjectPath.length === 0 ||
      storageObjectPath.length > 512 ||
      storageObjectPath !== storageObjectPath.trim() ||
      storageObjectPath.includes('\\') ||
      storageObjectPath.includes('?') ||
      storageObjectPath.includes('#') ||
      storageObjectPath.includes(':')
    ) {
      throw new BadRequestException(
        'storageObjectPath must be a private KYC object path',
      );
    }

    const segments = storageObjectPath.split('/');
    if (
      segments.length !== 3 ||
      segments[0] !== KYC_OBJECT_PREFIX ||
      segments[1] !== technicianId ||
      !OBJECT_KEY_PATTERN.test(segments[2])
    ) {
      throw new BadRequestException(
        'storageObjectPath must belong to the technician KYC prefix',
      );
    }
  }

  async createSignedAccess(
    storageObjectPath: string,
    technicianId: string,
  ): Promise<KycSignedAccess> {
    this.validateObjectPath(storageObjectPath, technicianId);

    const baseUrl = this.config.get<string>('SUPABASE_URL')?.trim();
    const serviceRoleKey = this.config
      .get<string>('SUPABASE_SERVICE_ROLE_KEY')
      ?.trim();
    if (!baseUrl || !serviceRoleKey) {
      throw new ServiceUnavailableException(
        'Private KYC storage is not configured',
      );
    }

    const bucket = this.getBucket();
    const expiresIn = this.getSignedUrlTtlSeconds();
    let providerUrl: URL;
    try {
      providerUrl = new URL(baseUrl);
    } catch {
      throw new ServiceUnavailableException(
        'Private KYC storage is not configured',
      );
    }
    if (!['http:', 'https:'].includes(providerUrl.protocol)) {
      throw new ServiceUnavailableException(
        'Private KYC storage is not configured',
      );
    }

    const encodedPath = storageObjectPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const encodedBucket = encodeURIComponent(bucket);
    const endpoint = `${providerUrl.origin}/storage/v1/object/sign/${encodedBucket}/${encodedPath}`;

    let signedUrlValue: unknown;
    try {
      const response = await axios.post<{ signedURL?: string; signedUrl?: string }>(
        endpoint,
        { expiresIn },
        {
          timeout: 5000,
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      signedUrlValue = response.data.signedURL ?? response.data.signedUrl;
    } catch {
      throw new ServiceUnavailableException(
        'Private KYC storage could not issue signed access',
      );
    }

    if (typeof signedUrlValue !== 'string' || !signedUrlValue) {
      throw new ServiceUnavailableException(
        'Private KYC storage returned an invalid signed access response',
      );
    }

    const signedUrl = this.resolveProviderSignedUrl(
      signedUrlValue,
      providerUrl,
    );

    return {
      signedUrl: signedUrl.toString(),
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  /**
   * Compose the final signed URL from the Supabase provider response.
   *
   * Supabase normally returns a relative path rooted at `/object/sign/...`
   * (without the `/storage/v1` API prefix), so naive `new URL(value, origin)`
   * composition drops the prefix and produces an unusable URL. Responses
   * already carrying `/storage/v1/...` are joined as-is. Absolute URLs are
   * accepted only when same-origin; anything cross-origin or malformed is
   * rejected fail-closed.
   */
  private resolveProviderSignedUrl(
    signedUrlValue: string,
    providerUrl: URL,
  ): URL {
    const invalid = () =>
      new ServiceUnavailableException(
        'Private KYC storage returned an invalid signed access response',
      );

    const raw = signedUrlValue.trim();
    if (!raw) throw invalid();

    // Absolute URL (carries a scheme): accept only when same-origin.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) {
      let absolute: URL;
      try {
        absolute = new URL(raw);
      } catch {
        throw invalid();
      }
      if (absolute.origin !== providerUrl.origin) throw invalid();
      if (absolute.pathname.startsWith(SUPABASE_OBJECT_SIGN_PREFIX)) {
        return new URL(
          `${providerUrl.origin}${SUPABASE_STORAGE_API_PREFIX}${absolute.pathname}${absolute.search}${absolute.hash}`,
        );
      }
      return absolute;
    }

    // Relative provider paths must be rooted; bare paths are malformed.
    if (!raw.startsWith('/') || raw.startsWith('//')) throw invalid();
    if (raw.startsWith(`${SUPABASE_STORAGE_API_PREFIX}/`)) {
      const resolved = new URL(raw, providerUrl.origin);
      if (resolved.origin !== providerUrl.origin) throw invalid();
      return resolved;
    }
    if (raw.startsWith(SUPABASE_OBJECT_SIGN_PREFIX)) {
      const resolved = new URL(
        `${SUPABASE_STORAGE_API_PREFIX}${raw}`,
        providerUrl.origin,
      );
      if (resolved.origin !== providerUrl.origin) throw invalid();
      return resolved;
    }
    throw invalid();
  }

  private getBucket(): string {
    const bucket =
      this.config.get<string>('SUPABASE_KYC_BUCKET')?.trim() ||
      DEFAULT_KYC_BUCKET;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/.test(bucket)) {
      throw new ServiceUnavailableException(
        'Private KYC storage bucket is not configured',
      );
    }
    return bucket;
  }

  private getSignedUrlTtlSeconds(): number {
    const configured = this.config.get<number | string>(
      'SUPABASE_KYC_SIGNED_URL_TTL_SECONDS',
    );
    const expiresIn =
      configured === undefined || configured === null || configured === ''
        ? DEFAULT_SIGNED_URL_TTL_SECONDS
        : Number(configured);
    if (
      !Number.isInteger(expiresIn) ||
      expiresIn < MIN_SIGNED_URL_TTL_SECONDS ||
      expiresIn > MAX_SIGNED_URL_TTL_SECONDS
    ) {
      throw new ServiceUnavailableException(
        'Private KYC storage signed URL TTL is not configured safely',
      );
    }
    return expiresIn;
  }
}
