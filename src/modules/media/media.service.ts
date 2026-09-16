// src/modules/media/media.service.ts
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export type UploadedMediaFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

@Injectable()
export class MediaService {
  private readonly uploadDir = path.resolve(process.cwd(), 'uploads', 'media');

  constructor() {
    if (!fs.existsSync(this.uploadDir)) {
      fs.mkdirSync(this.uploadDir, { recursive: true });
    }
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

  async saveFile(file: UploadedMediaFile, subfolder = ''): Promise<{ url: string; mimeType: string; sizeBytes: number; filename: string }> {
    this.validate(file);
    const ext = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg';
    const filename = `${randomUUID()}${ext}`;
    const targetDir = subfolder ? path.join(this.uploadDir, subfolder) : this.uploadDir;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const filePath = path.join(targetDir, filename);
    await fs.promises.writeFile(filePath, file.buffer);

    const relativeUrl = subfolder ? `/api/v1/media/files/${subfolder}/${filename}` : `/api/v1/media/files/${filename}`;
    return {
      url: relativeUrl,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      filename,
    };
  }

  getFilePath(filename: string, subfolder = ''): { filePath: string; mimeType: string } {
    if (!/^[a-f0-9-]+(\.(jpg|jpeg|png|webp))$/i.test(filename)) {
      throw new BadRequestException('Tên tệp không hợp lệ');
    }
    const targetDir = subfolder ? path.join(this.uploadDir, subfolder) : this.uploadDir;
    const filePath = path.join(targetDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('Không tìm thấy tệp');
    }
    const ext = path.extname(filename).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { filePath, mimeType };
  }
}
