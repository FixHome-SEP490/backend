import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import axios from 'axios';

export interface KycSignedAccess {
  signedUrl: string;
  expiresIn: number;
  expiresAt: string;
}

export interface KycSignedUpload {
  storageObjectPath: string;
  uploadUrl: string;
  token: string;
  expiresIn: number;
  expiresAt: string;
}

const DEFAULT_KYC_BUCKET = 'kyc-private';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 3600;
// Supabase issues signed upload URLs with a fixed ~2h lifetime; not configurable via the API.
const UPLOAD_SIGNED_URL_TTL_SECONDS = 7200;
const KYC_OBJECT_PREFIX = 'kyc';
const OBJECT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SUPABASE_STORAGE_API_PREFIX = '/storage/v1';
const SUPABASE_OBJECT_SIGN_PREFIX = '/object/sign/';
const SUPABASE_OBJECT_UPLOAD_SIGN_PREFIX = '/object/upload/sign/';
const SUPABASE_OBJECT_INFO_PREFIX = '/object/info/';

const KYC_UPLOAD_MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

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

    const expectedSignedPath = this.getExpectedSignedPath(
      bucket,
      storageObjectPath,
    );
    const endpoint = `${providerUrl.origin}${expectedSignedPath}`;

    let signedUrlValue: unknown;
    try {
      const response = await axios.post<{
        signedURL?: string;
        signedUrl?: string;
      }>(
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
      expectedSignedPath,
    );

    return {
      signedUrl,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  /**
   * Whether the private object was really uploaded. A submission may only
   * reference files that exist in the KYC bucket under the owner's own
   * prefix: the prefix proves the owner, the existence proves the upload went
   * through the signed upload URL (clients cannot write to the bucket any
   * other way). Storage being unreachable is not a "no": it fails closed with
   * 503 so nothing is saved on a guess.
   */
  async objectExists(
    storageObjectPath: string,
    ownerId: string,
  ): Promise<boolean> {
    this.validateObjectPath(storageObjectPath, ownerId);

    const baseUrl = this.config.get<string>('SUPABASE_URL')?.trim();
    const serviceRoleKey = this.config
      .get<string>('SUPABASE_SERVICE_ROLE_KEY')
      ?.trim();
    if (!baseUrl || !serviceRoleKey) {
      throw new ServiceUnavailableException(
        'Private KYC storage is not configured',
      );
    }
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

    const encodedBucket = encodeURIComponent(this.getBucket());
    const encodedPath = storageObjectPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const endpoint = `${providerUrl.origin}${SUPABASE_STORAGE_API_PREFIX}${SUPABASE_OBJECT_INFO_PREFIX}${encodedBucket}/${encodedPath}`;

    let response: { status: number; data: unknown };
    try {
      response = await axios.get(endpoint, {
        timeout: 5000,
        validateStatus: () => true,
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      });
    } catch {
      throw new ServiceUnavailableException(
        'Private KYC storage could not be checked',
      );
    }

    if (response.status === 200) {
      const info = response.data as { name?: unknown; size?: unknown } | null;
      return (
        !!info &&
        (info.name === undefined || info.name === storageObjectPath) &&
        typeof info.size === 'number' &&
        info.size > 0
      );
    }
    // Supabase answers a missing object with 400 and a body saying 404 / NoSuchKey.
    const body = (response.data ?? {}) as {
      statusCode?: unknown;
      error?: unknown;
      code?: unknown;
    };
    if (
      response.status === 404 ||
      (response.status === 400 &&
        (String(body.statusCode) === '404' ||
          body.error === 'not_found' ||
          body.code === 'NoSuchKey'))
    ) {
      return false;
    }
    throw new ServiceUnavailableException(
      'Private KYC storage could not be checked',
    );
  }

  async createSignedUploadUrl(
    technicianId: string,
    mimeType: string,
  ): Promise<KycSignedUpload> {
    const extension = KYC_UPLOAD_MIME_EXTENSIONS[mimeType];
    if (!extension) {
      throw new BadRequestException(
        'mimeType must be one of image/jpeg, image/png, image/webp, application/pdf, video/webm, video/mp4',
      );
    }

    const baseUrl = this.config.get<string>('SUPABASE_URL')?.trim();
    const serviceRoleKey = this.config
      .get<string>('SUPABASE_SERVICE_ROLE_KEY')
      ?.trim();
    if (!baseUrl || !serviceRoleKey) {
      throw new ServiceUnavailableException(
        'Private KYC storage is not configured',
      );
    }

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

    const bucket = this.getBucket();
    const storageObjectPath = `${KYC_OBJECT_PREFIX}/${technicianId}/${randomUUID()}.${extension}`;
    // Belt-and-suspenders: the path we just built must satisfy the same
    // contract enforced on submission, so a future refactor here can't
    // silently mint paths the submit endpoint would reject.
    this.validateObjectPath(storageObjectPath, technicianId);

    const encodedBucket = encodeURIComponent(bucket);
    const encodedPath = storageObjectPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const signPath = `${SUPABASE_STORAGE_API_PREFIX}${SUPABASE_OBJECT_UPLOAD_SIGN_PREFIX}${encodedBucket}/${encodedPath}`;
    const endpoint = `${providerUrl.origin}${signPath}`;

    let token: string | undefined;
    try {
      const response = await axios.post<{ url?: string }>(
        endpoint,
        {},
        {
          timeout: 5000,
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
            'Content-Type': 'application/json',
          },
        },
      );
      const returnedUrl = response.data?.url;
      const query =
        typeof returnedUrl === 'string' ? returnedUrl.split('?')[1] : undefined;
      token = query ? new URLSearchParams(query).get('token') ?? undefined : undefined;
    } catch {
      throw new ServiceUnavailableException(
        'Private KYC storage could not issue an upload URL',
      );
    }

    if (!token) {
      throw new ServiceUnavailableException(
        'Private KYC storage returned an invalid upload URL response',
      );
    }

    return {
      storageObjectPath,
      uploadUrl: `${endpoint}?token=${encodeURIComponent(token)}`,
      token,
      expiresIn: UPLOAD_SIGNED_URL_TTL_SECONDS,
      expiresAt: new Date(
        Date.now() + UPLOAD_SIGNED_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /**
   * Compose the final signed URL from the Supabase provider response.
   *
   * Supabase normally returns a relative path rooted at `/object/sign/...`
   * (without the `/storage/v1` API prefix). Responses already carrying
   * `/storage/v1/...` are also supported. The raw provider base is bound to
   * the exact private object before any URL parsing can normalize it.
   */
  private getExpectedSignedPath(
    bucket: string,
    storageObjectPath: string,
  ): string {
    const encodedPath = storageObjectPath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const encodedBucket = encodeURIComponent(bucket);
    return `${SUPABASE_STORAGE_API_PREFIX}${SUPABASE_OBJECT_SIGN_PREFIX}${encodedBucket}/${encodedPath}`;
  }

  private resolveProviderSignedUrl(
    signedUrlValue: string,
    providerUrl: URL,
    expectedSignedPath: string,
  ): string {
    const invalid = () =>
      new ServiceUnavailableException(
        'Private KYC storage returned an invalid signed access response',
      );

    const raw = signedUrlValue;
    const hasRawControlCharacter = [...raw].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
    if (!raw || raw.includes('#') || hasRawControlCharacter) {
      throw invalid();
    }

    const querySeparator = raw.indexOf('?');
    if (querySeparator <= 0) throw invalid();

    const rawBase = raw.slice(0, querySeparator);
    const rawQuery = raw.slice(querySeparator + 1);
    const expectedRelativePath = expectedSignedPath.slice(
      SUPABASE_STORAGE_API_PREFIX.length,
    );
    const allowedBases = new Set([
      expectedRelativePath,
      expectedSignedPath,
      `${providerUrl.origin}${expectedRelativePath}`,
      `${providerUrl.origin}${expectedSignedPath}`,
    ]);

    // Compare the untrusted base as raw text. Parsing it first could normalize
    // backslashes or dot segments and turn a malformed absolute value into a
    // trusted-looking origin/path.
    if (!allowedBases.has(rawBase) || rawQuery.split('&').length !== 1) {
      throw invalid();
    }

    const tokenSeparator = rawQuery.indexOf('=');
    if (tokenSeparator < 0 || rawQuery.slice(0, tokenSeparator) !== 'token') {
      throw invalid();
    }

    const rawToken = rawQuery.slice(tokenSeparator + 1);
    if (!rawToken) throw invalid();

    return `${providerUrl.origin}${expectedSignedPath}?token=${rawToken}`;
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
