import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AiThrottlerGuard } from './ai-throttler.guard';

// Counted per signed-in customer, so a household behind one router is not one
// person; per IP only for anonymous advice.
describe('AiThrottlerGuard tracker', () => {
  const guard = Object.create(AiThrottlerGuard.prototype) as AiThrottlerGuard;
  const track = (req: Record<string, unknown>) => (guard as any).getTracker(req);

  it('tracks a signed-in customer by account', async () => {
    expect(await track({ user: { id: 'c1' }, ip: '1.2.3.4' })).toBe('user:c1');
  });

  it('tracks anonymous advice by IP, preferring the forwarded client', async () => {
    expect(await track({ ip: '1.2.3.4' })).toBe('ip:1.2.3.4');
    expect(await track({ ips: ['9.9.9.9'], ip: '10.0.0.1' })).toBe('ip:9.9.9.9');
    expect(await track({})).toBe('ip:unknown');
  });
});
