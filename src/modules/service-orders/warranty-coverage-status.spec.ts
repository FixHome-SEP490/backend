import { describe, expect, it } from 'vitest';
import { WarrantyStatus } from '../../shared/enums';
import { effectiveWarrantyStatus } from './warranty-coverage-status';

describe('effective warranty coverage status (found 01/11/2026, TC-WAR-003)', () => {
  const now = new Date('2026-11-01T08:00:00Z');

  it('keeps an active coverage active before its end date', () => {
    expect(effectiveWarrantyStatus({ status: WarrantyStatus.ACTIVE, expiresAt: new Date('2026-11-01T08:00:01Z') }, now)).toBe(WarrantyStatus.ACTIVE);
  });

  it('reads an active coverage as expired once its end date has passed', () => {
    expect(effectiveWarrantyStatus({ status: WarrantyStatus.ACTIVE, expiresAt: new Date('2026-10-30T10:35:57Z') }, now)).toBe(WarrantyStatus.EXPIRED);
  });

  it('treats the exact end instant as expired, the same boundary claims use for submitted after expiry', () => {
    expect(effectiveWarrantyStatus({ status: WarrantyStatus.ACTIVE, expiresAt: now }, now)).toBe(WarrantyStatus.EXPIRED);
  });

  it('accepts the end date as an ISO string from a raw row', () => {
    expect(effectiveWarrantyStatus({ status: WarrantyStatus.ACTIVE, expiresAt: '2026-10-01T00:00:00Z' as unknown as Date }, now)).toBe(WarrantyStatus.EXPIRED);
  });

  it.each([WarrantyStatus.VOIDED, WarrantyStatus.PENDING, WarrantyStatus.EXPIRED])('never rewrites a stored %s coverage', (status) => {
    expect(effectiveWarrantyStatus({ status, expiresAt: new Date('2026-10-01T00:00:00Z') }, now)).toBe(status);
    expect(effectiveWarrantyStatus({ status, expiresAt: new Date('2027-10-01T00:00:00Z') }, now)).toBe(status);
  });
});
