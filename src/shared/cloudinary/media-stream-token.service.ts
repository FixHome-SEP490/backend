import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/** How long a viewing link works; the player asks for a new one when it runs out. */
export const MEDIA_STREAM_TTL_SECONDS = 15 * 60;

/** What a viewing link may open: a booking's video or a chat message's video, for one person. */
export interface MediaStreamGrant {
  /** `b` booking media, `m` chat message. */
  k: 'b' | 'm';
  /** Booking media id or message id. */
  id: string;
  /** The booking, for booking media. */
  b?: string;
  /** Who it was issued to, and their role, re-checked on every request. */
  u: string;
  r: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const encode = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/**
 * Viewing links for private videos (PO 18/10/2026). A `<video>` element cannot
 * send the Authorization header, and downloading a whole video before it plays
 * is useless on a weak connection, so the player gets a short-lived link it can
 * stream and seek with byte ranges. The link is signed with a key derived from
 * the access-token secret, names exactly one video and one person, and the
 * person's right to see the video is checked again whenever it is used.
 */
@Injectable()
export class MediaStreamTokens {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.key = createHmac('sha256', secret).update('fixhome:media-stream:v1').digest();
  }

  issue(grant: Omit<MediaStreamGrant, 'exp'>, now = Date.now()): { token: string; expiresAt: string } {
    const exp = Math.floor(now / 1000) + MEDIA_STREAM_TTL_SECONDS;
    const body = encode(JSON.stringify({ ...grant, exp }));
    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** The grant, or null when the link is forged, altered, of the wrong kind or expired. */
  verify(token: string, kind: MediaStreamGrant['k'], now = Date.now()): MediaStreamGrant | null {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const grant = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as MediaStreamGrant;
      if (grant.k !== kind || typeof grant.id !== 'string' || typeof grant.u !== 'string' || typeof grant.r !== 'string') return null;
      if (typeof grant.exp !== 'number' || grant.exp * 1000 <= now) return null;
      return grant;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}
