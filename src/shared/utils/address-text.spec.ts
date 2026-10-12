import { describe, expect, it } from 'vitest';
import { composeAddressText, tidyAddressText } from './address-text';

describe('address text (PO 12/10/2026: order screens repeated the ward and showed the postcode and country)', () => {
  it('turns the line saved from the map search into one clean line', () => {
    expect(
      composeAddressText(['Đường Vành Đai KTX Khu B, 700000 Phường Đông Hòa, Việt Nam', 'Phường Đông Hòa', 'Phường Đông Hòa', 'TP. Hồ Chí Minh']),
    ).toBe('Đường Vành Đai KTX Khu B, Phường Đông Hòa, TP. Hồ Chí Minh');
  });

  it('tidies a snapshot already saved the old way when it is read', () => {
    expect(tidyAddressText('Đường Vành Đai KTX Khu B, 700000 Phường Đông Hòa, Việt Nam, Phường Đông Hòa, Phường Đông Hòa, TP. Hồ Chí Minh'))
      .toBe('Đường Vành Đai KTX Khu B, Phường Đông Hòa, TP. Hồ Chí Minh');
  });

  it('leaves a normal address exactly as it was', () => {
    const text = '101 Lê Thánh Tôn, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh';
    expect(composeAddressText(['101 Lê Thánh Tôn', 'Phường Bến Thành', 'Quận 1', 'TP. Hồ Chí Minh'])).toBe(text);
    expect(tidyAddressText(text)).toBe(text);
  });

  it('treats TP. and Thành phố, accents and case as the same name, keeping the first spelling', () => {
    expect(tidyAddressText('12 Lê Lợi, Bến Nghé, Thành phố Hồ Chí Minh, TP. Hồ Chí Minh, Viet Nam'))
      .toBe('12 Lê Lợi, Bến Nghé, Thành phố Hồ Chí Minh');
    expect(tidyAddressText('Phường Đông Hòa, phuong dong hoa')).toBe('Phường Đông Hòa');
  });

  it('keeps different places that only share a number', () => {
    expect(tidyAddressText('5 Nguyễn Trãi, Phường 1, Quận 1, TP. Hồ Chí Minh')).toBe('5 Nguyễn Trãi, Phường 1, Quận 1, TP. Hồ Chí Minh');
  });

  it('keeps short house numbers and drops only six-digit postcodes', () => {
    expect(tidyAddressText('12345 Đường Số 7, 700000, Bình Tân')).toBe('12345 Đường Số 7, Bình Tân');
    expect(tidyAddressText('Hẻm 182, Thanh Xuân 100000, Hà Nội')).toBe('Hẻm 182, Thanh Xuân, Hà Nội');
  });

  it('copes with empty parts and nothing at all', () => {
    expect(composeAddressText(['  ', null, undefined, 'Quận 3'])).toBe('Quận 3');
    expect(tidyAddressText(null)).toBe('');
    expect(tidyAddressText(' , ,')).toBe('');
  });
});
