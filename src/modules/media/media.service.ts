// src/modules/media/media.service.ts
import { Injectable, BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { randomUUID } from 'crypto';

export type UploadedMediaFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  private client() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_MEDIA_BUCKET;
    if (!url || !key || !bucket) {
      this.logger.error(
        `MediaService: missing env — SUPABASE_URL=${!!url} SUPABASE_SERVICE_ROLE_KEY=${!!key} SUPABASE_MEDIA_BUCKET=${!!bucket}`,
      );
      throw new ServiceUnavailableException('Media storage is not configured');
    }
    const baseUrl = url.replace(/\/$/, '');
    return {
      bucket,
      baseUrl,
      http: axios.create({
        baseURL: `${baseUrl}/storage/v1`,
        timeout: 15000,
        maxRedirects: 0,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }),
    };
  }

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

    const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const filename = `${randomUUID()}${ext}`;
    const objectPath = subfolder ? `${subfolder}/${filename}` : filename;

    const { http, bucket, baseUrl } = this.client();

    try {
      await http.post(`/object/${bucket}/${objectPath}`, file.buffer, {
        headers: {
          'Content-Type': file.mimetype,
          'x-upsert': 'true', // upsert=true to avoid 409 if UUID collides (practically impossible)
          'Cache-Control': 'public, max-age=31536000',
        },
        maxBodyLength: 11 * 1024 * 1024,
        maxContentLength: 11 * 1024 * 1024,
      });
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.error(
        `Supabase upload failed — bucket=${bucket} path=${objectPath} ` +
        `status=${axiosErr.response?.status} body=${JSON.stringify(axiosErr.response?.data)}`,
      );
      throw new ServiceUnavailableException('Không thể tải ảnh lên. Vui lòng thử lại.');
    }

    // Public bucket: return the public URL directly (no signed URL needed)
    const publicUrl = `${baseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;

    return {
      url: publicUrl,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      filename,
    };
  }
}
