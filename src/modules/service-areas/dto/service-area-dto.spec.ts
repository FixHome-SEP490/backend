import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateServiceAreaDto } from './create-service-area.dto';
import { UpdateServiceAreaDto } from './update-service-area.dto';

const area = (over: Record<string, unknown> = {}) =>
  plainToInstance(CreateServiceAreaDto, { provinceCode: '01', provinceName: 'Thành phố Hà Nội', districtCode: '00004', districtName: 'Phường Ba Đình', ...over });

describe('Service area input (QA 22/11/2026)', () => {
  it('accepts a real administrative unit', async () => {
    expect(await validate(area())).toEqual([]);
    expect(await validate(plainToInstance(UpdateServiceAreaDto, { districtName: 'Phường Sài Gòn' }))).toEqual([]);
  });

  it('refuses non-numeric codes, emoji, markup and over-long names', async () => {
    for (const over of [
      { districtCode: 'abc' },
      { districtCode: '<b>9</b>' },
      { provinceCode: '01a' },
      { districtName: '😀😀' },
      { districtName: '<script>x</script>' },
      { districtName: 'A'.repeat(101) },
      { provinceName: '😀' },
    ]) {
      expect((await validate(area(over))).length, JSON.stringify(over)).toBeGreaterThan(0);
    }
  });
});
