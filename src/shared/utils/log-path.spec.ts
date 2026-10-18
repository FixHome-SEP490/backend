import { describe, expect, it } from 'vitest';
import { logPath } from './log-path';

// Review 18/10/2026: viewing links must not end up in logs.
describe('logPath', () => {
  it('hides the grant in a viewing link and leaves every other path alone', () => {
    expect(logPath('/api/v1/bookings/media/stream/eyJrIjoiYiJ9.c2ln')).toBe('/api/v1/bookings/media/stream/[link]');
    expect(logPath('/api/v1/bookings/media/stream/eyJrIjoiYiJ9.c2ln/poster')).toBe('/api/v1/bookings/media/stream/[link]/poster');
    expect(logPath('/api/v1/messages/attachment/stream/abc.def')).toBe('/api/v1/messages/attachment/stream/[link]');
    // The JWT route that issues a link names only ids, which are fine to log.
    expect(logPath('/api/v1/bookings/b1/media/m1/stream')).toBe('/api/v1/bookings/b1/media/m1/stream');
    expect(logPath('/api/v1/service-orders/1')).toBe('/api/v1/service-orders/1');
  });
});
