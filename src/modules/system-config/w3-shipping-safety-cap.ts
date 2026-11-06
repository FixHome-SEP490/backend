import { EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { SystemConfig } from './entities/system-config.entity';

export const W3_SHIPPING_CAP_KEY = 'w3.shipping.max_new_fee_vnd';
export const W3_SHIPPING_CAP_MAX = 100_000_000;

export function parseW3ShippingCap(value: unknown, valueType: unknown): number | null {
  if (valueType !== 'int' || typeof value !== 'string' || !/^(0|[1-9]\d{0,8})$/.test(value)) return null;
  const cap = Number(value);
  return cap <= W3_SHIPPING_CAP_MAX ? cap : null;
}

/** New W3 quotes only. Never uses the process cache or changes a fee/old consent.
 * SHARE serializes admission with Admin UPDATE until the quote transaction commits.
 * Passing this upper bound does not confer any financial authority. */
export async function assertW3NewShippingFee(manager: EntityManager, fee: number): Promise<void> {
  if (fee === 0) return;
  const config = await manager.findOne(SystemConfig, {
    where: { key: W3_SHIPPING_CAP_KEY },
    lock: { mode: 'pessimistic_read' },
  });
  const cap = parseW3ShippingCap(config?.value, config?.valueType) ?? 0;
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > cap) {
    throw new BusinessException(ErrorCodes.CONFLICT,
      'Phí giao mới vượt giới hạn cho phép. Vui lòng liên hệ quản trị viên.',
      { blocker: 'W3_SHIPPING_CAP_EXCEEDED', maxNewFeeVnd: cap });
  }
}
