import type { DataSource, EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';

/** Read-only runtime prerequisite. Never runs migrations or changes DB permissions. */
export async function assertVoucherFundingSchemaReady(database: Pick<DataSource | EntityManager, 'query'>): Promise<void> {
  const unavailable = (): never => {
    throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE,
      'Thanh toán ưu đãi chưa sẵn sàng, vui lòng thử lại sau.');
  };
  try {
    const schema = await database.query(`SELECT
      to_regclass('public.migrations') IS NOT NULL
      AND to_regclass('public.voucher_payment_links') IS NOT NULL
      AND to_regclass('public.voucher_funding_entries') IS NOT NULL
      AS ready`);
    if (schema?.length !== 1 || schema[0]?.ready !== true) unavailable();
    const release = await database.query(`SELECT
      EXISTS (SELECT 1 FROM public.migrations WHERE name = $1 AND timestamp = $2)
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'support_cases'
          AND column_name = 'voucher_gross_refund_vnd' AND data_type = 'bigint')
      AND NOT row_security_active('public.voucher_payment_links')
      AND NOT row_security_active('public.voucher_funding_entries')
      AND has_table_privilege(current_user, 'public.voucher_payment_links', 'SELECT')
      AND has_table_privilege(current_user, 'public.voucher_payment_links', 'INSERT')
      AND has_table_privilege(current_user, 'public.voucher_funding_entries', 'SELECT')
      AND has_table_privilege(current_user, 'public.voucher_funding_entries', 'INSERT')
      AS ready`, ['VoucherFundingLedger1792994400001', '1792994400001']);
    if (release?.length !== 1 || release[0]?.ready !== true) unavailable();
  } catch {
    unavailable();
  }
}
