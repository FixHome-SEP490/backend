import { describe, expect, it, vi } from 'vitest';
import { BusinessConfigService } from './business-config.service';

describe('business config cache (PO 14/10/2026: Supabase egress)', () => {
  const rows = [{ key: 'matching.gps_fresh_minutes', value: '15' }, { key: 'commission.rate_bps', value: '1000' }];

  it('refreshes with key and value only, and still answers from the cache', async () => {
    const find = vi.fn(async () => rows);
    const service = new BusinessConfigService({ find } as never);
    expect(await service.getInt('matching.gps_fresh_minutes', 0)).toBe(15);
    expect(await service.getInt('commission.rate_bps', 0)).toBe(1000);
    expect(await service.getInt('missing.key', 7)).toBe(7);
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ select: { key: true, value: true } });
  });

  it('reads again after an admin change invalidates the cache', async () => {
    const find = vi.fn(async () => rows);
    const service = new BusinessConfigService({ find } as never);
    await service.get('commission.rate_bps');
    service.invalidateCache();
    await service.get('commission.rate_bps');
    expect(find).toHaveBeenCalledTimes(2);
  });
});
