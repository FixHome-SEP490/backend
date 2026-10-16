import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildIceServers, DEFAULT_TURN_TTL_SECONDS, hasTurn } from './ice-servers';
import { MessagingGateway } from './messaging.gateway';

const NOW = Date.UTC(2026, 9, 16, 7, 0, 0);
const NOW_S = NOW / 1000;
const USER = '11111111-1111-4111-8111-111111111111';
const TURN = { stunUrls: 'stun:stun.l.google.com:19302', turnUrls: 'turn:api.fixhome.sbs:3478?transport=udp, turns:api.fixhome.sbs:5349', turnSecret: 's3cret' };

describe('buildIceServers', () => {
  it('hands out STUN only when no relay is configured', () => {
    expect(buildIceServers({ stunUrls: 'stun:stun.l.google.com:19302' }, USER, NOW)).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('can switch STUN off entirely', () => {
    expect(buildIceServers({ stunUrls: '' }, USER, NOW)).toEqual([]);
  });

  it('adds the relay with a login that expires and an HMAC-SHA1 credential coturn can check', () => {
    const [stun, turn] = buildIceServers(TURN, USER, NOW);
    expect(stun).toEqual({ urls: ['stun:stun.l.google.com:19302'] });
    expect(turn.urls).toEqual(['turn:api.fixhome.sbs:3478?transport=udp', 'turns:api.fixhome.sbs:5349']);
    expect(turn.username).toBe(`${NOW_S + DEFAULT_TURN_TTL_SECONDS}:${USER}`);
    expect(turn.credential).toBe(createHmac('sha1', 's3cret').update(turn.username!).digest('base64'));
    expect(JSON.stringify(turn)).not.toContain('s3cret');
  });

  it('gives each user their own login', () => {
    const a = buildIceServers(TURN, USER, NOW)[1];
    const b = buildIceServers(TURN, '22222222-2222-4222-8222-222222222222', NOW)[1];
    expect(a.username).not.toBe(b.username);
    expect(a.credential).not.toBe(b.credential);
  });

  it('keeps the lifetime between ten minutes and seven days', () => {
    const ttl = (turnTtlSeconds: number) => Number(buildIceServers({ ...TURN, turnTtlSeconds }, USER, NOW)[1].username!.split(':')[0]) - NOW_S;
    expect(ttl(5)).toBe(600);
    expect(ttl(3600)).toBe(3600);
    expect(ttl(60 * 24 * 3600)).toBe(7 * 24 * 3600);
    expect(ttl(Number.NaN)).toBe(DEFAULT_TURN_TTL_SECONDS);
  });

  it('ignores a half-configured relay instead of sending a broken login', () => {
    expect(hasTurn({ ...TURN, turnSecret: '  ' })).toBe(false);
    expect(hasTurn({ ...TURN, turnUrls: ' , ' })).toBe(false);
    expect(buildIceServers({ ...TURN, turnSecret: '' }, USER, NOW)).toHaveLength(1);
  });
});

describe('MessagingGateway connect:ready', () => {
  function connect(env: Record<string, string | undefined>) {
    const gateway = new MessagingGateway(
      { listConversationIdsForUser: async () => [] } as never,
      {} as never,
      {} as never,
      { get: (key: string) => env[key] } as never,
      {} as never,
    );
    (gateway as unknown as { authenticate: () => Promise<unknown> }).authenticate = async () => ({ id: USER, role: 'customer' });
    const emitted: Array<{ event: string; payload: { iceServers: Array<{ urls: string[]; username?: string; credential?: string }> } }> = [];
    const client = { data: {}, join: async () => undefined, emit: (event: string, payload: never) => emitted.push({ event, payload }), disconnect: vi.fn() };
    return gateway.handleConnection(client as never).then(() => emitted.find((e) => e.event === 'connect:ready')!.payload.iceServers);
  }

  it('sends the default STUN server when nothing is configured', async () => {
    expect(await connect({})).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('sends a per-user TURN login when the relay is configured, never the secret', async () => {
    const ice = await connect({ WEBRTC_TURN_URLS: 'turn:api.fixhome.sbs:3478', WEBRTC_TURN_SECRET: 'top-secret', WEBRTC_TURN_TTL_SECONDS: '3600' });
    expect(ice).toHaveLength(2);
    expect(ice[1].urls).toEqual(['turn:api.fixhome.sbs:3478']);
    const [expiry, who] = ice[1].username!.split(':');
    expect(who).toBe(USER);
    expect(Number(expiry) - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
    expect(ice[1].credential).toBe(createHmac('sha1', 'top-secret').update(ice[1].username!).digest('base64'));
    expect(JSON.stringify(ice)).not.toContain('top-secret');
  });
});
