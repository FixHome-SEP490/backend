import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Readable } from 'stream';
import axios from 'axios';
import { CLOUDINARY } from './cloudinary.provider';
import type { CloudinaryInstance, UploadApiResponse } from './cloudinary.provider';
import { stripVideoLocation } from '../utils/video-location';
import type { VideoMimeType } from '../utils/media-signature';

/** A clip of the problem is at most a minute (PO 18/10/2026); containers round, so two seconds of slack. */
export const VIDEO_MAX_SECONDS = 60;
const DURATION_SLACK_SECONDS = 2;

/**
 * The copy every phone and browser plays, small enough for a weak connection:
 * H.264 (main profile, level 3.1) + AAC in MP4, at most 1280 px on the long
 * side (portrait or landscape), about 1.5 Mbit/s, 15 to 30 fps.
 */
export const VIDEO_RENDITION = {
  crop: 'limit',
  width: 1280,
  height: 1280,
  video_codec: 'h264:main:3.1',
  audio_codec: 'aac',
  quality: 'auto',
  bit_rate: '1500k',
  frames_per_second: '15-30',
} as const;

/** A still for the tile, so nobody downloads a video just to see what it is. */
export const VIDEO_POSTER = { start_offset: 1, crop: 'limit', width: 640, height: 640, quality: 'auto' } as const;

/**
 * Whether the stored original already plays everywhere (`orig`) or a copy is
 * made for viewing (`mp4`): HEVC from iPhones, WebM, anything over 1280 px or
 * with a high bitrate.
 */
export type VideoPlan = 'orig' | 'mp4';

const ORIGINAL_EXTENSION: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

export class VideoTooLongError extends Error {
  constructor(readonly seconds: number) {
    super(`Video is ${seconds}s long; at most ${VIDEO_MAX_SECONDS}s`);
  }
}

export class VideoUnavailableError extends Error {}

interface VideoMetadata {
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
  bit_rate?: number | string;
  video?: { codec?: string };
}

/** Decides from what Cloudinary read in the file whether viewers can get the original. */
export function planFor(meta: VideoMetadata): VideoPlan {
  const codec = String(meta.video?.codec ?? '').toLowerCase();
  const longSide = Math.max(Number(meta.width) || 0, Number(meta.height) || 0);
  const bitRate = Number(meta.bit_rate) || 0;
  const playsEverywhere =
    meta.format === 'mp4' && codec === 'h264' && longSide > 0 && longSide <= 1280 && bitRate > 0 && bitRate <= 3_000_000;
  return playsEverywhere ? 'orig' : 'mp4';
}

/** `<reference>?r=<plan>`; references written before plans existed are originals. */
export function withPlan(reference: string, plan: VideoPlan): string {
  return `${reference}?r=${plan}`;
}

export function splitPlan(reference: string): { reference: string; plan: VideoPlan } {
  const at = reference.indexOf('?r=');
  if (at < 0) return { reference, plan: 'orig' };
  const plan = reference.slice(at + 3);
  return { reference: reference.slice(0, at), plan: plan === 'mp4' ? 'mp4' : 'orig' };
}

/** An open response from storage, to be piped to the viewer as is. */
export interface VideoStream {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  body: Readable;
  /** The playable copy is still being made; the original is served meanwhile. */
  processing: boolean;
}

const READY_RECHECK_MS = 15_000;
/** A copy still missing this long after the first look is probably not coming soon: ask far less often. */
const READY_SLOW_AFTER_MS = 10 * 60_000;
const READY_SLOW_RECHECK_MS = 5 * 60_000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const PASSED_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/**
 * Private videos (PO 18/10/2026): booking videos and chat videos.
 *
 * Stores the original as an `authenticated` Cloudinary asset (never public),
 * after blanking the phone's location stamp, refuses clips over a minute, and
 * asks Cloudinary in the background for a poster and, when the original would
 * not play everywhere or is heavy, an H.264 copy for viewing. Free plans only
 * transcode videos over 40 MB in the background, and authenticated assets can
 * only be served as such eager copies, so nothing is transcoded on request.
 *
 * Serving streams from storage with the viewer's `Range` header, so a video
 * starts playing at once and can be skipped through on a weak connection
 * instead of downloading in full first. The copy is used once Cloudinary has
 * finished it; asking for it earlier would fail and be cached as a failure.
 */
@Injectable()
export class PrivateVideoService {
  private readonly logger = new Logger(PrivateVideoService.name);
  private readonly ready = new Map<string, { mp4: boolean; poster: boolean; checkedAt: number; firstCheckedAt: number }>();

  constructor(@Optional() @Inject(CLOUDINARY) private readonly cloudinary: CloudinaryInstance | null) {}

  get configured(): boolean {
    return !!this.cloudinary;
  }

