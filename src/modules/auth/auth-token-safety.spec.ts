import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { redirectMatches } from './google-redirect.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthService } from './auth.service';
import { AccountStatus } from '../../shared/enums';

// Google sign-in hands the app a short-lived code through the browser. These
// tests pin what may receive it, that it is never an access token, and that it
// is spent once.

describe('Google redirect allowlist', () => {
  const allowed = ['exp://', 'fixhome://', 'http://localhost:5173', 'http://localhost:8081'];
  const ok = (url: string) => allowed.some((prefix) => redirectMatches(url, prefix));

  it.each([
    'http://localhost:5173/auth/google/done',
    'http://localhost:5173',
    'exp://192.168.1.5:8081/--/auth',
    'fixhome://auth',
  ])('accepts %s', (url) => expect(ok(url)).toBe(true));

  it.each([
    ['credentials trick', 'http://localhost:5173@evil.com/cb'],
    ['userinfo on expo', 'exp://user:pass@evil.com:8081'],
    ['look-alike host', 'http://localhost:51730/cb'],
    ['sub-domain trick', 'http://localhost:5173.evil.com/cb'],
    ['other scheme', 'https://localhost:5173/cb'],
    ['javascript', 'javascript:alert(1)'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => expect(ok(url)).toBe(false));

  it('keeps a path prefix a path prefix', () => {
    expect(redirectMatches('https://fixhome.vn/app/cb', 'https://fixhome.vn/app')).toBe(true);
    expect(redirectMatches('https://fixhome.vn/apps-evil/cb', 'https://fixhome.vn/app')).toBe(false);
    expect(redirectMatches('https://fixhome.vn.evil.com/app', 'https://fixhome.vn/app')).toBe(false);
  });
});

describe('Access tokens never carry a purpose', () => {
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.c', role: 'customer', status: AccountStatus.ACTIVE, isActive: true, fullName: 'A' };
  const strategy = new JwtStrategy(
    { getOrThrow: () => 'access-secret' } as never,
    { findOne: vi.fn(async () => user) } as never,
  );

  it('accepts an ordinary access token payload', async () => {
    await expect(strategy.validate({ sub: user.id } as never)).resolves.toMatchObject({ id: user.id });
  });

  it.each(['google_handoff', 'google_oauth_state'])('rejects a %s token used as a bearer token', async (purpose) => {
    await expect(strategy.validate({ sub: user.id, purpose } as never)).rejects.toThrow(UnauthorizedException);
  });
});

describe('Google hand-off code is spent once', () => {
  it('exchanges once, then refuses the same code', async () => {
    const jwtService = {
      verifyAsync: vi.fn(async () => ({ sub: 'user-1', purpose: 'google_handoff', jti: 'jti-1', exp: Math.floor(Date.now() / 1000) + 60 })),
      signAsync: vi.fn(), sign: vi.fn(), decode: vi.fn(),
    };
    const service = new AuthService({ manager: { transaction: vi.fn() } } as never, {} as never, jwtService as never, { get: () => 's', getOrThrow: () => 's' } as never, {} as never);
    const issue = vi.spyOn(service as unknown as { issueSessionForUser: () => Promise<unknown> }, 'issueSessionForUser').mockResolvedValue({ accessToken: 't' });

    await expect(service.exchangeGoogleHandoffCode('code')).resolves.toEqual({ accessToken: 't' });
    await expect(service.exchangeGoogleHandoffCode('code')).rejects.toThrow('đã được sử dụng');
    expect(issue).toHaveBeenCalledTimes(1);
    // the code is verified with its own key, not the access-token key
    expect(jwtService.verifyAsync).toHaveBeenCalledWith('code', expect.objectContaining({ secret: 's:google_handoff' }));
  });

  it('refuses a code without an id', async () => {
    const jwtService = { verifyAsync: vi.fn(async () => ({ sub: 'user-1', purpose: 'google_handoff' })), signAsync: vi.fn(), sign: vi.fn(), decode: vi.fn() };
    const service = new AuthService({ manager: { transaction: vi.fn() } } as never, {} as never, jwtService as never, { get: () => 's', getOrThrow: () => 's' } as never, {} as never);
    await expect(service.exchangeGoogleHandoffCode('code')).rejects.toThrow(UnauthorizedException);
  });
});
