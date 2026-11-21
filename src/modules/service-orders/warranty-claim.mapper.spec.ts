import { describe, expect, it } from 'vitest';
import { WarrantyClaimStatus } from '../../shared/enums';
import { toCustomerClaimView } from './warranty-claim.mapper';

const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 'claim-1', serviceOrderId: 'order-1', warrantyCoverageId: 'cov-1', status: WarrantyClaimStatus.RESOLVED,
  description: 'Vẫn rò nước', submittedAfterExpiry: false, submittedAt: new Date('2026-11-22T00:07:00Z'),
  finalResult: 'covered_part', finalReasonCode: null, outcomeCode: 'fixed', refundAmount: null, technician: null, ...overrides,
}) as any;
const visit = (overrides: Record<string, unknown> = {}) => ({
  scheduledAt: new Date('2026-11-22T01:00:00Z'), checkedInAt: new Date('2026-11-22T01:05:00Z'), findings: 'Van xả hỏng, đã thay mới',
  evidenceRefs: ['https://cdn.test/a.jpg'], reServiceNotes: 'Đã thay van và thử áp', reServiceEvidenceRefs: null, completedAt: new Date('2026-11-22T02:00:00Z'),
  proposedResult: 'covered_part', notCoveredReasonCode: 'customer_misuse', faultyInvoiceItemIds: ['line-1'], faultyQuantities: { 'line-1': 1 }, ...overrides,
}) as any;

describe('customer warranty claim view', () => {
  it('shows the approved result, findings and outcome once the manager decided', () => {
    const view = toCustomerClaimView(claim(), visit());
    expect(view.inspectionScheduledAt).toEqual(new Date('2026-11-22T01:00:00Z'));
    expect(view.inspection).toMatchObject({ result: 'covered_part', findings: 'Van xả hỏng, đã thay mới', reServiceNotes: 'Đã thay van và thử áp' });
    expect(view.outcomeCode).toBe('fixed');
  });

  it('keeps the technician draft and internal codes out of the customer view', () => {
    const json = JSON.stringify(toCustomerClaimView(claim(), visit()));
    expect(json).not.toMatch(/proposedResult|notCoveredReasonCode|faultyInvoiceItemIds|faultyQuantities/);
  });

  it.each([WarrantyClaimStatus.SUBMITTED, WarrantyClaimStatus.ACCEPTED, WarrantyClaimStatus.INSPECTED])('hides the technician proposal while the claim is %s', (status) => {
    const view = toCustomerClaimView(claim({ status, finalResult: null, outcomeCode: null }), visit());
    expect(view.inspection).toBeUndefined();
    expect(view.inspectionScheduledAt).toEqual(new Date('2026-11-22T01:00:00Z'));
  });

  it('has no result without a visit or an approved conclusion', () => {
    expect(toCustomerClaimView(claim(), undefined).inspection).toBeUndefined();
    expect(toCustomerClaimView(claim({ finalResult: null }), visit()).inspection).toBeUndefined();
  });
});
