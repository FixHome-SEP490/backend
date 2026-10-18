import { describe, expect, it } from 'vitest';
import { detectMediaMimeType, detectVideoMimeType, maxBytesFor, mediaKindOf, VIDEO_MAX_BYTES, IMAGE_MAX_BYTES } from './media-signature';

const box = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftyp' + brand, 'ascii'), Buffer.alloc(16)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0]);

describe('media signature (PO 18/10/2026: photos and short videos)', () => {
  it.each([
    [jpeg, 'image/jpeg', { kind: 'image', mimeType: 'image/jpeg' }],
    [png, 'image/png', { kind: 'image', mimeType: 'image/png' }],
    [webp, 'image/webp', { kind: 'image', mimeType: 'image/webp' }],
    [box('isom'), 'video/mp4', { kind: 'video', mimeType: 'video/mp4' }],
    [box('mp42'), 'video/mp4', { kind: 'video', mimeType: 'video/mp4' }],
    [box('qt  '), 'video/quicktime', { kind: 'video', mimeType: 'video/quicktime' }],
    // An iPhone may report a .mov as mp4 or the other way round; the bytes decide what is stored.
    [box('qt  '), 'video/mp4', { kind: 'video', mimeType: 'video/quicktime' }],
    [box('3gp4'), 'video/3gpp', { kind: 'video', mimeType: 'video/mp4' }],
    [webm, 'video/webm', { kind: 'video', mimeType: 'video/webm' }],
  ])('reads what the bytes are (%#)', (buffer, declared, expected) => {
    expect(detectMediaMimeType(buffer, declared)).toEqual(expected);
  });

  it.each([
    ['a photo declared as another photo type', png, 'image/jpeg'],
    ['a photo declared as a video', jpeg, 'video/mp4'],
    ['a video declared as a photo', box('isom'), 'image/jpeg'],
    ['webm declared as mp4', webm, 'video/mp4'],
    ['an iso box declared as webm', box('isom'), 'video/webm'],
    ['a HEIC still image in an ISO box', box('heic'), 'video/mp4'],
    ['an AVIF still image', box('avif'), 'video/mp4'],
    ['a PDF', Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    ['text pretending to be a video', Buffer.from('<script>alert(1)</script>'), 'video/mp4'],
    ['an empty file', Buffer.alloc(0), 'video/mp4'],
    ['a truncated header', Buffer.from([0, 0, 0, 0x20, 0x66, 0x74]), 'video/mp4'],
  ])('refuses %s', (_label, buffer, declared) => {
    expect(detectMediaMimeType(buffer, declared)).toBeUndefined();
  });

  it('detects video bytes without a declared type and sizes each kind', () => {
    expect(detectVideoMimeType(box('M4V '))).toBe('video/mp4');
    expect(detectVideoMimeType(jpeg)).toBeUndefined();
    expect(mediaKindOf('video/quicktime')).toBe('video');
    expect(mediaKindOf('IMAGE/PNG')).toBe('image');
    expect(mediaKindOf(null)).toBe('image');
    expect(maxBytesFor('video')).toBe(VIDEO_MAX_BYTES);
    expect(maxBytesFor('image')).toBe(IMAGE_MAX_BYTES);
    expect(VIDEO_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});
