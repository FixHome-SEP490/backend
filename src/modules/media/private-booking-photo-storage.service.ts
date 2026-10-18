import { BadRequestException, Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { CLOUDINARY, PrivateVideoService, VideoTooLongError, splitPlan, withPlan } from '../../shared/cloudinary';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import type { CloudinaryInstance, UploadApiResponse } from '../../shared/cloudinary';
import {
  detectImageMimeType,
  detectMediaMimeType,
  detectVideoMimeType,
  VIDEO_MAX_BYTES,
  type ImageMimeType,
  type VideoMimeType,
} from '../../shared/utils/media-signature';

export type PrivateBookingPhotoFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
};

export type PrivateBookingPhotoContent = {
  buffer: Buffer;
  mimeType: ImageMimeType | VideoMimeType;
};

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_REF_PREFIX = 'cloudinary://booking-photos/';
/** Short videos of the problem (PO 18/10/2026), kept private beside the photos. */
const VIDEO_REF_PREFIX = 'cloudinary://booking-videos/';

@Injectable()
export class PrivateBookingPhotoStorage {
  constructor(
    @Optional() @Inject(CLOUDINARY) private readonly cloudinary: CloudinaryInstance | null,
    @Optional() private readonly videos?: PrivateVideoService,
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

  /**
   * A video of the problem: mp4, mov or webm by its bytes, up to 50 MB. Returns the
   * type to store, which is the one the bytes show rather than the one the browser sent.
   */
  validateVideo(file?: PrivateBookingPhotoFile): VideoMimeType {
    if (
      !file ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length === 0 ||
      file.size !== file.buffer.length ||
      file.size > VIDEO_MAX_BYTES
    ) {
      throw new BadRequestException('Invalid booking video');
    }
    const detected = detectMediaMimeType(file.buffer, file.mimetype);
    if (!detected || detected.kind !== 'video') throw new BadRequestException('Invalid booking video');
    return detected.mimeType as VideoMimeType;
  }

  /**
   * Stores a validated video (location stamp blanked, at most a minute) and
   * returns its reference with the viewing plan: the original when it plays
   * everywhere, otherwise a copy Cloudinary makes in the background.
   */
  async uploadVideo(ownerId: string, file: PrivateBookingPhotoFile): Promise<string> {
    this.validateVideo(file);
    const normalizedOwnerId = this.normalizeOwnerId(ownerId);
    if (!this.videos?.configured) throw new ServiceUnavailableException('Private booking video storage is not configured');
    const publicId = `fixhome/booking-videos/${normalizedOwnerId}/${randomUUID()}`;
    try {
      const { plan } = await this.videos.store(publicId, file.buffer);
      return withPlan(`${VIDEO_REF_PREFIX}${publicId}`, plan);
    } catch (error) {
      if (error instanceof VideoTooLongError) throw new BusinessException(ErrorCodes.VIDEO_TOO_LONG, 'Video is longer than 60 seconds');
      throw new ServiceUnavailableException('Private booking video storage is unavailable');
    }
  }

  /** The video's storage id and viewing plan, after checking the reference belongs to this owner. */
  videoObject(reference: string, expectedOwnerId: string): { publicId: string; plan: 'orig' | 'mp4' } {
    const { reference: base, plan } = splitPlan(String(reference ?? ''));
    if (!base.startsWith(VIDEO_REF_PREFIX)) throw new BadRequestException('Invalid booking photo reference');
    return { publicId: this.getOwnedPublicId(base, expectedOwnerId), plan };
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
    reference = splitPlan(String(reference ?? '')).reference;
    const isVideo = reference.startsWith(VIDEO_REF_PREFIX);
    const publicId = this.getOwnedPublicId(reference, expectedOwnerId);
    const maxBytes = isVideo ? VIDEO_MAX_BYTES : MAX_FILE_SIZE;

    try {
      // Generate a short-lived signed URL to download the file
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      const signedUrl = cld.url(publicId, {
        type: 'authenticated',
        sign_url: true,
        resource_type: isVideo ? 'video' : 'image',
        secure: true,
        expires_at: expiresAt,
      });

      const response = await axios.get(signedUrl, {
        responseType: 'arraybuffer',
        maxContentLength: maxBytes,
        maxRedirects: 0,
        timeout: isVideo ? 60000 : 15000,
      });

      const buffer = Buffer.from(response.data);
      if (buffer.length === 0 || buffer.length > maxBytes) {
        throw new Error('Invalid booking media response');
      }

      const mimeType = isVideo ? detectVideoMimeType(buffer) : this.detectMimeType(buffer);
      if (!mimeType) {
        throw new Error('Invalid booking media response');
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

    const isVideo = typeof reference === 'string' && reference.startsWith(VIDEO_REF_PREFIX);
    if (typeof reference !== 'string' || (!reference.startsWith(PHOTO_REF_PREFIX) && !isVideo)) {
      throw new BadRequestException('Invalid booking photo reference');
    }

    const fullPrefix = isVideo ? VIDEO_REF_PREFIX : PHOTO_REF_PREFIX;
    const publicId = reference.slice(fullPrefix.length);
    // publicId should be fixhome/booking-photos/{ownerId}/{uuid} (booking-videos for a video)
    const segments = publicId.split('/');
    if (
      segments.length !== 4 ||
      segments[0] !== 'fixhome' ||
      segments[1] !== (isVideo ? 'booking-videos' : 'booking-photos') ||
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

  private detectMimeType(buffer: Buffer): ImageMimeType | undefined {
    return detectImageMimeType(buffer);
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
