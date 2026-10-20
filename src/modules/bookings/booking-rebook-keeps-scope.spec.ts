import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingStatus } from '../../shared/enums';
import type { RebookDto } from './booking.dto';

// PO 20/10/2026: đặt lại từ đơn giá cố định phải giữ đúng thiết bị và phạm vi đã chốt.
function setup(old: Record<string, unknown>, serviceActive = true) {
  const service = Object.create(BookingsService.prototype) as BookingsService;
  const created = { id: 'new' };
  Object.assign(service, {
    bookingRepo: { findOneBy: async () => ({ id: 'old', customerId: 'c', status: BookingStatus.CANCELLED, addressId: 'a', serviceId: 's', quantity: 1, description: 'Vệ sinh máy lạnh', ...old }) },
    serviceRepo: { findOneBy: async () => ({ id: 's', isActive: serviceActive }) },
    dataSource: { manager: { findOneBy: async () => null, find: async () => [] } },
  });
  const create = vi.spyOn(service, 'create').mockResolvedValue(created as never);
  return { service, create };
}
const dto = { mode: 'scheduled', date: '2030-10-15', slot: 'morning' } as RebookDto;
const ac = { acMounting: 'wall', acHorsepower: 'up_to_1_5' };

describe('rebook keeps the confirmed device facts and scope', () => {
  it('sends the old device attributes and selected variant to the new booking', async () => {
    const { service, create } = setup({ deviceAttributesSnapshot: ac, catalogV2PricingSnapshot: { selectedVariant: { variantCode: 'AC-02-01' } } });
    await service.rebook('old', { id: 'c', role: 'customer' }, dto);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ serviceId: 's', deviceAttributes: ac, selectedVariantCode: 'AC-02-01' });
  });

  it('still rebooks without a fixed price when the old scope no longer applies', async () => {
    const { service, create } = setup({ deviceAttributesSnapshot: ac, catalogV2PricingSnapshot: { selectedVariant: { variantCode: 'AC-02-01' } } });
    create.mockRejectedValueOnce(new BadRequestException('Phạm vi đã chọn không còn áp dụng'));
    await service.rebook('old', { id: 'c', role: 'customer' }, dto);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).toMatchObject({ deviceAttributes: ac });
    expect(create.mock.calls[1][0]).not.toHaveProperty('selectedVariantCode');
  });

  it('does not swallow other failures and says plainly when the service was retired', async () => {
    const failing = setup({ catalogV2PricingSnapshot: { selectedVariant: { variantCode: 'AC-02-01' } } });
    failing.create.mockRejectedValueOnce(new Error('Repair address coordinates are required'));
    await expect(failing.service.rebook('old', { id: 'c', role: 'customer' }, dto)).rejects.toThrow(/coordinates/);
    expect(failing.create).toHaveBeenCalledTimes(1);
    const retired = setup({}, false);
    await expect(retired.service.rebook('old', { id: 'c', role: 'customer' }, dto)).rejects.toThrow('Dịch vụ của đơn cũ đã ngừng, vui lòng đặt yêu cầu mới');
    expect(retired.create).not.toHaveBeenCalled();
  });
});
