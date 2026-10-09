import { describe, expect, it } from 'vitest';
import { foldVietnamese, phoneDigitsVariants } from './admin-technicians.service';

describe('admin technician look-up: phone numbers as typed (PO 08/10/2026)', () => {
  it('matches 0912... and +84 912... both ways', () => {
    expect(phoneDigitsVariants('0912 345 678')).toEqual(['0912345678', '84912345678']);
    expect(phoneDigitsVariants('+84 912 345 678')).toEqual(['84912345678', '0912345678']);
  });

  it('ignores searches with too few digits, such as a name', () => {
    expect(phoneDigitsVariants('Nguyễn Văn A')).toEqual([]);
    expect(phoneDigitsVariants('12')).toEqual([]);
    expect(phoneDigitsVariants('345')).toEqual(['345']);
  });
});

describe('admin technician look-up: names without marks', () => {
  it('folds Vietnamese letters so a plain search finds them', () => {
    expect(foldVietnamese('Nguyễn Thị Ánh Đường')).toBe('nguyen thi anh duong');
    expect(foldVietnamese('Thợ Điện Lạnh')).toBe('tho dien lanh');
    expect(foldVietnamese('tech1@fixhome.vn')).toBe('tech1@fixhome.vn');
  });
});
