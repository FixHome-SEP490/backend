import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';

export type PrivateBookingPhotoFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
};

export type PrivateBookingPhotoContent = {
  buffer: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
};

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPABASE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.supabase\.co$/i;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

type StorageConfiguration = {
  bucket: string;
  url: string;
  key: string;
};

@Injectable()
export class PrivateBookingPhotoStorage {
  validate(file?: PrivateBookingPhotoFile): asserts file is PrivateBookingPhotoFile {
    if (
      !file ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length === 0 ||
      file.size !== file.buffer.length ||
      file.size > MAX_FILE_SIZE
    ) {
      throw new BadRequestException('Invalid booking photo');
    }

    const detectedMimeType = this.detectMimeType(file.buffer);
    if (!detectedMimeType || detectedMimeType !== file.mimetype) {
      throw new BadRequestException('Invalid booking photo');
    }
  }

  async upload(ownerId: string, file: PrivateBookingPhotoFile): Promise<string> {
    this.validate(file);
    const normalizedOwnerId = this.normalizeOwnerId(ownerId);
    const configuration = this.getConfiguration();
    const http = this.createClient(configuration);
    const objectPath = `${normalizedOwnerId}/${randomUUID()}`;

    try {
      await this.assertPrivateBucket(http, configuration.bucket);
      await http.post(`/object/${configuration.bucket}/${objectPath}`, file.buffer, {
        headers: { 'Content-Type': file.mimetype },
        maxBodyLength: MAX_FILE_SIZE,
        maxContentLength: MAX_FILE_SIZE,
        maxRedirects: 0,
      });
      return `storage://${configuration.bucket}/${objectPath}`;
    } catch {
      throw new ServiceUnavailableException('Private booking photo storage is unavailable');
    }
  }

  async download(reference: string, expectedOwnerId: string): Promise<PrivateBookingPhotoContent> {
    const configuration = this.getConfiguration();
    const objectPath = this.getOwnedObjectPath(reference, configuration.bucket, expectedOwnerId);
    const http = this.createClient(configuration);

    try {
      await this.assertPrivateBucket(http, configuration.bucket);
      const response = await http.get(`/object/${configuration.bucket}/${objectPath}`, {
        responseType: 'arraybuffer',
        maxContentLength: MAX_FILE_SIZE,
        maxRedirects: 0,
      });
      const buffer = response?.data;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_FILE_SIZE) {
        throw new Error('Invalid booking photo response');
      }

      const mimeType = this.detectMimeType(buffer);
      if (!mimeType) {
        throw new Error('Invalid booking photo response');
      }

      return { buffer, mimeType };
    } catch {
      throw new ServiceUnavailableException('Private booking photo storage is unavailable');
    }
  }

  private normalizeOwnerId(ownerId: string): string {
    if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) {
      throw new BadRequestException('Invalid booking photo owner');
    }
    return ownerId.toLowerCase();
  }

  private getOwnedObjectPath(reference: string, bucket: string, expectedOwnerId: string): string {
    const ownerId = this.normalizeOwnerId(expectedOwnerId);
    const prefix = `storage://${bucket}/`;
    if (typeof reference !== 'string' || !reference.startsWith(prefix)) {
      throw new BadRequestException('Invalid booking photo reference');
    }

    const path = reference.slice(prefix.length);
    const segments = path.split('/');
    if (
      segments.length !== 2 ||
      !UUID_PATTERN.test(segments[0]) ||
      !UUID_PATTERN.test(segments[1]) ||
      segments[0] !== ownerId
    ) {
      throw new BadRequestException('Invalid booking photo reference');
    }
    return `${segments[0]}/${segments[1]}`;
  }

  private getConfiguration(): StorageConfiguration {
    const rawUrl = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_BOOKING_PRIVATE_BUCKET;

    if (
      !rawUrl ||
      !key?.trim() ||
      /[\r\n]/.test(key) ||
      !bucket ||
      !BUCKET_PATTERN.test(bucket) ||
      bucket === process.env.SUPABASE_MEDIA_BUCKET ||
      bucket === process.env.SUPABASE_EVIDENCE_BUCKET
    ) {
      throw new ServiceUnavailableException('Private booking photo storage is not configured');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new ServiceUnavailableException('Private booking photo storage is not configured');
    }

    if (
      parsedUrl.protocol !== 'https:' ||
      !SUPABASE_HOST_PATTERN.test(parsedUrl.hostname) ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.port ||
      (parsedUrl.pathname !== '' && parsedUrl.pathname !== '/') ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      throw new ServiceUnavailableException('Private booking photo storage is not configured');
    }

    return { bucket, url: parsedUrl.origin, key };
  }

  private createClient(configuration: StorageConfiguration): AxiosInstance {
    return axios.create({
      baseURL: `${configuration.url}/storage/v1`,
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: MAX_FILE_SIZE,
      headers: {
        apikey: configuration.key,
        Authorization: `Bearer ${configuration.key}`,
      },
    });
  }

  private async assertPrivateBucket(http: AxiosInstance, bucket: string): Promise<void> {
    const response = await http.get(`/bucket/${bucket}`);
    const data = response?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.public !== false) {
      throw new Error('Booking photo bucket must be private');
    }
  }

  private detectMimeType(buffer: Buffer): PrivateBookingPhotoContent['mimeType'] | undefined {
    if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      return 'image/jpeg';
    }
    if (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
      return 'image/png';
    }
    if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      return 'image/webp';
    }
    return undefined;
  }
}
