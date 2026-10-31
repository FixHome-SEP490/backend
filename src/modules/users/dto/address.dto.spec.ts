import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateAddressDto, UpdateAddressDto } from './address.dto';

type AddressDtoClass = typeof CreateAddressDto | typeof UpdateAddressDto;

const createAddress: AddressDtoClass = CreateAddressDto;
const updateAddress: AddressDtoClass = UpdateAddressDto;

const createPipe = () => new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: false },
});

const baseCreate = {
  line1: '12 Đường Lê Lợi',
  district: 'Quận 1',
  province: 'Thành phố Hồ Chí Minh',
};

async function expectBadRequest(dto: AddressDtoClass, value: unknown): Promise<void> {
  let error: unknown;
  try {
    await createPipe().transform(value, { type: 'body', metatype: dto });
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(BadRequestException);
  expect((error as BadRequestException).getStatus()).toBe(400);
}

describe('address DTO validation', () => {
  it('allows a draft address with both coordinates omitted on create and update', async () => {
    await expect(createPipe().transform(baseCreate, {
      type: 'body',
      metatype: createAddress,
    })).resolves.toMatchObject(baseCreate);

    await expect(createPipe().transform({ line1: '12 Đường Lê Lợi' }, {
      type: 'body',
      metatype: updateAddress,
    })).resolves.toMatchObject({ line1: '12 Đường Lê Lợi' });
  });

  it.each([
    ['create with latitude only', createAddress, { ...baseCreate, lat: 10.7769 }],
    ['create with longitude only', createAddress, { ...baseCreate, lng: 106.7009 }],
    ['update with latitude only', updateAddress, { lat: 10.7769 }],
    ['update with longitude only', updateAddress, { lng: 106.7009 }],
    ['create with latitude and null longitude', createAddress, { ...baseCreate, lat: 10.7769, lng: null }],
    ['update with longitude and null latitude', updateAddress, { lat: null, lng: 106.7009 }],
  ])('rejects %s with HTTP 400', async (_name, dto, value) => {
    await expectBadRequest(dto, value);
  });

  it.each([
    ['create with null coordinates', createAddress, { ...baseCreate, lat: null, lng: null }],
    ['create with null latitude and omitted longitude', createAddress, { ...baseCreate, lat: null }],
    ['update with null coordinates', updateAddress, { lat: null, lng: null }],
    ['update with omitted latitude and null longitude', updateAddress, { lng: null }],
  ])('allows %s as missing coordinates', async (_name, dto, value) => {
    await expect(createPipe().transform(value, {
      type: 'body',
      metatype: dto,
    })).resolves.toMatchObject(value);
  });

  it.each([
    ['create latitude below range', createAddress, { ...baseCreate, lat: -90.0001, lng: 0 }],
    ['create latitude above range', createAddress, { ...baseCreate, lat: 90.0001, lng: 0 }],
    ['create longitude below range', createAddress, { ...baseCreate, lat: 0, lng: -180.0001 }],
    ['create longitude above range', createAddress, { ...baseCreate, lat: 0, lng: 180.0001 }],
    ['update latitude below range', updateAddress, { lat: -90.0001, lng: 0 }],
    ['update latitude above range', updateAddress, { lat: 90.0001, lng: 0 }],
    ['update longitude below range', updateAddress, { lat: 0, lng: -180.0001 }],
    ['update longitude above range', updateAddress, { lat: 0, lng: 180.0001 }],
  ])('rejects %s with HTTP 400', async (_name, dto, value) => {
    await expectBadRequest(dto, value);
  });

  it.each([
    ['NaN latitude', { lat: Number.NaN, lng: 0 }],
    ['infinite longitude', { lat: 0, lng: Number.POSITIVE_INFINITY }],
    ['string latitude', { lat: '10.7769', lng: 106.7009 }],
  ])('rejects %s on create and update with HTTP 400', async (_name, coordinates) => {
    await expectBadRequest(createAddress, { ...baseCreate, ...coordinates });
    await expectBadRequest(updateAddress, coordinates);
  });

  it.each([
    ['create NUL in line1', createAddress, { ...baseCreate, line1: '12\u0000 Đường Lê Lợi' }],
    ['create C0 control in ward', createAddress, { ...baseCreate, ward: 'Phường A\u001f' }],
    ['update NUL in line1', updateAddress, { line1: '12\u0000 Đường Lê Lợi' }],
    ['update C1 control in label', updateAddress, { label: 'Nhà\u0085 riêng' }],
  ])('rejects %s with HTTP 400', async (_name, dto, value) => {
    await expectBadRequest(dto, value);
  });

  it('preserves Vietnamese, emoji, zero-width joiner sequences, and HTML-like text', async () => {
    const line1 = "Căn hộ 🏠, Đường Lê Lợi 👩‍👩‍👧‍👦 <script>alert('x')</script>";
    const transformed = await createPipe().transform({ ...baseCreate, line1 }, {
      type: 'body',
      metatype: createAddress,
    });

    expect(transformed.line1).toBe(line1);
  });
});
