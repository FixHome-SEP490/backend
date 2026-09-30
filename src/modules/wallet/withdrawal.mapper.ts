import { WithdrawalStatus } from '../../shared/enums';
import { WithdrawalResponseDto } from './dto';
import { WithdrawalRequest } from './entities';

/**
 * One shape for a withdrawal on every endpoint, so the payout trail (bank
 * reference, failure reason, refund) reaches the technician's history and the
 * console alike instead of being added to one mapping and forgotten in another.
 */
export function toWithdrawalResponse(
  withdrawal: WithdrawalRequest,
): WithdrawalResponseDto {
  return {
    id: withdrawal.id,
    walletId: withdrawal.walletId,
    technicianId: withdrawal.technicianId,
    amount: Number(withdrawal.amount),
    bankBin: withdrawal.bankBin ?? null,
    bankName: withdrawal.bankName ?? null,
    bankAccountNumber: withdrawal.bankAccountNumber ?? null,
    bankAccountName: withdrawal.bankAccountName ?? null,
    status: withdrawal.status,
    requestedAt: withdrawal.requestedAt,
    processedAt: withdrawal.processedAt ?? null,
    processedByUserId: withdrawal.processedByUserId ?? null,
    rejectReason: withdrawal.rejectReason ?? null,
    transactionId: withdrawal.transactionId ?? null,
    payoutId: withdrawal.payoutId ?? null,
    payoutState: withdrawal.payoutState ?? null,
    payoutBankReference: withdrawal.payoutBankReference ?? null,
    payoutAttemptedAt: withdrawal.payoutAttemptedAt ?? null,
    failureReason: withdrawal.failureReason ?? null,
    refundTransactionId: withdrawal.refundTransactionId ?? null,
    technician: withdrawal.technician
      ? {
          id: withdrawal.technician.id,
          fullName: withdrawal.technician.fullName,
          phoneNumber: withdrawal.technician.phoneNumber,
          email: withdrawal.technician.email,
          avatarUrl: withdrawal.technician.avatarUrl,
        }
      : undefined,
  };
}

/**
 * One sentence saying where a payout ended up, worded for whoever reads it:
 * the technician who asked, or the manager tracking the money.
 */
export function payoutMessage(
  status: WithdrawalStatus,
  audience: 'technician' | 'manager',
): string {
  const forTechnician = audience === 'technician';
  switch (status) {
    case WithdrawalStatus.SUCCESS:
      return forTechnician
        ? 'Đã chuyển tiền về tài khoản ngân hàng của bạn'
        : 'Đã chi tiền về tài khoản ngân hàng của kỹ thuật viên';
    case WithdrawalStatus.PROCESSING:
      return forTechnician
        ? 'Lệnh rút đã gửi, ngân hàng đang xử lý. Bạn sẽ nhận thông báo khi tiền về.'
        : 'payOS đang xử lý lệnh chi, hệ thống sẽ tự cập nhật kết quả.';
    case WithdrawalStatus.FAILED:
      return forTechnician
        ? 'Chuyển tiền không thành công, số tiền đã được hoàn lại vào ví của bạn'
        : 'Chi tiền không thành công, số tiền đã được hoàn lại vào ví kỹ thuật viên';
    default:
      return 'Đã cập nhật lệnh rút tiền';
  }
}
