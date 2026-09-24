// src/modules/media/media.service.ts
import { Injectable, BadRequestException, Logger, ServiceUnavailableException, Inject, Optional } from '@nestjs/common';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { CLOUDINARY } from '../../shared/cloudinary';
import type { CloudinaryInstance, UploadApiResponse } from '../../shared/cloudinary';

export type UploadedMediaFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    @Optional() @Inject(CLOUDINARY) private readonly cloudinary: CloudinaryInstance | null,
  ) {}

  validate(file?: UploadedMediaFile): asserts file is UploadedMediaFile {
    if (!file?.buffer?.length || file.size !== file.buffer.length || file.size > 10 * 1024 * 1024) {
      throw new BadRequestException('Vui lòng chọn hình ảnh có kích thước dưới 10 MB');
    }
    const bytes = file.buffer;
    const valid =
      (file.mimetype === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ||
      (file.mimetype === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (file.mimetype === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
    if (!valid) {
      throw new BadRequestException('Chỉ chấp nhận định dạng ảnh JPEG, PNG hoặc WebP hợp lệ');
    }
  }

  async saveFile(
    file: UploadedMediaFile,
    subfolder = '',
  ): Promise<{ url: string; mimeType: string; sizeBytes: number; filename: string }> {
    this.validate(file);

    if (!this.cloudinary) {
      this.logger.error('MediaService: Cloudinary is not configured');
      throw new ServiceUnavailableException('Media storage is not configured');
    }

    const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const filename = `${randomUUID()}${ext}`;
    const publicId = subfolder ? `fixhome/media/${subfolder}/${filename}` : `fixhome/media/${filename}`;

    try {
      const result = await this.uploadToCloudinary(file.buffer, {
        public_id: publicId,
        resource_type: 'image',
        overwrite: true,
      });

      return {
        url: result.secure_url,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        filename,
      };
    } catch (err) {
      this.logger.error(
        `Cloudinary upload failed — publicId=${publicId} error=${(err as Error).message}`,
      );
      throw new ServiceUnavailableException('Không thể tải ảnh lên. Vui lòng thử lại.');
    }
  }

  private uploadToCloudinary(
    buffer: Buffer,
    options: Record<string, unknown>,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const stream = this.cloudinary!.uploader.upload_stream(
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
