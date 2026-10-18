import { Readable, Writable } from 'stream';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrivateVideoService,
  VIDEO_POSTER,
  VIDEO_RENDITION,
  VideoTooLongError,
  VideoUnavailableError,
  planFor,
  splitPlan,
  withPlan,
} from './private-video.service';

const ID = 'fixhome/booking-videos/owner/clip';

function cloudinary(meta: Record<string, unknown> = {}, derived: Array<{ format: string }> = []) {
  const uploaded: Buffer[] = [];
  return {
    uploaded,
    uploader: {
      upload_stream: vi.fn((options: Record<string, unknown>, done: (error: unknown, result: unknown) => void) => {
        const chunks: Buffer[] = [];
        return new Writable({
          write: (chunk, _enc, next) => { chunks.push(Buffer.from(chunk)); next(); },
          final: (cb) => { uploaded.push(Buffer.concat(chunks)); done(null, { public_id: options.public_id, ...meta }); cb(); },
        });
      }),
      explicit: vi.fn(async (_id: string, _options?: Record<string, unknown>) => ({})),
      destroy: vi.fn(async (_id: string, _options?: Record<string, unknown>) => ({ result: 'ok' })),
    },
    api: { resource: vi.fn(async (_id: string, _options?: Record<string, unknown>) => ({ derived })) },
    url: vi.fn((_id: string, options: Record<string, unknown>) => `https://res.cloudinary.example/${options.transformation ? 'copy' : 'original'}.${options.format}`),
  };
}

const H264 = { format: 'mp4', width: 720, height: 1280, duration: 21.4, bit_rate: 1_800_000, video: { codec: 'h264' } };

afterEach(() => vi.restoreAllMocks());

describe('planFor', () => {
  it('serves the original only when it is an H.264 MP4 of at most 1280 px and 3 Mbit/s', () => {
    expect(planFor(H264)).toBe('orig');
    expect(planFor({ ...H264, video: { codec: 'hevc' } })).toBe('mp4');
    expect(planFor({ ...H264, format: 'mov' })).toBe('mp4');
    expect(planFor({ ...H264, format: 'webm', video: { codec: 'vp9' } })).toBe('mp4');
    expect(planFor({ ...H264, width: 1920, height: 1080 })).toBe('mp4');
    expect(planFor({ ...H264, bit_rate: 9_000_000 })).toBe('mp4');
    expect(planFor({ ...H264, bit_rate: undefined })).toBe('mp4');
  });

  it('carries the plan in the reference; old references are originals', () => {
    expect(splitPlan(withPlan('cloudinary://x/y', 'mp4'))).toEqual({ reference: 'cloudinary://x/y', plan: 'mp4' });
    expect(splitPlan('cloudinary://x/y')).toEqual({ reference: 'cloudinary://x/y', plan: 'orig' });
    expect(splitPlan('cloudinary://x/y?r=evil')).toEqual({ reference: 'cloudinary://x/y', plan: 'orig' });
  });
});

describe('PrivateVideoService.store', () => {
  it('blanks the location, stores the original privately and asks only for a poster when the original plays everywhere', async () => {
    const cld = cloudinary(H264);
    const service = new PrivateVideoService(cld as never);
    const moov = Buffer.concat([Buffer.from([0, 0, 0, 34]), Buffer.from('moov+10.7769+106.7009/abcdefghijk', 'latin1')]);
    const file = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom\0\0\0\0', 'latin1'), moov]);
    await expect(service.store(ID, file)).resolves.toEqual({ plan: 'orig', seconds: 21.4 });
    expect(cld.uploader.upload_stream.mock.calls[0][0]).toEqual({ public_id: ID, resource_type: 'video', type: 'authenticated', overwrite: false });
    expect(cld.uploaded[0].toString('latin1')).not.toContain('+10.7769');
    expect(cld.uploader.explicit).toHaveBeenCalledWith(ID, {
      type: 'authenticated', resource_type: 'video', eager: [{ ...VIDEO_POSTER, format: 'jpg' }], eager_async: true,
    });
  });

  it('asks in the background for an H.264 copy of an iPhone HEVC clip', async () => {
    const cld = cloudinary({ ...H264, format: 'mov', video: { codec: 'hevc' } });
    const service = new PrivateVideoService(cld as never);
    await expect(service.store(ID, Buffer.from('x'))).resolves.toMatchObject({ plan: 'mp4' });
    expect(cld.uploader.explicit.mock.calls[0][1]).toMatchObject({
      eager: [{ ...VIDEO_POSTER, format: 'jpg' }, { ...VIDEO_RENDITION, format: 'mp4' }],
      eager_async: true,
    });
  });

  it('removes a clip over a minute and says so', async () => {
    const cld = cloudinary({ ...H264, duration: 75.2 });
    const service = new PrivateVideoService(cld as never);
    await expect(service.store(ID, Buffer.from('x'))).rejects.toBeInstanceOf(VideoTooLongError);
    expect(cld.uploader.destroy).toHaveBeenCalledWith(ID, { resource_type: 'video', type: 'authenticated', invalidate: true });
    expect(cld.uploader.explicit).not.toHaveBeenCalled();
  });

  it('keeps a clip whose copies could not be requested, and fails cleanly when storage refuses', async () => {
    const cld = cloudinary(H264);
    cld.uploader.explicit.mockRejectedValueOnce(new Error('rate limited'));
    await expect(new PrivateVideoService(cld as never).store(ID, Buffer.from('x'))).resolves.toMatchObject({ plan: 'orig' });
    const broken = cloudinary();
    broken.uploader.upload_stream.mockImplementationOnce((_o, done) => new Writable({ write: (_c, _e, next) => next(), final: (cb) => { done(new Error('down'), null); cb(); } }));
    await expect(new PrivateVideoService(broken as never).store(ID, Buffer.from('x'))).rejects.toBeInstanceOf(VideoUnavailableError);
    await expect(new PrivateVideoService(null).store(ID, Buffer.from('x'))).rejects.toBeInstanceOf(VideoUnavailableError);
  });
});

