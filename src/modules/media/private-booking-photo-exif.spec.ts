import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { Writable } from 'node:stream';
import { PrivateBookingPhotoStorage } from './private-booking-photo-storage.service';
import { sanitizePrivateBookingPhoto } from './sanitize-private-booking-photo';
import axios from 'axios';
import { randomFillSync } from 'node:crypto';

const OWNER_ID = '7f2fd9d2-e616-4d44-b2c3-9be271029eba';
const sent: Buffer[] = [];
const uploader = {
  upload_stream: vi.fn((_opts: unknown, done: (err: unknown, data: unknown) => void) => {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk: Buffer, _encoding, next) { chunks.push(chunk); next(); },
    });
    writable.on('finish', () => {
      sent.push(Buffer.concat(chunks));
      done(null, { public_id: 'fake-private-photo' });
    });
    return writable;
  }),
};
const storage = new PrivateBookingPhotoStorage({ uploader } as never);

function gpsLatitude(exif: Buffer): number[] {
  const tiff = exif.toString('ascii', 0, 4) === 'Exif' ? exif.subarray(6) : exif;
  expect(tiff.toString('ascii', 0, 2)).toBe('II');
  const root = tiff.readUInt32LE(4);
  for (let index = 0; index < tiff.readUInt16LE(root); index++) {
    const entry = root + 2 + index * 12;
    if (tiff.readUInt16LE(entry) !== 0x8825) continue;
    const gps = tiff.readUInt32LE(entry + 8);
    for (let gpsIndex = 0; gpsIndex < tiff.readUInt16LE(gps); gpsIndex++) {
      const gpsEntry = gps + 2 + gpsIndex * 12;
      if (tiff.readUInt16LE(gpsEntry) !== 2) continue;
      const offset = tiff.readUInt32LE(gpsEntry + 8);
      return [0, 8, 16].map((delta) => tiff.readUInt32LE(offset + delta) / tiff.readUInt32LE(offset + delta + 4));
    }
  }
  throw new Error('Synthetic fixture is missing its GPS latitude tag');
}

