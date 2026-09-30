import { describe, expect, it } from 'vitest';
import { ServiceOrderStatus } from '../../shared/enums';
import { repairHistoryStatuses } from './repair-history-filter';

describe('repairHistoryStatuses', () => {
  it('keeps backward-compatible terminal history when no filter is supplied', () => {
    expect(repairHistoryStatuses()).toEqual([
      ServiceOrderStatus.COMPLETED,
      ServiceOrderStatus.CANCELLED,
    ]);
  });

  it.each([
    ServiceOrderStatus.COMPLETED,
    ServiceOrderStatus.CANCELLED,
  ])('accepts terminal status %s', (status) => {
    expect(repairHistoryStatuses(status)).toEqual([status]);
  });

  it.each([
    ServiceOrderStatus.ACCEPTED,
    ServiceOrderStatus.EN_ROUTE,
    ServiceOrderStatus.UNDER_REPAIR,
  ])('rejects non-terminal status %s', (status) => {
    expect(() => repairHistoryStatuses(status)).toThrow(
      'Repair history status must be completed or cancelled',
    );
  });
});
