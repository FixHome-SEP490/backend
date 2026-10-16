import { createHmac } from 'node:crypto';

/** One entry of RTCConfiguration.iceServers as the browser expects it. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceSettings {
  /** Comma-separated STUN urls; an empty string switches STUN off. */
  stunUrls: string;
  /** Comma-separated turn:/turns: urls of our own relay. */
  turnUrls?: string;
  /** Shared secret with coturn's `static-auth-secret` (use-auth-secret). */
  turnSecret?: string;
  /** How long a handed-out TURN login stays valid. */
  turnTtlSeconds?: number;
}

export const DEFAULT_TURN_TTL_SECONDS = 24 * 60 * 60;
const MIN_TURN_TTL_SECONDS = 10 * 60;
const MAX_TURN_TTL_SECONDS = 7 * 24 * 60 * 60;

const splitUrls = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

const clampTtl = (ttl: number | undefined): number => {
  if (!Number.isFinite(ttl) || !ttl) return DEFAULT_TURN_TTL_SECONDS;
  return Math.min(Math.max(Math.floor(ttl), MIN_TURN_TTL_SECONDS), MAX_TURN_TTL_SECONDS);
};

/** True when a TURN relay is fully configured (urls and secret both set). */
export const hasTurn = (settings: IceSettings): boolean =>
  splitUrls(settings.turnUrls).length > 0 && Boolean(settings.turnSecret?.trim());

/**
 * STUN finds the public address; TURN relays the audio when two networks
 * cannot reach each other (4G, strict NAT). The TURN login is never a fixed
 * password: it follows coturn's REST scheme, so the username carries its own
 * expiry and the credential is HMAC-SHA1(secret, username). A leaked login
 * dies on its own, and the secret never leaves the server.
 */
export function buildIceServers(settings: IceSettings, userId: string, nowMs = Date.now()): IceServer[] {
  const servers: IceServer[] = [];
  const stun = splitUrls(settings.stunUrls);
  if (stun.length > 0) servers.push({ urls: stun });

  if (hasTurn(settings)) {
    const expiresAt = Math.floor(nowMs / 1000) + clampTtl(settings.turnTtlSeconds);
    const username = `${expiresAt}:${userId}`;
    const credential = createHmac('sha1', settings.turnSecret!.trim()).update(username).digest('base64');
    servers.push({ urls: splitUrls(settings.turnUrls), username, credential });
  }
  return servers;
}
