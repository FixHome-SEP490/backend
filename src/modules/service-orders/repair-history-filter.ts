import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { ServiceOrderStatus } from '../../shared/enums';

const TERMINAL_REPAIR_HISTORY_STATUSES = [
  ServiceOrderStatus.COMPLETED,
  ServiceOrderStatus.CANCELLED,
] as const;

export function repairHistoryStatuses(status?: ServiceOrderStatus): ServiceOrderStatus[] {
  if (status === undefined) return [...TERMINAL_REPAIR_HISTORY_STATUSES];

  if (!TERMINAL_REPAIR_HISTORY_STATUSES.includes(
    status as (typeof TERMINAL_REPAIR_HISTORY_STATUSES)[number],
  )) {
    throw new BusinessException(
      ErrorCodes.VALIDATION_FAILED,
      'Repair history status must be completed or cancelled',
    );
  }

  return [status];
}
