import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { CLOUDINARY } from '../../shared/cloudinary';
import type { CloudinaryInstance, UploadApiResponse } from '../../shared/cloudinary';

export type EvidenceFile = { buffer: Buffer; mimetype: string; size: number };

/** Private Cloudinary objects; only the order service may issue short-lived read URLs. */
@Injectable()
export class OrderEvidenceStorage {
  constructor(
    @Optional() @Inject(CLOUDINARY) private readonly cloudinary: CloudinaryInstance | null,
  ) {}

  validate(file?: EvidenceFile): asserts file is EvidenceFile {
    if (!file?.buffer?.length || file.size !== file.buffer.length || file.size > 10 * 1024 * 1024) throw new BadRequestException('Select an image up to 10 MB');
    const bytes = file.buffer;
    const valid = (file.mimetype === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
      || (file.mimetype === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      || (file.mimetype === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
    if (!valid) throw new BadRequestException('Only JPEG, PNG and WebP image files are accepted');
  }

  private getCloudinary(): CloudinaryInstance {
    if (!this.cloudinary) throw new ServiceUnavailableException('Private evidence storage is not configured');
    return this.cloudinary;
  }

  async upload(orderId: string, ownerId: string, file: EvidenceFile): Promise<string> {
    this.validate(file);
    const cld = this.getCloudinary();

    const publicId = `fixhome/evidence/${orderId}/${ownerId}/${randomUUID()}`;

    try {
      await this.uploadToCloudinary(cld, file.buffer, {
        public_id: publicId,
        resource_type: 'image',
        type: 'authenticated', // Private — requires signed URLs to access
        overwrite: false,
      });
      return `cloudinary://evidence/${publicId}`;
    } catch {
      // Do not expose provider responses, credentials or object paths to clients.
      throw new ServiceUnavailableException('Private evidence upload failed');
    }
  }

  async signedUrl(reference: string): Promise<string> {
    const cld = this.getCloudinary();
    const prefix = 'cloudinary://evidence/';

    // Support legacy Supabase references for backward compatibility
    if (reference.startsWith('storage://')) {
      throw new ServiceUnavailableException('Legacy evidence requires private storage migration');
    }

    if (!reference.startsWith(prefix)) throw new ServiceUnavailableException('Invalid evidence reference');
    const publicId = reference.slice(prefix.length);
    if (!publicId || publicId.includes('..')) throw new ServiceUnavailableException('Invalid evidence reference');

    try {
      // Generate a time-limited signed URL (5 minutes)
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      const url = cld.url(publicId, {
        type: 'authenticated',
        sign_url: true,
        resource_type: 'image',
        secure: true,
        expires_at: expiresAt,
      });
      return url;
    } catch {
      throw new ServiceUnavailableException('Evidence access is temporarily unavailable');
    }
  }

  async delete(reference: string): Promise<void> {
    const cld = this.getCloudinary();
    const prefix = 'cloudinary://evidence/';
    if (!reference.startsWith(prefix)) return;
    const publicId = reference.slice(prefix.length);
    try {
      await cld.uploader.destroy(publicId, { resource_type: 'image', type: 'authenticated' });
    } catch {
      // Non-blocking storage deletion
    }
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
