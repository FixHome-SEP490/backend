import { describe, expect, it } from 'vitest';
import { MediaStreamTokens, MEDIA_STREAM_TTL_SECONDS } from './media-stream-token.service';

const config = (secret = 'test-access-secret-at-least-32-characters') => ({ getOrThrow: () => secret }) as never;
const GRANT = { k: 'b' as const, id: 'media-1', b: 'booking-1', u: 'user-1', r: 'technician' };

describe('MediaStreamTokens', () => {
  it('issues a link that names one video and one person, valid fifteen minutes', () => {
    const tokens = new MediaStreamTokens(config());
    const now = Date.UTC(2026, 9, 18, 5, 0, 0);
    const { token, expiresAt } = tokens.issue(GRANT, now);
    expect(expiresAt).toBe(new Date(now + MEDIA_STREAM_TTL_SECONDS * 1000).toISOString());
    expect(tokens.verify(token, 'b', now + 60_000)).toEqual({ ...GRANT, exp: (now / 1000) + MEDIA_STREAM_TTL_SECONDS });
    expect(tokens.verify(token, 'b', now + MEDIA_STREAM_TTL_SECONDS * 1000)).toBeNull();
  });

  it('refuses a link of the other kind, an altered or re-signed one, and garbage', () => {
    const tokens = new MediaStreamTokens(config());
    const { token } = tokens.issue(GRANT);
    expect(tokens.verify(token, 'm')).toBeNull();
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...GRANT, u: 'someone-else', exp: 9_999_999_999 })).toString('base64url');
    expect(tokens.verify(`${forged}.${signature}`, 'b')).toBeNull();
    expect(tokens.verify(`${body}.${signature.slice(0, -2)}xx`, 'b')).toBeNull();
    expect(tokens.verify(new MediaStreamTokens(config('another-secret-at-least-32-characters!!')).issue(GRANT).token, 'b')).toBeNull();
    for (const junk of ['', 'abc', `${body}.${signature}.x`, 'a'.repeat(3000)]) expect(tokens.verify(junk, 'b')).toBeNull();
  });
});
