import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateAddressDto, UpdateAddressDto } from './address.dto';
import { ADDRESS_LOCATION_REQUIRED } from '../../../shared/validation/address.validators';

type AddressDtoClass = typeof CreateAddressDto | typeof UpdateAddressDto;

const createAddress: AddressDtoClass = CreateAddressDto;
const updateAddress: AddressDtoClass = UpdateAddressDto;

const createPipe = () => new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: false },
});

const pin = { lat: 10.7769, lng: 106.7009 };
const baseCreate = {
  label: 'Nhà riêng',
  line1: '12 Đường Lê Lợi',
  ward: 'Phường Bến Thành',
  district: 'Quận 1',
  province: 'Thành phố Hồ Chí Minh',
  ...pin,
};

const run = (dto: AddressDtoClass, value: unknown) =>
  createPipe().transform(value, { type: 'body', metatype: dto });

/** The messages the API sends back in error.details, which web and mobile show as is. */
async function rejection(dto: AddressDtoClass, value: unknown): Promise<string[]> {
  let error: unknown;
  try {
    await run(dto, value);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BadRequestException);
  expect((error as BadRequestException).getStatus()).toBe(400);
  return ((error as BadRequestException).getResponse() as { message: string[] }).message;
}

const TEXT_FIELDS = ['label', 'line1', 'ward', 'district', 'province'] as const;

describe('address DTO coordinates (PO 01/11/2026, bug 29)', () => {
  it('accepts a full address with both coordinates on create', async () => {
    await expect(run(createAddress, baseCreate)).resolves.toMatchObject(baseCreate);
  });

  it.each([
    ['both coordinates omitted', { lat: undefined, lng: undefined }],
    ['latitude only', { lng: undefined }],
    ['longitude only', { lat: undefined }],
    ['both coordinates null', { lat: null, lng: null }],
    ['latitude with null longitude', { lng: null }],
    ['null latitude with longitude', { lat: null }],
  ])('refuses a create with %s and one Vietnamese message', async (_name, change) => {
    const body: Record<string, unknown> = { ...baseCreate, ...change };
    for (const key of Object.keys(change)) if (body[key] === undefined) delete body[key];
    const messages = await rejection(createAddress, body);
    expect(messages).toEqual([ADDRESS_LOCATION_REQUIRED]);
  });

  it.each([
    ['latitude below range', { lat: -90.0001 }, 'Vĩ độ phải là số từ -90 đến 90.'],
    ['latitude above range', { lat: 90.0001 }, 'Vĩ độ phải là số từ -90 đến 90.'],
    ['longitude below range', { lng: -180.0001 }, 'Kinh độ phải là số từ -180 đến 180.'],
    ['longitude above range', { lng: 180.0001 }, 'Kinh độ phải là số từ -180 đến 180.'],
    ['NaN latitude', { lat: Number.NaN }, 'Vĩ độ phải là số từ -90 đến 90.'],
    ['infinite longitude', { lng: Number.POSITIVE_INFINITY }, 'Kinh độ phải là số từ -180 đến 180.'],
    ['string latitude', { lat: '10.7769' }, 'Vĩ độ phải là số từ -90 đến 90.'],
    ['boolean longitude', { lng: true }, 'Kinh độ phải là số từ -180 đến 180.'],
  ])('refuses %s on create and update', async (_name, change, message) => {
    expect(await rejection(createAddress, { ...baseCreate, ...change })).toEqual([message]);
    expect(await rejection(updateAddress, { ...pin, ...change })).toEqual([message]);
  });

  it('accepts the range edges', async () => {
    await expect(run(createAddress, { ...baseCreate, lat: -90, lng: 180 })).resolves.toBeDefined();
    await expect(run(createAddress, { ...baseCreate, lat: 90, lng: -180 })).resolves.toBeDefined();
  });

  it('lets a PATCH that only renames or sets the default skip the coordinates', async () => {
    await expect(run(updateAddress, { label: 'Công ty', isDefault: true })).resolves.toMatchObject({ label: 'Công ty' });
  });

  it.each([
    ['line1 without coordinates', { line1: '45 Nguyễn Huệ' }],
    ['ward without coordinates', { ward: 'Phường Sài Gòn' }],
    ['district without coordinates', { district: 'Quận 3' }],
    ['province without coordinates', { province: 'Hà Nội' }],
    ['area code without coordinates', { districtCode: '770' }],
    ['latitude only', { lat: 10.77 }],
    ['longitude only', { lng: 106.7 }],
    ['null coordinates', { lat: null, lng: null }],
    ['a rename with null longitude', { label: 'Nhà', lat: 10.77, lng: null }],
  ])('refuses a PATCH with %s', async (_name, value) => {
    expect(await rejection(updateAddress, value)).toEqual([ADDRESS_LOCATION_REQUIRED]);
  });

  it('accepts a PATCH that moves the address with both coordinates', async () => {
    await expect(run(updateAddress, { line1: '45 Nguyễn Huệ', ...pin })).resolves.toMatchObject({ line1: '45 Nguyễn Huệ' });
  });
});

