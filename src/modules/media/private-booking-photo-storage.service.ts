import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { CLOUDINARY } from '../../shared/cloudinary';
import type { CloudinaryInstance, UploadApiResponse } from '../../shared/cloudinary';

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

@Injectable()
export class PrivateBookingPhotoStorage {
  constructor(
    @Optional() @Inject(CLOUDINARY) private readonly cloudinary: CloudinaryInstance | null,
  ) {}

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
    const cld = this.getCloudinary();

    const publicId = `fixhome/booking-photos/${normalizedOwnerId}/${randomUUID()}`;

    try {
      await this.uploadToCloudinary(cld, file.buffer, {
        public_id: publicId,
        resource_type: 'image',
        type: 'authenticated', // Private — requires signed URLs to access
        overwrite: false,
      });
      return `cloudinary://booking-photos/${publicId}`;
    } catch {
      throw new ServiceUnavailableException('Private booking photo storage is unavailable');
    }
  }

  async download(reference: string, expectedOwnerId: string): Promise<PrivateBookingPhotoContent> {
    const cld = this.getCloudinary();
    const publicId = this.getOwnedPublicId(reference, expectedOwnerId);

    try {
      // Generate a short-lived signed URL to download the image
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      const signedUrl = cld.url(publicId, {
        type: 'authenticated',
        sign_url: true,
        resource_type: 'image',
        secure: true,
        expires_at: expiresAt,
      });

      const response = await axios.get(signedUrl, {
        responseType: 'arraybuffer',
        maxContentLength: MAX_FILE_SIZE,
        maxRedirects: 0,
        timeout: 15000,
      });

      const buffer = Buffer.from(response.data);
      if (buffer.length === 0 || buffer.length > MAX_FILE_SIZE) {
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

  private getOwnedPublicId(reference: string, expectedOwnerId: string): string {
    const ownerId = this.normalizeOwnerId(expectedOwnerId);

    if (typeof reference !== 'string' || !reference.startsWith('cloudinary://booking-photos/')) {
      throw new BadRequestException('Invalid booking photo reference');
    }

    const fullPrefix = 'cloudinary://booking-photos/';
    const publicId = reference.slice(fullPrefix.length);
    // publicId should be fixhome/booking-photos/{ownerId}/{uuid}
    const segments = publicId.split('/');
    if (
      segments.length !== 4 ||
      segments[0] !== 'fixhome' ||
      segments[1] !== 'booking-photos' ||
      !UUID_PATTERN.test(segments[2]) ||
      !UUID_PATTERN.test(segments[3]) ||
      segments[2] !== ownerId
    ) {
      throw new BadRequestException('Invalid booking photo reference');
    }
    return publicId;
  }

  private getCloudinary(): CloudinaryInstance {
    if (!this.cloudinary) {
      throw new ServiceUnavailableException('Private booking photo storage is not configured');
    }
    return this.cloudinary;
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

  private uploadToCloudinary(
    cld: CloudinaryInstance,
    buffer: Buffer,
    options: Record<string, unknown>,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = cld.uploader.upload_stream(
        options,
        (error, result) => {
          if (error || !result) return reject(error || new Error('Empty Cloudinary response'));
          resolve(result);
        },
      );
      Readable.from(buffer).pipe(stream);
    });
  }
}
