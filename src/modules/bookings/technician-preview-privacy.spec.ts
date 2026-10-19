import { describe, expect, it } from 'vitest';
import { HIDDEN_EMAIL, HIDDEN_PHONE, maskContactDetails, toTechnicianBookingPreview } from './booking-privacy.dto';
import { toDistanceBand } from './technician-distance';
import type { Booking } from './entities/booking.entity';

// PO 18/10/2026: the technician judges the job before accepting, never how to reach the customer.
describe('pre-accept preview privacy', () => {
  it.each([
    ['Gọi 0909123456 trước khi tới', `Gọi ${HIDDEN_PHONE} trước khi tới`],
    ['sđt 090 912 3456 nhé', `sđt ${HIDDEN_PHONE} nhé`],
    ['số +84 909.123.456', `số ${HIDDEN_PHONE}`],
    ['zalo 84909123456', `zalo ${HIDDEN_PHONE}`],
    ['mail khach@example.vn giúp em', `mail ${HIDDEN_EMAIL} giúp em`],
  ])('hides contact details in "%s"', (text, expected) => {
    expect(maskContactDetails(text)).toBe(expected);
  });

  it.each([
    'Máy lạnh báo lỗi E4 từ năm 2025',
    'Giá 350000 đồng như AI báo',
    'Tủ lạnh Inverter 236 lít, 2 cửa',
    'Vòi rỉ 3 giọt mỗi phút ở tầng 12',
  ])('keeps an ordinary description as it is: "%s"', (text) => {
    expect(maskContactDetails(text)).toBe(text);
  });

  it('masks the description and the assistant summary of the preview, nothing else of the job', () => {
    const preview = toTechnicianBookingPreview({
      id: 'b1', description: 'Máy giặt rung, gọi 0912 345 678', quantity: 1, bookingMode: 'scheduled', slot: 'morning',
      aiSummary: {
        deviceName: 'Máy giặt', customerText: 'em là Lan 0987654321', suspectedFaults: ['Lệch tải'], suggestedActions: [],
        conclusion: 'Có thể lệch tải', priceMin: 150000, priceMax: 300000, requiresAssessment: false,
        recommendedServiceName: 'Sửa máy giặt', photoCount: 0, notes: ['Khách cho số 0987654321 để gọi'], recordedAt: '2026-10-18T00:00:00Z',
      },
    } as unknown as Booking, { distanceKm: 3.24 });
    expect(preview.description).toBe(`Máy giặt rung, gọi ${HIDDEN_PHONE}`);
    expect(preview.aiSummary).toMatchObject({ customerText: `em là Lan ${HIDDEN_PHONE}`, notes: [`Khách cho số ${HIDDEN_PHONE} để gọi`], priceMin: 150000, deviceName: 'Máy giặt' });
    expect(JSON.stringify(preview)).not.toMatch(/0912|0987/);
    expect(preview.distanceBand).toEqual({ minKm: 3, maxKm: 5 });
  });

  it.each([
    [0, { minKm: 0, maxKm: 1 }],
    [0.99, { minKm: 0, maxKm: 1 }],
    [1, { minKm: 1, maxKm: 3 }],
    [4.9, { minKm: 3, maxKm: 5 }],
    [9.99, { minKm: 5, maxKm: 10 }],
    [15, { minKm: 10, maxKm: 20 }],
    [39.9, { minKm: 20, maxKm: 40 }],
    [120, { minKm: 40, maxKm: null }],
  ])('puts %s km in a coarse band', (km, band) => {
    expect(toDistanceBand(km)).toEqual(band);
  });

  it('has no band without a distance', () => {
    expect(toDistanceBand(null)).toBeNull();
    expect(toDistanceBand(Number.NaN)).toBeNull();
    expect(toDistanceBand(-1)).toBeNull();
  });
});
