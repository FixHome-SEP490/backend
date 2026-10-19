import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { deriveCatalogV2VariantResolution, validateCatalogV2DeviceAttributesForBooking } from '../../src/database/catalog-v2/catalog-v2-device-attributes';
import { previewCatalogV2Labor } from '../../src/database/catalog-v2/catalog-v2-price-preview';
import { BusinessException } from '../../src/common/exceptions/business.exception';
import { CreateBookingDto } from '../../src/modules/bookings/booking.dto';
import { BookingsService } from '../../src/modules/bookings/bookings.service';
import { Booking } from '../../src/modules/bookings/entities/booking.entity';
import { ServicePricingMode } from '../../src/shared/enums';

const customerId = '11111111-1111-4111-8111-111111111111';
const serviceId = '22222222-2222-4222-8222-222222222222';
const addressId = '33333333-3333-4333-8333-333333333333';

function bookingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serviceId,
    addressId,
    description: 'Thiết bị cần kiểm tra',
    mode: 'scheduled',
    date: '2030-10-21',
    slot: 'morning',
    ...overrides,
  };
}

async function validationErrors(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateBookingDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function createBookingsService(serviceCode: string) {
  const bookingRepository = {
    create: vi.fn((values: Record<string, unknown>) => values),
    save: vi.fn(async (booking: Record<string, unknown>) => ({ id: 'saved-booking-id', ...booking })),
  };
  const mediaRepository = {
    create: vi.fn((values: Record<string, unknown>) => values),
    save: vi.fn(async (media: Record<string, unknown>[]) => media),
  };
  const address = {
    id: addressId,
    userId: customerId,
    province: 'Hồ Chí Minh',
    district: 'Quận 1',
    ward: 'Phường Bến Nghé',
    line1: '10 Nguyễn Huệ',
    provinceCode: '79',
    districtCode: '760',
    lat: 10.776,
    lng: 106.7,
  };
  const serviceRecord = {
    id: serviceId,
    code: serviceCode,
    name: 'Dịch vụ thử',
    description: 'Phạm vi dịch vụ cũ',
    scopeDescription: 'Phạm vi đã chốt',
    isActive: true,
    pricingMode: ServicePricingMode.FIXED_PRICE,
    fixedPrice: 175000,
  };
  const transaction = vi.fn(async (callback: (manager: unknown) => Promise<unknown>) => callback({
    getRepository: (entity: unknown) => entity === Booking ? bookingRepository : mediaRepository,
  }));
  const service = Object.create(BookingsService.prototype) as BookingsService;
  Object.assign(service as unknown as Record<string, unknown>, {
    userRepo: { findOneBy: vi.fn(async () => ({ id: customerId, bookingSuspendedUntil: null })) },
    serviceRepo: { findOneBy: vi.fn(async () => serviceRecord) },
    addressRepo: { findOneBy: vi.fn(async () => address) },
    dataSource: { transaction, query: vi.fn() },
    auditLogService: { log: vi.fn(async () => undefined) },
    privateBookingPhotoClaimService: { claim: vi.fn() },
    configService: { getInt: vi.fn() },
  });

  return { service, transaction, bookingRepository };
}

describe('optional Booking device attributes', () => {
  it('accepts only the bounded optional AC and washer facts, including unknown answers', async () => {
    const acErrors = await validationErrors(bookingPayload({
      deviceAttributes: { acMounting: 'unknown', acHorsepower: 'unknown', brand: ' Carrier ' },
    }));
    const washerErrors = await validationErrors(bookingPayload({
      deviceAttributes: { washerLoadingStyle: 'top', washerCapacityKg: 8.5, brand: 'LG' },
    }));
    const legacyErrors = await validationErrors(bookingPayload());

    expect(acErrors).toEqual([]);
    expect(washerErrors).toEqual([]);
    expect(legacyErrors).toEqual([]);
    const ac = plainToInstance(CreateBookingDto, bookingPayload({
      deviceAttributes: { acMounting: 'unknown', acHorsepower: 'unknown', brand: ' Carrier ' },
    }));
    expect(ac.deviceAttributes?.brand).toBe('Carrier');
  });

  it('rejects client prices, variants, generic device types, and arbitrary nested JSON keys', async () => {
    const errors = await validationErrors(bookingPayload({
      deviceAttributes: {
        acMounting: 'wall',
        acHorsepower: 'up_to_1_5',
        variantCode: 'AC-02-01',
        laborPriceVnd: 1,
        deviceType: 'air_conditioner',
      },
    }));
    const rootPriceErrors = await validationErrors(bookingPayload({ fixedPrice: 1 }));

    expect(errors).not.toEqual([]);
    expect(rootPriceErrors).not.toEqual([]);
  });

  it('rejects malformed values and out-of-range attributes', async () => {
    const badHorsepower = await validationErrors(bookingPayload({
      deviceAttributes: { acHorsepower: '1.5' },
    }));
    const badCapacity = await validationErrors(bookingPayload({
      deviceAttributes: { washerLoadingStyle: 'front', washerCapacityKg: 50.1 },
    }));
    const longBrand = await validationErrors(bookingPayload({
      deviceAttributes: { brand: 'x'.repeat(65) },
    }));
    const nestedArray = await validationErrors(bookingPayload({ deviceAttributes: [] }));

    expect(badHorsepower).not.toEqual([]);
    expect(badCapacity).not.toEqual([]);
    expect(longBrand).not.toEqual([]);
    expect(nestedArray).not.toEqual([]);
  });

  it('rejects enum arrays instead of coercing them to strings', () => {
    const invalidValues = [
      ['VE_SINH_DIEU_HOA_1HP', { acMounting: ['ceiling'] }],
      ['VE_SINH_DIEU_HOA_1HP', { acHorsepower: ['up_to_1_5'] }],
      ['VE_SINH_MAY_GIAT_CUA_TREN_LE9', { washerLoadingStyle: ['top'] }],
    ] as const;

    for (const [serviceCode, attributes] of invalidValues) {
      expect(validateCatalogV2DeviceAttributesForBooking(serviceCode, attributes)).toEqual({
        status: 'INVALID_ATTRIBUTES',
      });
    }
  });

  it('keeps AC HP alone ambiguous while ceiling or wall plus HP resolves one approved variant', () => {
    expect(deriveCatalogV2VariantResolution('AC-02', { acHorsepower: 'up_to_1_5' })).toMatchObject({
      status: 'AMBIGUOUS',
      missingAttributes: ['acMounting'],
      availableVariants: [{ variantCode: 'AC-02-01' }, { variantCode: 'AC-02-03' }],
    });
    expect(deriveCatalogV2VariantResolution('AC-02', { acMounting: 'wall' })).toMatchObject({
      status: 'AMBIGUOUS',
      missingAttributes: ['acHorsepower'],
    });
    expect(deriveCatalogV2VariantResolution('AC-02', {
      acMounting: 'wall', acHorsepower: 'up_to_1_5',
    })).toMatchObject({ status: 'RESOLVED', variantCode: 'AC-02-01' });
    expect(deriveCatalogV2VariantResolution('AC-02', {
      acMounting: 'ceiling', acHorsepower: 'unknown',
    })).toMatchObject({ status: 'RESOLVED', variantCode: 'AC-02-03' });
  });

  it('keeps washer loading style alone ambiguous until capacity is known', () => {
    expect(deriveCatalogV2VariantResolution('WM-02', { washerLoadingStyle: 'top' })).toMatchObject({
      status: 'AMBIGUOUS',
      missingAttributes: ['washerCapacityKg'],
      availableVariants: [{ variantCode: 'WM-02-05' }, { variantCode: 'WM-02-06' }],
    });
    expect(deriveCatalogV2VariantResolution('WM-02', { washerCapacityKg: 10 })).toMatchObject({
      status: 'AMBIGUOUS',
      missingAttributes: ['washerLoadingStyle'],
      availableVariants: [{ variantCode: 'WM-02-06' }, { variantCode: 'WM-02-08' }],
    });
    expect(deriveCatalogV2VariantResolution('WM-02', {
      washerLoadingStyle: 'front', washerCapacityKg: 9,
    })).toMatchObject({ status: 'RESOLVED', variantCode: 'WM-02-07' });
  });

  it('leaves all-unknown and non-target service variants unresolved', () => {
    expect(deriveCatalogV2VariantResolution('AC-02', {
      acMounting: 'unknown', acHorsepower: 'unknown',
    })).toMatchObject({ status: 'MISSING_ATTRIBUTES', availableVariants: [
      { variantCode: 'AC-02-01' }, { variantCode: 'AC-02-02' }, { variantCode: 'AC-02-03' },
    ] });
    expect(deriveCatalogV2VariantResolution('WM-02', {
      washerLoadingStyle: 'unknown', washerCapacityKg: null,
    })).toMatchObject({ status: 'MISSING_ATTRIBUTES' });
    expect(deriveCatalogV2VariantResolution('AC-03', null)).toMatchObject({
      status: 'MISSING_ATTRIBUTES',
      missingAttributes: ['service-specific-scope-confirmation'],
    });
  });

  it('derives nonbinding exact previews only from complete attributes', () => {
    const previews = [
      previewCatalogV2Labor('AC-02', { acMounting: 'wall', acHorsepower: 'up_to_1_5' }),
      previewCatalogV2Labor('AC-02', { acMounting: 'wall', acHorsepower: '2_to_2_5' }),
      previewCatalogV2Labor('AC-02', { acMounting: 'ceiling' }),
      previewCatalogV2Labor('WM-02', { washerLoadingStyle: 'top', washerCapacityKg: 9 }),
      previewCatalogV2Labor('WM-02', { washerLoadingStyle: 'top', washerCapacityKg: 9.1 }),
      previewCatalogV2Labor('WM-02', { washerLoadingStyle: 'front', washerCapacityKg: 9 }),
      previewCatalogV2Labor('WM-02', { washerLoadingStyle: 'front', washerCapacityKg: 9.1 }),
    ];

    expect(previews.map((preview) => [preview.status, 'variantCode' in preview ? preview.variantCode : null,
      'laborPriceVnd' in preview ? preview.laborPriceVnd : null])).toEqual([
      ['FIXED_TIER_PREVIEW', 'AC-02-01', 199000],
      ['FIXED_TIER_PREVIEW', 'AC-02-02', 219000],
      ['FIXED_TIER_PREVIEW', 'AC-02-03', 449000],
      ['FIXED_TIER_PREVIEW', 'WM-02-05', 399000],
      ['FIXED_TIER_PREVIEW', 'WM-02-06', 449000],
      ['FIXED_TIER_PREVIEW', 'WM-02-07', 599000],
      ['FIXED_TIER_PREVIEW', 'WM-02-08', 699000],
    ]);
    for (const preview of previews) expect(preview).toMatchObject({ bookable: false, priceBinding: false });
  });

  it('does not expose a price for incomplete, mismatched, injected, or unknown facts', () => {
    const previews = [
      previewCatalogV2Labor('AC-02', { acHorsepower: '2_to_2_5' }),
      previewCatalogV2Labor('WM-02', { washerLoadingStyle: 'front' }),
      previewCatalogV2Labor('WM-02', { acMounting: 'wall' }),
      previewCatalogV2Labor('AC-02', { variantCode: 'AC-02-01' }),
      previewCatalogV2Labor('AC-02', { laborPriceVnd: 199000 }),
      previewCatalogV2Labor('unknown-service', null),
    ];

    expect(previews.map((preview) => preview.status)).toEqual([
      'AMBIGUOUS_VARIANT',
      'AMBIGUOUS_VARIANT',
      'INVALID_DEVICE_ATTRIBUTES',
      'INVALID_DEVICE_ATTRIBUTES',
      'INVALID_DEVICE_ATTRIBUTES',
      'UNKNOWN_SERVICE',
    ]);
    for (const preview of previews) {
      expect(preview).toMatchObject({ bookable: false });
      expect(preview).not.toHaveProperty('laborPriceVnd');
    }
  });

  it('validates attribute keys against the selected service family', () => {
    expect(validateCatalogV2DeviceAttributesForBooking('VE_SINH_DIEU_HOA_1HP', {
      acHorsepower: 'up_to_1_5',
    })).toMatchObject({ status: 'VALID' });
    expect(validateCatalogV2DeviceAttributesForBooking('SUA_MAY_GIAT', {
      washerLoadingStyle: 'top',
    })).toMatchObject({ status: 'VALID' });
    expect(validateCatalogV2DeviceAttributesForBooking('WM-02', {
      acMounting: 'wall',
    })).toMatchObject({ status: 'SERVICE_MISMATCH' });
    expect(validateCatalogV2DeviceAttributesForBooking('SOME_OTHER_SERVICE', {
      brand: 'Samsung',
    })).toMatchObject({ status: 'SERVICE_MISMATCH' });
  });

  it('accepts washer facts for washer installation and rejects facts from other families', () => {
    expect(validateCatalogV2DeviceAttributesForBooking('WM-03', {
      washerLoadingStyle: 'front', washerCapacityKg: 12, brand: 'LG',
    })).toEqual({
      status: 'VALID',
      snapshot: { washerLoadingStyle: 'front', washerCapacityKg: 12, brand: 'LG' },
    });
    expect(validateCatalogV2DeviceAttributesForBooking('WM-03', {
      acMounting: 'wall',
    })).toMatchObject({ status: 'SERVICE_MISMATCH' });
    expect(validateCatalogV2DeviceAttributesForBooking('WM-03', {
      dryerFuelType: 'gas',
    })).toMatchObject({ status: 'INVALID_ATTRIBUTES' });
  });

  it('stores the validated snapshot without changing legacy fixed-price booking cost', async () => {
    const { service, bookingRepository } = createBookingsService('VE_SINH_DIEU_HOA_1HP');
    const dto = plainToInstance(CreateBookingDto, bookingPayload({
      deviceAttributes: { acMounting: 'wall', acHorsepower: 'unknown', brand: '  Daikin  ' },
    }));

    const booking = await service.create(dto, { id: customerId, role: 'customer' });
    const saved = booking as unknown as { deviceAttributesSnapshot: unknown; fixedUnitPriceSnapshot: number };

    expect(saved.deviceAttributesSnapshot).toEqual({
      acMounting: 'wall', acHorsepower: 'unknown', brand: 'Daikin',
    });
    expect(saved.fixedUnitPriceSnapshot).toBe(175000);
    expect(bookingRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      fixedUnitPriceSnapshot: 175000,
      deviceAttributesSnapshot: saved.deviceAttributesSnapshot,
    }));
  });

  it('keeps a legacy booking with omitted attributes and rejects facts for another service', async () => {
    const legacy = createBookingsService('LEGACY_SERVICE');
    const booking = await legacy.service.create(
      plainToInstance(CreateBookingDto, bookingPayload()),
      { id: customerId, role: 'customer' },
    );
    const legacySnapshot = booking as unknown as { deviceAttributesSnapshot: unknown; fixedUnitPriceSnapshot: number };
    expect(legacySnapshot.deviceAttributesSnapshot).toBeNull();
    expect(legacySnapshot.fixedUnitPriceSnapshot).toBe(175000);

    const mismatched = createBookingsService('WM-02');
    await expect(mismatched.service.create(
      plainToInstance(CreateBookingDto, bookingPayload({
        deviceAttributes: { acMounting: 'wall', acHorsepower: 'up_to_1_5' },
      })),
      { id: customerId, role: 'customer' },
    )).rejects.toBeInstanceOf(BusinessException);
    expect(mismatched.transaction).not.toHaveBeenCalled();
  });

  it('rejects known facts that contradict a legacy fixed-price service before opening a transaction', async () => {
    const contradictoryFacts = [
      ['VE_SINH_DIEU_HOA_1HP', { acMounting: 'ceiling', acHorsepower: '2_to_2_5' }],
      ['VE_SINH_DIEU_HOA_1HP', { acMounting: 'ceiling' }],
      ['VE_SINH_DIEU_HOA_1HP', { acHorsepower: '2_to_2_5' }],
      ['VE_SINH_DIEU_HOA_2HP', { acHorsepower: 'up_to_1_5' }],
      ['VE_SINH_DIEU_HOA_AM_TRAN', { acMounting: 'wall' }],
      ['VE_SINH_MAY_GIAT_CUA_TREN_LE9', { washerLoadingStyle: 'front', washerCapacityKg: 12 }],
      ['VE_SINH_MAY_GIAT_CUA_TREN_LE9', { washerLoadingStyle: 'front' }],
      ['VE_SINH_MAY_GIAT_CUA_TREN_LE9', { washerCapacityKg: 12 }],
      ['VE_SINH_MAY_GIAT_CUA_TREN_GT9', { washerCapacityKg: 8 }],
      ['VE_SINH_MAY_GIAT_CUA_NGANG_LE9', { washerLoadingStyle: 'top' }],
      ['VE_SINH_MAY_GIAT_CUA_NGANG_GT9', { washerCapacityKg: 9 }],
    ] as const;

    for (const [serviceCode, deviceAttributes] of contradictoryFacts) {
      const { service, transaction } = createBookingsService(serviceCode);
      await expect(service.create(
        plainToInstance(CreateBookingDto, bookingPayload({ deviceAttributes })),
        { id: customerId, role: 'customer' },
      )).rejects.toBeInstanceOf(BusinessException);
      expect(transaction).not.toHaveBeenCalled();
    }
  });

  it('keeps unknown legacy facts and the stored fixed price unchanged', async () => {
    const omitted = createBookingsService('VE_SINH_DIEU_HOA_1HP');
    const legacyBooking = await omitted.service.create(
      plainToInstance(CreateBookingDto, bookingPayload()),
      { id: customerId, role: 'customer' },
    );
    expect(legacyBooking).toMatchObject({
      deviceAttributesSnapshot: null,
      fixedUnitPriceSnapshot: 175000,
    });

    const { service } = createBookingsService('VE_SINH_DIEU_HOA_1HP');
    const booking = await service.create(
      plainToInstance(CreateBookingDto, bookingPayload({
        deviceAttributes: { acMounting: 'unknown', acHorsepower: 'unknown' },
      })),
      { id: customerId, role: 'customer' },
    );

    expect(booking).toMatchObject({
      deviceAttributesSnapshot: { acMounting: 'unknown', acHorsepower: 'unknown' },
      fixedUnitPriceSnapshot: 175000,
    });
  });
});