describe('BUG #34 EXIF GPS removal at private Booking photo storage boundary', () => {
  afterEach(() => { sent.length = 0; uploader.upload_stream.mockClear(); });

  it('removes metadata from historical photos on download without changing their object reference', async () => {
    const source = await sharp({ create: {
      width: 12, height: 4, channels: 3, background: 'red',
    } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const url = vi.fn().mockReturnValue('https://res.cloudinary.com/synthetic-private');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ data: source });
    try {
      const reader = new PrivateBookingPhotoStorage({ uploader, url } as never);
      const result = await reader.download(
        `cloudinary://booking-photos/fixhome/booking-photos/${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`, OWNER_ID,
      );
      const metadata = await sharp(result.buffer).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      expect(metadata.width).toBe(4);
      expect(metadata.height).toBe(12);
      expect(result.mimeType).toBe('image/jpeg');
      expect(uploader.upload_stream).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it('strips embedded metadata while auto-orienting JPEG pixels', async () => {
    const source = await sharp({ create: {
      width: 12, height: 4, channels: 3, background: { r: 200, g: 30, b: 60 },
    }}).jpeg().withExif({ IFD0: { Copyright: 'EXIF-GPS-marker-not-for-upload' } })
      .withMetadata({ orientation: 6 }).toBuffer();
    const before = await sharp(source).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);

    const ref = await storage.upload(OWNER_ID, { buffer: source, size: source.length, mimetype: 'image/jpeg' });
    expect(ref).toContain(OWNER_ID);
    expect(sent).toHaveLength(1);
    const actual = sent[0];
    expect(actual).not.toEqual(source);
    expect(actual.includes(Buffer.from('EXIF-GPS-marker-not-for-upload'))).toBe(false);
    const meta = await sharp(actual).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(12);
  });

  it.each(['image/png', 'image/webp'] as const)('re-encodes %s without source EXIF', async (mimeType) => {
    const base = sharp({ create: {
      width: 8, height: 5, channels: 3, background: { r: 20, g: 160, b: 30 },
    }});
    const source = await (mimeType === 'image/png' ? base.png() : base.webp())
      .withExif({ IFD0: { Copyright: 'GPSLatitude-synthetic' } }).toBuffer();
    const out = await sanitizePrivateBookingPhoto(source, mimeType);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe(mimeType.split('/')[1]);
    expect(meta.exif).toBeUndefined();
    expect(out.includes(Buffer.from('GPSLatitude-synthetic'))).toBe(false);
  });

  it('rejects corrupted JPEG and never sends it to provider', async () => {
    const fake = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00]);
    await expect(storage.upload(OWNER_ID, { buffer: fake, mimetype: 'image/jpeg', size: fake.length }))
      .rejects.toThrow('Invalid booking photo encoding');
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });

  it.each(['jpeg', 'png', 'webp'] as const)('strips real GPS tags and XMP and preserves oriented %s pixels', async (format) => {
    const pixels = Buffer.from([
      240, 10, 10, 240, 10, 10, 10, 220, 10,
      240, 10, 10, 10, 10, 240, 10, 10, 240,
    ]);
    const source = await sharp(pixels, { raw: { width: 3, height: 2, channels: 3 } })
      .toFormat(format).withExif({ IFD3: {
        GPSLatitudeRef: 'N', GPSLatitude: '12/1 34/1 56/1',
        GPSLongitudeRef: 'E', GPSLongitude: '78/1 9/1 10/1',
      } }).withMetadata({ orientation: 6 })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">SYNTHETIC-XMP-GPS</x:xmpmeta>').toBuffer();
    const before = await sharp(source).metadata();
    expect(gpsLatitude(before.exif!)).toEqual([12, 34, 56]);
    expect(before.xmp?.toString()).toContain('SYNTHETIC-XMP-GPS');
    const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp';
    await storage.upload(OWNER_ID, { buffer: source, size: source.length, mimetype: mimeType });
    const output = sent[0];
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format, width: 2, height: 3 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    const actual = await sharp(output).raw().toBuffer();
    const decodedExpected = await sharp(await sharp(source).rotate(90).toFormat(format, format === 'png' ? {} : { quality: 88 }).toBuffer()).raw().toBuffer();
    expect(actual).toEqual(decodedExpected);
    expect(output.includes(Buffer.from('SYNTHETIC-XMP-GPS'))).toBe(false);
  });

  it.each(['png', 'webp'] as const)('rejects malformed %s without provider calls', async (format) => {
    const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).toFormat(format).toBuffer();
    const truncated = source.subarray(0, 24);
    await expect(storage.upload(OWNER_ID, {
      buffer: truncated, size: truncated.length, mimetype: `image/${format}`,
    })).rejects.toThrow('Invalid booking photo encoding');
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });

  it('rejects a compressed pixel bomb before provider calls', async () => {
    const source = await sharp({ create: {
      width: 5001, height: 5000, channels: 3, background: 'red',
    } }).png().toBuffer();
    expect(source.length).toBeLessThan(10 * 1024 * 1024);
    await expect(storage.upload(OWNER_ID, { buffer: source, size: source.length, mimetype: 'image/png' }))
      .rejects.toThrow('Invalid booking photo encoding');
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });

  it('accepts the exact 10 MiB input and 25 million pixel boundaries', async () => {
    const png = await sharp({ create: {
      width: 5000, height: 5000, channels: 3, background: 'red',
    } }).png().toBuffer();
    const source = Buffer.alloc(10 * 1024 * 1024);
    png.copy(source);
    await storage.upload(OWNER_ID, { buffer: source, size: source.length, mimetype: 'image/png' });
    expect(sent).toHaveLength(1);
    expect(sent[0].length).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(await sharp(sent[0]).metadata()).toMatchObject({ width: 5000, height: 5000 });
  });

  it('rejects a small JPEG whose re-encoded output exceeds 10 MiB', async () => {
    const pixels = randomFillSync(Buffer.alloc(5000 * 5000 * 3));
    const source = await sharp(pixels, { raw: { width: 5000, height: 5000, channels: 3 } })
      .jpeg({ quality: 50 }).toBuffer();
    expect(source.length).toBeLessThan(10 * 1024 * 1024);
    await expect(storage.upload(OWNER_ID, { buffer: source, size: source.length, mimetype: 'image/jpeg' }))
      .rejects.toThrow('Invalid booking photo after sanitization');
    expect(uploader.upload_stream).not.toHaveBeenCalled();
  });
});
