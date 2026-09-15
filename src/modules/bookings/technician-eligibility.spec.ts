import { describe, it, expect } from 'vitest';
import { resolveServiceArea } from '../../shared/utils/administrative-areas';
import { UUID_REGEX } from './booking.dto';

describe('Service Area Resolution & Shortlist Integrity', () => {
  it('resolves HCMC District 1 names to standard codes 79 and 760 with legacy aliases', () => {
    const res = resolveServiceArea({
      province: 'TP. Hồ Chí Minh',
      district: 'Quận 1',
    });

    expect(res.provinceCode).toBe('79');
    expect(res.districtCode).toBe('760');
    expect(res.provinceName).toBe('TP. Hồ Chí Minh');
    expect(res.districtName).toBe('Quận 1');
    expect(res.districtAliasCodes).toContain('760');
    expect(res.districtAliasCodes).toContain('7901');
    expect(res.districtAliasCodes).toContain('q1');
  });

  it('resolves Hanoi Ba Dinh district correctly', () => {
    const res = resolveServiceArea({
      province: 'Hà Nội',
      district: 'Quận Ba Đình',
    });

    expect(res.provinceCode).toBe('01');
    expect(res.districtCode).toBe('001');
    expect(res.districtName).toBe('Quận Ba Đình');
  });

  it('handles code-first inputs without mangling', () => {
    const res = resolveServiceArea({
      provinceCode: '79',
      districtCode: '760',
    });

    expect(res.provinceCode).toBe('79');
    expect(res.districtCode).toBe('760');
    expect(res.districtName).toBe('Quận 1');
  });

  it('validates both standard RFC UUIDs and PostgreSQL 128-bit hex UUIDs in ShortlistDto', () => {
    const standardV4 = 'a1785327-83bc-4104-9616-649fabe86adc';
    const demoSeedUuid = 'c1000000-0000-0000-0000-000000000001';
    const invalidUuid = 'not-a-uuid-12345';

    expect(UUID_REGEX.test(standardV4)).toBe(true);
    expect(UUID_REGEX.test(demoSeedUuid)).toBe(true);
    expect(UUID_REGEX.test(invalidUuid)).toBe(false);
  });
});