describe('address DTO text (PO 01/11/2026, bug 29)', () => {
  const VALID = [
    '12 Tân Trào, Tân Phú, Quận 7',
    'Số 5 (cạnh chợ Bến Thành)',
    'Hẻm 12/3B Lê Văn Sỹ',
    'Lô B-12, Tầng 3, #05-02',
    'Chung cư Sunrise City, Block V.3',
    'Ngõ 1 Phố Huế, Phường Hàng Bài',
    'Đường Nguyễn Thị Minh Khai, Phường Đa Kao',
    'Khu phố 4, Phường Linh Trung, TP. Thủ Đức',
    'Thôn Ỷ Lan, Xã Ứng Hòa',
    'Nhà riêng',
    '123',
  ];

  it.each(VALID)('accepts the Vietnamese address text %s in every text field', async (text) => {
    for (const field of TEXT_FIELDS) {
      const value = field === 'line1' ? text : text.slice(0, 100);
      await expect(run(createAddress, { ...baseCreate, [field]: value })).resolves.toMatchObject({ [field]: value });
    }
  });

  it('stores decomposed Vietnamese in composed form', async () => {
    const decomposed = 'Đường Lê Lợi'.normalize('NFD');
    const out = await run(createAddress, { ...baseCreate, line1: decomposed });
    expect(out.line1).toBe('Đường Lê Lợi'.normalize('NFC'));
  });

  it('trims and collapses spaces, including no-break spaces', async () => {
    const out = await run(createAddress, { ...baseCreate, line1: '   12   Tân  Trào ,  Quận 7  ', label: '  Nhà   riêng ' });
    expect(out.line1).toBe('12 Tân Trào , Quận 7');
    expect(out.label).toBe('Nhà riêng');
  });

  it('keeps an empty optional label or ward as before', async () => {
    await expect(run(createAddress, { ...baseCreate, label: '   ', ward: '' })).resolves.toMatchObject({ label: '', ward: '' });
  });

  const REFUSED: Array<[string, string]> = [
    ['emoji house', 'Nhà 🏠'],
    ['emoji face', 'Nhà 😀'],
    ['emoji with skin tone', 'Nhà 👍🏽'],
    ['family ZWJ sequence', 'Nhà 👩‍👩‍👧‍👦'],
    ['flag', 'Nhà 🇻🇳'],
    ['keycap emoji', 'Nhà 1️⃣'],
    ['heart with variation selector', 'Nhà ❤️'],
    ['dingbat star', 'Nhà ★'],
    ['trademark sign', 'Nhà™'],
    ['zero width space', '12 Tân​Trào'],
    ['zero width non-joiner', '12 Tân‌Trào'],
    ['zero width joiner', '12 Tân‍Trào'],
    ['word joiner', '12 Tân⁠Trào'],
    ['leading BOM', '﻿12 Tân Trào'],
    ['inner BOM', '12 Tân﻿Trào'],
    ['left to right mark', '12 Tân‎Trào'],
    ['right to left mark', '12 Tân‏Trào'],
    ['right to left override', '12 Tân‮Trào'],
    ['right to left isolate', '12 Tân⁧Trào'],
    ['soft hyphen', '12 Tân­Trào'],
    ['Hangul filler', '12 TânㅤTrào'],
    ['NUL', '12\u0000 Tân Trào'],
    ['C0 control', '12 Tân Trào\u001F'],
    ['bell', '12 Tân\u0007Trào'],
    ['tab', '12\tTân Trào'],
    ['new line', '12 Tân\nTrào'],
    ['carriage return', '12 Tân\rTrào'],
    ['trailing new line', '12 Tân Trào\n'],
    ['DEL', '12 Tân\u007FTrào'],
    ['C1 control', '12 Tân\u0085Trào'],
    ['line separator', '12 Tân Trào'],
    ['lone surrogate', '12 Tân\uD83DTrào'],
    ['stacked combining marks', 'Tân Trà́̂̃o'],
    ['HTML img onerror', '<img src=x onerror=alert(1)>'],
    ['script tag', "<script>alert('x')</script>"],
    ['closing tag only', 'Nhà </b>'],
    ['angle brackets', 'Nhà > 12'],
    ['HTML entity', 'Nhà &lt;b&gt;'],
    ['braces', 'Nhà {12}'],
    ['quote and equals', 'a" onmouseover="x'],
    ['backtick template', 'Nhà `x`'],
    ['dollar and percent', '12 $% Tân Trào'],
    ['at sign', 'admin@fixhome.vn'],
    ['only punctuation', '.,/-'],
  ];

  it.each(REFUSED)('refuses %s in every text field with a Vietnamese message', async (_name, text) => {
    for (const field of TEXT_FIELDS) {
      const messages = await rejection(createAddress, { ...baseCreate, [field]: text });
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.join(' ')).toMatch(/chỉ được chứa chữ, số, khoảng trắng/);
      expect(messages.join(' ')).not.toMatch(/[<>]/);
      await rejection(updateAddress, { ...pin, [field]: text });
    }
  });

  it('names the field in the message', async () => {
    expect(await rejection(createAddress, { ...baseCreate, label: 'Nhà 🏠' })).toEqual([
      'Tên gợi nhớ chỉ được chứa chữ, số, khoảng trắng và các dấu , . / - ( ) #, không chứa emoji, thẻ HTML hay ký tự đặc biệt.',
    ]);
    expect((await rejection(createAddress, { ...baseCreate, line1: '12\u0000' }))[0]).toMatch(/^Địa chỉ cụ thể /);
  });

  it.each([
    ['label', 100, 'Tên gợi nhớ tối đa 100 ký tự.'],
    ['line1', 255, 'Địa chỉ cụ thể tối đa 255 ký tự.'],
    ['ward', 100, 'Phường, xã tối đa 100 ký tự.'],
    ['district', 100, 'Quận, huyện tối đa 100 ký tự.'],
    ['province', 100, 'Tỉnh, thành phố tối đa 100 ký tự.'],
  ])('refuses %s longer than %i characters, also a 2000 character payload', async (field, max, message) => {
    await expect(run(createAddress, { ...baseCreate, [field]: 'a'.repeat(max) })).resolves.toBeDefined();
    expect(await rejection(createAddress, { ...baseCreate, [field]: 'a'.repeat(max + 1) })).toEqual([message]);
    expect(await rejection(createAddress, { ...baseCreate, [field]: 'Nhà '.repeat(500) })).toEqual([message]);
  });

  it.each([
    ['missing line1', { line1: undefined }, 'Địa chỉ cụ thể không được để trống.'],
    ['blank line1', { line1: '    ' }, 'Địa chỉ cụ thể không được để trống.'],
    ['missing district', { district: undefined }, 'Quận, huyện không được để trống.'],
    ['missing province', { province: undefined }, 'Tỉnh, thành phố không được để trống.'],
  ])('refuses a create with %s', async (_name, change, message) => {
    const body: Record<string, unknown> = { ...baseCreate, ...change };
    for (const key of Object.keys(change)) if (body[key] === undefined) delete body[key];
    expect(await rejection(createAddress, body)).toEqual([message]);
  });

  it.each([
    ['null line1', { line1: null }],
    ['blank district', { district: ' ' }],
    ['null province', { province: null }],
  ])('refuses a PATCH that clears a required field with %s', async (_name, change) => {
    const messages = await rejection(updateAddress, { ...pin, ...change });
    expect(messages.join(' ')).toMatch(/không được để trống/);
  });

  it.each([
    ['province code with letters and digits', { provinceCode: '79' }, true],
    ['district code', { districtCode: '760' }, true],
    ['province code with HTML', { provinceCode: '<b>79</b>' }, false],
    ['district code with emoji', { districtCode: '760🏠' }, false],
    ['district code too long', { districtCode: '1'.repeat(21) }, false],
  ])('checks the area code: %s', async (_name, change, ok) => {
    if (ok) await expect(run(createAddress, { ...baseCreate, ...change })).resolves.toBeDefined();
    else await rejection(createAddress, { ...baseCreate, ...change });
  });
});