describe('PrivateVideoService.open', () => {
  const upstream = (status: number, headers: Record<string, string> = {}) =>
    vi.spyOn(axios, 'get').mockResolvedValue({ status, headers, data: Readable.from([Buffer.from('bytes')]) } as never);

  it('streams the original with the viewer range and passes the range headers back', async () => {
    const get = upstream(206, { 'content-range': 'bytes 0-99/5000', 'content-length': '100', 'set-cookie': 'x' });
    const service = new PrivateVideoService(cloudinary() as never);
    const stream = await service.open(ID, 'orig', 'video/quicktime', 'bytes=0-99');
    expect(get.mock.calls[0][0]).toBe('https://res.cloudinary.example/original.mov');
    expect(get.mock.calls[0][1]).toMatchObject({ responseType: 'stream', maxRedirects: 0, headers: { Range: 'bytes=0-99' } });
    expect(stream).toMatchObject({ status: 206, processing: false });
    expect(stream.headers).toEqual({ 'content-range': 'bytes 0-99/5000', 'content-length': '100', 'accept-ranges': 'bytes', 'content-type': 'video/quicktime' });
  });

  it('ignores a malformed or multi-part range', async () => {
    const get = upstream(200);
    const service = new PrivateVideoService(cloudinary() as never);
    await service.open(ID, 'orig', 'video/mp4', 'bytes=0-1,5-9');
    await service.open(ID, 'orig', 'video/mp4', 'items=0-1');
    expect(get.mock.calls.every((call) => !(call[1] as { headers: Record<string, string> }).headers.Range)).toBe(true);
  });

  it('serves the original while the copy is being made, then the copy once Cloudinary has it', async () => {
    upstream(200);
    const cld = cloudinary({}, [{ format: 'jpg' }]);
    const service = new PrivateVideoService(cld as never);
    const early = await service.open(ID, 'mp4', 'video/quicktime');
    expect(early).toMatchObject({ processing: true, headers: { 'content-type': 'video/quicktime' } });

    // Not asked again within 15 s.
    await service.open(ID, 'mp4', 'video/quicktime');
    expect(cld.api.resource).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16_000);
    cld.api.resource.mockResolvedValue({ derived: [{ format: 'jpg' }, { format: 'mp4' }] });
    const ready = await service.open(ID, 'mp4', 'video/quicktime');
    expect(ready).toMatchObject({ processing: false, headers: { 'content-type': 'video/mp4' } });
    expect(cld.url.mock.calls.at(-1)?.[1]).toMatchObject({ type: 'authenticated', sign_url: true, transformation: [VIDEO_RENDITION], format: 'mp4' });
    // Ready is remembered for good.
    await service.open(ID, 'mp4', 'video/quicktime');
    expect(cld.api.resource).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // Review 18/10/2026: a clip that needs no copy used to be checked every 15 s forever.
  it('asks Cloudinary only until what this video needs is there, then never again, and slows down when it takes long', async () => {
    const cld = cloudinary({}, [{ format: 'jpg' }]);
    const service = new PrivateVideoService(cld as never);
    vi.useFakeTimers({ toFake: ['Date'] });
    // An original that plays everywhere only needs its poster.
    await service.isReady(ID, 'orig');
    vi.setSystemTime(Date.now() + 3_600_000);
    await service.isReady(ID, 'orig');
    expect(cld.api.resource).toHaveBeenCalledTimes(1);

    // A copy that never arrives: every 15 s at first, then every 5 min after 10 min.
    const slowCld = cloudinary({}, []);
    const slow = new PrivateVideoService(slowCld as never);
    const slowApi = slowCld.api.resource;
    await slow.isReady(ID, 'mp4');
    for (let i = 0; i < 40; i++) {
      vi.setSystemTime(Date.now() + 16_000);
      await slow.isReady(ID, 'mp4');
    }
    expect(slowApi.mock.calls.length).toBeGreaterThan(30);
    const before = slowApi.mock.calls.length;
    for (let i = 0; i < 18; i++) {
      vi.setSystemTime(Date.now() + 16_000);
      await slow.isReady(ID, 'mp4');
    }
    expect(slowApi.mock.calls.length - before).toBeLessThanOrEqual(1);
    vi.useRealTimers();
  });

  it('has no poster until it is ready, and says storage is unavailable when it cannot be reached', async () => {
    const service = new PrivateVideoService(cloudinary({}, []) as never);
    await expect(service.openPoster(ID, 'orig')).resolves.toBeNull();
    vi.spyOn(axios, 'get').mockRejectedValue(new Error('ECONNRESET'));
    await expect(service.open(ID, 'orig', 'video/mp4')).rejects.toBeInstanceOf(VideoUnavailableError);
  });
});