  /** Stores a validated video. Throws VideoTooLongError (asset removed) or VideoUnavailableError. */
  async store(publicId: string, buffer: Buffer): Promise<{ plan: VideoPlan; seconds: number }> {
    const cld = this.client();
    stripVideoLocation(buffer);
    let meta: UploadApiResponse;
    try {
      meta = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cld.uploader.upload_stream(
          { public_id: publicId, resource_type: 'video', type: 'authenticated', overwrite: false },
          (error, result) => (error || !result ? reject(error || new Error('Empty Cloudinary response')) : resolve(result)),
        );
        Readable.from(buffer).pipe(stream);
      });
    } catch (error) {
      this.logger.warn(`Video not stored: ${(error as Error)?.message ?? 'unknown'}`);
      throw new VideoUnavailableError('Video storage is unavailable');
    }
    const seconds = Number(meta.duration) || 0;
    if (seconds > VIDEO_MAX_SECONDS + DURATION_SLACK_SECONDS) {
      await cld.uploader
        .destroy(publicId, { resource_type: 'video', type: 'authenticated', invalidate: true })
        .catch(() => undefined);
      throw new VideoTooLongError(Math.round(seconds));
    }
    const plan = planFor(meta as VideoMetadata);
    try {
      await cld.uploader.explicit(publicId, {
        type: 'authenticated',
        resource_type: 'video',
        eager: plan === 'mp4' ? [{ ...VIDEO_POSTER, format: 'jpg' }, { ...VIDEO_RENDITION, format: 'mp4' }] : [{ ...VIDEO_POSTER, format: 'jpg' }],
        eager_async: true,
      });
    } catch (error) {
      // The original is kept and served; only the poster (and copy) are missing.
      this.logger.warn(`Video copies not requested: ${(error as Error)?.message ?? 'unknown'}`);
    }
    return { plan, seconds };
  }

  /** Streams the video for viewing, the playable copy once ready, honouring the viewer's byte range. */
  async open(publicId: string, plan: VideoPlan, originalMime: VideoMimeType, range?: string): Promise<VideoStream> {
    const cld = this.client();
    const useCopy = plan === 'mp4' && (await this.isReady(publicId, plan)).mp4;
    const url = useCopy
      ? cld.url(publicId, { resource_type: 'video', type: 'authenticated', sign_url: true, secure: true, transformation: [{ ...VIDEO_RENDITION }], format: 'mp4' })
      : cld.url(publicId, { resource_type: 'video', type: 'authenticated', sign_url: true, secure: true, format: ORIGINAL_EXTENSION[originalMime] ?? 'mp4' });
    const response = await this.fetch(url, range);
    return {
      status: response.status as 200 | 206 | 416,
      headers: { ...this.passHeaders(response.headers), 'content-type': useCopy ? 'video/mp4' : originalMime },
      body: response.data as Readable,
      processing: plan === 'mp4' && !useCopy,
    };
  }

  /** The poster still, or null while Cloudinary is still making it (the viewer then shows a plain tile). */
  async openPoster(publicId: string, plan: VideoPlan): Promise<VideoStream | null> {
    const cld = this.client();
    if (!(await this.isReady(publicId, plan)).poster) return null;
    const url = cld.url(publicId, { resource_type: 'video', type: 'authenticated', sign_url: true, secure: true, transformation: [{ ...VIDEO_POSTER }], format: 'jpg' });
    const response = await this.fetch(url);
    if (response.status !== 200) {
      (response.data as Readable).destroy();
      return null;
    }
    return { status: 200, headers: { ...this.passHeaders(response.headers), 'content-type': 'image/jpeg' }, body: response.data as Readable, processing: false };
  }

  /**
   * Whether Cloudinary has finished the copies this video needs (a poster, and
   * the H.264 copy only for the `mp4` plan), read from the asset's derived list.
   * Once finished it is remembered for good and never asked again; until then it
   * is asked at most every 15 s per video, and every 5 min after the first 10 min,
   * well inside the Admin API's hourly allowance.
   */
  async isReady(publicId: string, plan: VideoPlan): Promise<{ mp4: boolean; poster: boolean }> {
    const known = this.ready.get(publicId);
    if (known) {
      const finished = known.poster && (plan === 'orig' || known.mp4);
      const wait = Date.now() - known.firstCheckedAt > READY_SLOW_AFTER_MS ? READY_SLOW_RECHECK_MS : READY_RECHECK_MS;
      if (finished || Date.now() - known.checkedAt < wait) return known;
    }
    const firstCheckedAt = known?.firstCheckedAt ?? Date.now();
    let state = { mp4: false, poster: false, checkedAt: Date.now(), firstCheckedAt };
    try {
      const resource = (await this.client().api.resource(publicId, { resource_type: 'video', type: 'authenticated' })) as {
        derived?: Array<{ format?: string }>;
      };
      const formats = new Set((resource.derived ?? []).map((item) => item.format));
      state = { mp4: formats.has('mp4'), poster: formats.has('jpg'), checkedAt: Date.now(), firstCheckedAt };
    } catch (error) {
      this.logger.warn(`Video copies not checked: ${(error as Error)?.message ?? 'unknown'}`);
    }
    if (this.ready.size > 5000) this.ready.clear();
    this.ready.set(publicId, state);
    return state;
  }

  private async fetch(url: string, range?: string) {
    try {
      return await axios.get(url, {
        responseType: 'stream',
        maxRedirects: 0,
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: range && /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {},
        validateStatus: (status) => status === 200 || status === 206 || status === 416,
        decompress: false,
      });
    } catch (error) {
      this.logger.warn(`Video not read from storage: ${(error as Error)?.message ?? 'unknown'}`);
      throw new VideoUnavailableError('Video storage is unavailable');
    }
  }

  private passHeaders(headers: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of PASSED_HEADERS) {
      const value = headers[name];
      if (typeof value === 'string' || typeof value === 'number') out[name] = String(value);
    }
    out['accept-ranges'] = 'bytes';
    return out;
  }

  private client(): CloudinaryInstance {
    if (!this.cloudinary) throw new VideoUnavailableError('Video storage is not configured');
    return this.cloudinary;
  }
}
