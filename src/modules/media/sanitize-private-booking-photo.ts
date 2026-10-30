import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import { detectImageMimeType, type ImageMimeType, IMAGE_MAX_BYTES } from '../../shared/utils/media-signature';

const MAX_IMAGE_PIXELS = 25_000_000;

/** Re-encode pixels, preserving visual EXIF orientation but removing GPS, EXIF, XMP, and source chunks. */
export async function sanitizePrivateBookingPhoto(input: Buffer, mimeType: ImageMimeType): Promise<Buffer> {
  try {
    const image = sharp(input, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).rotate();
    const output = mimeType === 'image/jpeg'
      ? await image.jpeg({ quality: 88 }).toBuffer()
      : mimeType === 'image/png'
        ? await image.png().toBuffer()
        : await image.webp({ quality: 88 }).toBuffer();
    if (output.length === 0 || output.length > IMAGE_MAX_BYTES || detectImageMimeType(output) !== mimeType) {
      throw new BadRequestException('Invalid booking photo after sanitization');
    }
    return output;
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('Invalid booking photo encoding');
  }
}
