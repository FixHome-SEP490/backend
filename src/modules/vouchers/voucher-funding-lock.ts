import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { VoucherCampaign, VoucherReservation } from './entities/voucher.entity';

/** All funded paths acquire campaign before reservation to match Apply/sweep. */
export async function lockVoucherFundingReservation(
  manager: EntityManager, reservationId: string,
): Promise<VoucherReservation> {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new ConflictException('Quyết toán ưu đãi cần giao dịch cơ sở dữ liệu.');
  }
  const reference = await manager.findOne(VoucherReservation, { where: { id: reservationId } });
  if (!reference?.campaignId) {
    throw new ConflictException('Không tìm thấy lượt giữ ưu đãi.');
  }
  const campaign = await manager.findOne(VoucherCampaign, {
    where: { id: reference.campaignId }, lock: { mode: 'pessimistic_write' },
  });
  if (!campaign || campaign.id !== reference.campaignId) {
    throw new ConflictException('Chương trình ưu đãi không nhất quán.');
  }
  const reservation = await manager.findOne(VoucherReservation, {
    where: { id: reservationId }, lock: { mode: 'pessimistic_write' },
  });
  if (!reservation || reservation.campaignId !== campaign.id) {
    throw new ConflictException('Lượt giữ ưu đãi đã thay đổi.');
  }
  return reservation;
}
