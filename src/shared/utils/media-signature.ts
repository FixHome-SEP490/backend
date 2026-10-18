/**
 * What a file really is, read from its first bytes rather than from the name or
 * the type the browser claims. Shared by the private booking media and the chat
 * attachments, which accept the same photos and short videos (PO 18/10/2026).
 */
export type ImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
export type VideoMimeType = 'video/mp4' | 'video/quicktime' | 'video/webm';
export type MediaKind = 'image' | 'video';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** About a minute of phone video; the file is held in memory while it is checked and stored. */
export const VIDEO_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Types a browser or phone may report for a video whose bytes are ISO-BMFF
 * (mp4, mov, m4v, 3gp) or Matroska/WebM. The stored type is the one the bytes
 * show, so a renamed file cannot pick its own Content-Type later.
 */
const DECLARED_ISO_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/3gpp']);
const DECLARED_WEBM_VIDEO_TYPES = new Set(['video/webm']);

export function detectImageMimeType(buffer: Buffer): ImageMimeType | undefined {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export function detectVideoMimeType(buffer: Buffer): VideoMimeType | undefined {
  // ISO base media file: a box size, then "ftyp" and the major brand.
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (/^heic|^heix|^mif1|^msf1|^avif/.test(brand)) return undefined; // still images in an ISO box
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  // EBML header (Matroska / WebM).
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return undefined;
}

/** The type of an image or video file, or undefined when its bytes are neither or contradict the declared type. */
export function detectMediaMimeType(
  buffer: Buffer,
  declaredMimeType: string,
): { kind: MediaKind; mimeType: ImageMimeType | VideoMimeType } | undefined {
  const declared = String(declaredMimeType ?? '').toLowerCase();
  const image = detectImageMimeType(buffer);
  if (image) return image === declared ? { kind: 'image', mimeType: image } : undefined;
  const video = detectVideoMimeType(buffer);
  if (!video) return undefined;
  const allowed = video === 'video/webm' ? DECLARED_WEBM_VIDEO_TYPES : DECLARED_ISO_VIDEO_TYPES;
  return allowed.has(declared) ? { kind: 'video', mimeType: video } : undefined;
}

export function mediaKindOf(mimeType: string | null | undefined): MediaKind {
  return String(mimeType ?? '').toLowerCase().startsWith('video/') ? 'video' : 'image';
}

export function maxBytesFor(kind: MediaKind): number {
  return kind === 'video' ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
}
