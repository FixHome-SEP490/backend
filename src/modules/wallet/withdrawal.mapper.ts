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
