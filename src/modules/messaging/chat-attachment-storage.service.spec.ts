import { Writable } from 'stream';
import { describe, expect, it, vi } from 'vitest';
import { ChatAttachmentStorage } from './chat-attachment-storage.service';

const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const OBJECT = '33333333-3333-4333-8333-333333333333';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function cloudinary() {
  const uploader = {
    upload_stream: vi.fn((options: Record<string, unknown>, done: (error: unknown, result: unknown) => void) => {
      return new Writable({ write: (_chunk, _enc, next) => next(), final: (cb) => { done(null, { public_id: options.public_id }); cb(); } });
    }),
  };
  return { uploader, url: vi.fn(() => 'https://res.cloudinary.example/signed') };
}

describe('ChatAttachmentStorage', () => {
  it('uploads privately under the conversation folder with the right resource type', async () => {
    const cld = cloudinary();
    const storage = new ChatAttachmentStorage(cld as never);
    const ref = await storage.upload(CONVERSATION, 'video', { buffer: JPEG, mimetype: 'video/mp4', size: JPEG.length });
    expect(ref).toMatch(new RegExp(`^cloudinary://chat-media/video/fixhome/chat-media/${CONVERSATION}/[0-9a-f-]{36}$`));
    expect(cld.uploader.upload_stream.mock.calls[0][0]).toMatchObject({ resource_type: 'video', type: 'authenticated', overwrite: false });
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
  });

  it('rejects a file whose declared size does not match its bytes', () => {
    const storage = new ChatAttachmentStorage(null);
    expect(() => storage.inspect({ buffer: JPEG, mimetype: 'image/jpeg', size: JPEG.length + 1 })).toThrow('Invalid chat attachment');
  });
});
