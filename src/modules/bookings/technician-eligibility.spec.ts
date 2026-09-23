import { describe, it, expect } from 'vitest';
import { resolveServiceArea } from '../../shared/utils/administrative-areas';
import { UUID_REGEX } from './booking.dto';

describe('Service Area Resolution & Shortlist Integrity', () => {
  it('resolves HCMC ward names (post-2025 reform, no district layer) to standard codes', () => {
    const res = resolveServiceArea({
      province: 'TP. Hồ Chí Minh',
      district: 'Phường Bến Thành',
    });

    expect(res.provinceCode).toBe('79');
    expect(res.districtCode).toBe('26743');
    expect(res.provinceName).toBe('Thành phố Hồ Chí Minh');
    expect(res.districtName).toBe('Phường Bến Thành');
    expect(res.districtAliasCodes).toContain('26743');
  });

  it('is diacritic/spelling tolerant (dataset "Hoà" vs geocoder "Hòa")', () => {
    const res = resolveServiceArea({
      province: 'Thành phố Hồ Chí Minh',
      district: 'Phường Đông Hòa',
    });

    expect(res.provinceCode).toBe('79');
    expect(res.districtCode).toBe('25951');
    expect(res.districtName).toBe('Phường Đông Hoà');
  });

  it('resolves Hanoi Ba Dinh ward correctly', () => {
    const res = resolveServiceArea({
      province: 'Hà Nội',
      district: 'Phường Ba Đình',
    });

    expect(res.provinceCode).toBe('01');
    expect(res.districtCode).toBe('00004');
    expect(res.districtName).toBe('Phường Ba Đình');
  });

  it('handles code-first inputs without mangling', () => {
    const res = resolveServiceArea({
      provinceCode: '79',
      districtCode: '26743',
    });

    expect(res.provinceCode).toBe('79');
    expect(res.districtCode).toBe('26743');
    expect(res.districtName).toBe('Phường Bến Thành');
  });

  it('preserves unmapped/custom province and district codes', () => {
    const res = resolveServiceArea({
      province: 'P1',
      district: 'D1',
    });

    expect(res.provinceCode).toBe('P1');
    expect(res.districtCode).toBe('D1');
    expect(res.provinceName).toBe('P1');
    expect(res.districtName).toBe('D1');
    expect(res.districtAliasCodes).toEqual(['D1']);
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
