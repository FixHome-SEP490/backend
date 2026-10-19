import { Readable, Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStorage } from './chat-attachment-storage.service';
import { VideoTooLongError } from '../../shared/cloudinary';

const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const OBJECT = '33333333-3333-4333-8333-333333333333';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

function cloudinary() {
  const uploader = {
    upload_stream: vi.fn((options: Record<string, unknown>, done: (error: unknown, result: unknown) => void) => {
      return new Writable({ write: (_chunk, _enc, next) => next(), final: (cb) => { done(null, { public_id: options.public_id }); cb(); } });
    }),
  };
  return { uploader, url: vi.fn(() => 'https://res.cloudinary.example/signed') };
}

function videos(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    store: vi.fn(async () => ({ plan: 'mp4', seconds: 12 })),
    open: vi.fn(async () => ({ status: 206, headers: {}, body: Readable.from([]), processing: false })),
    openPoster: vi.fn(async () => null),
    ...overrides,
  };
}

describe('ChatAttachmentStorage', () => {
  it('uploads a photo privately under the conversation folder', async () => {
    const cld = cloudinary();
    const storage = new ChatAttachmentStorage(cld as never, videos() as never);
    const ref = await storage.upload(CONVERSATION, 'image', { buffer: JPEG, mimetype: 'image/jpeg', size: JPEG.length });
    expect(ref).toMatch(new RegExp(`^cloudinary://chat-media/image/fixhome/chat-media/${CONVERSATION}/[0-9a-f-]{36}$`));
    expect(cld.uploader.upload_stream.mock.calls[0][0]).toMatchObject({ resource_type: 'image', type: 'authenticated', overwrite: false });
  });

  it('stores a video through the video service and keeps its viewing plan in the reference', async () => {
    const cld = cloudinary();
    const video = videos();
    const storage = new ChatAttachmentStorage(cld as never, video as never);
    const ref = await storage.upload(CONVERSATION, 'video', { buffer: MP4, mimetype: 'video/mp4', size: MP4.length });
    expect(ref).toMatch(new RegExp(`^cloudinary://chat-media/video/fixhome/chat-media/${CONVERSATION}/[0-9a-f-]{36}\\?r=mp4$`));
    expect(video.store).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^fixhome/chat-media/${CONVERSATION}/`)), MP4);
    expect(cld.uploader.upload_stream).not.toHaveBeenCalled();
  });

  it('refuses a video over a minute with its own code', async () => {
    const storage = new ChatAttachmentStorage(cloudinary() as never, videos({ store: vi.fn(async () => { throw new VideoTooLongError(95); }) }) as never);
    await expect(storage.upload(CONVERSATION, 'video', { buffer: MP4, mimetype: 'video/mp4', size: MP4.length })).rejects.toMatchObject({ status: 422, response: { code: 'VIDEO_TOO_LONG' } });
  });

  it('streams a video with its plan and the viewer range, only from this conversation', async () => {
    const video = videos();
    const storage = new ChatAttachmentStorage(cloudinary() as never, video as never);
    const ref = `cloudinary://chat-media/video/fixhome/chat-media/${CONVERSATION}/${OBJECT}?r=mp4`;
    await storage.openVideo(ref, CONVERSATION, 'video/quicktime', 'bytes=0-99', 'video');
    expect(video.open).toHaveBeenCalledWith(`fixhome/chat-media/${CONVERSATION}/${OBJECT}`, 'mp4', 'video/quicktime', 'bytes=0-99');
    await expect(storage.openVideo(ref, '44444444-4444-4444-8444-444444444444', 'video/mp4', undefined, 'video')).rejects.toThrow('Invalid chat attachment');
    // A photo reference is never streamed as a video.
    expect(await storage.openVideo(`cloudinary://chat-media/image/fixhome/chat-media/${CONVERSATION}/${OBJECT}`, CONVERSATION, 'video/mp4', undefined, 'video')).toBeNull();
    await storage.openVideo(ref, CONVERSATION, 'video/mp4', undefined, 'poster');
    expect(video.openPoster).toHaveBeenCalledWith(`fixhome/chat-media/${CONVERSATION}/${OBJECT}`, expect.stringMatching(/^(orig|mp4)$/));
  });

  it.each([
    ['another conversation', `cloudinary://chat-media/image/fixhome/chat-media/44444444-4444-4444-8444-444444444444/${OBJECT}`],
    ['a booking photo', `cloudinary://booking-photos/fixhome/booking-photos/${CONVERSATION}/${OBJECT}`],
    ['an unknown kind', `cloudinary://chat-media/raw/fixhome/chat-media/${CONVERSATION}/${OBJECT}`],
    ['a path walk', `cloudinary://chat-media/image/fixhome/chat-media/${CONVERSATION}/../${OBJECT}`],
    ['an extra segment', `cloudinary://chat-media/image/fixhome/chat-media/${CONVERSATION}/${OBJECT}/x`],
  ])('never fetches %s', async (_label, reference) => {
    const cld = cloudinary();
    const storage = new ChatAttachmentStorage(cld as never);
    await expect(storage.download(reference, CONVERSATION)).rejects.toThrow('Invalid chat attachment');
    expect(cld.url).not.toHaveBeenCalled();
  });

  it('says storage is unavailable when Cloudinary is not configured', async () => {
    const storage = new ChatAttachmentStorage(null);
    await expect(storage.upload(CONVERSATION, 'image', { buffer: JPEG, mimetype: 'image/jpeg', size: JPEG.length })).rejects.toThrow('not configured');
    await expect(storage.upload(CONVERSATION, 'video', { buffer: MP4, mimetype: 'video/mp4', size: MP4.length })).rejects.toThrow('not configured');
  });

  it('rejects a file whose declared size does not match its bytes', () => {
    const storage = new ChatAttachmentStorage(null);
    expect(() => storage.inspect({ buffer: JPEG, mimetype: 'image/jpeg', size: JPEG.length + 1 })).toThrow('Invalid chat attachment');
  });
});
