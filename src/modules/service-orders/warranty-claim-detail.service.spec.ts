import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { WarrantyClaimDetailService } from './warranty-claim-detail.service';

const FUTURE = new Date(Date.now() + 10 * 86_400_000);

const claim = (overrides: Record<string, unknown> = {}) => ({
  id: 'claim-1', serviceOrderId: 'order-1', warrantyCoverageId: 'cov-1', status: 'in_progress',
  smOverrodeProposal: true, finalResult: 'covered_part', finalReasonCode: null,
  reviewedByManagerId: 'sm-1', reviewedAt: new Date('2026-11-02T01:00:00Z'), customerRespondedAt: null, awaitingSince: null,
  escalatedSupportCaseId: null, declinedByTechnicianId: 'tech-9', declinedAt: new Date('2026-11-01T01:00:00Z'),
  declineReasonCode: 'busy', declineNote: null, submittedAt: new Date('2026-10-31T01:00:00Z'),
  ...overrides,
});

const make = (options: { claim?: unknown; request?: unknown; others?: unknown[] } = {}) => {
  const tables: Record<string, unknown> = {
    ServiceOrder: { id: 'order-1', completedAt: new Date('2026-10-20T01:00:00Z'), laborTotal: '300000', partsTotal: '700000', grandTotal: '1000000', laborWarrantyDays: 30, paymentStatus: 'paid' },
    Invoice: { id: 'inv-1', laborTotal: '300000', partsTotal: '700000', grandTotal: '1000000', paymentStatus: 'paid' },
    WarrantyCoverage: { id: 'cov-1', invoiceItemId: 'line-2', startsAt: new Date('2026-10-20T01:00:00Z'), expiresAt: FUTURE, warrantyDaysSnapshot: 90, status: 'active' },
    PartRequest: 'request' in options ? options.request : null,
  };
  const lists: Record<string, unknown[]> = {
    TechnicianAssignment: [{ technicianId: 'tech-1', assignedAt: new Date('2026-10-19T01:00:00Z'), isActive: true }],
    InvoiceItem: [
      { id: 'line-1', type: 'labor', description: 'Công thay bo mạch', quantity: 1, unitPrice: '300000', lineTotal: '300000', warrantyDaysSnapshot: 30, partSource: null },
      { id: 'line-2', type: 'parts_equipment', description: 'Board X', quantity: 1, unitPrice: '700000', lineTotal: '700000', warrantyDaysSnapshot: 90, partSource: 'fixhome', partWarrantyOption: 'included' },
    ],
    WarrantyVisit: [{ id: 'v1', technicianId: 'tech-1', status: 'inspected', proposedResult: 'covered_part', faultyInvoiceItemIds: ['line-2'], createdAt: new Date() }],
    PartRequestItem: [{ id: 'i1', partNameSnapshot: 'Board X', quantity: 1, unitPriceSnapshot: '700000', usageStatus: 'pending' }],
    WarrantyClaim: options.others ?? [],
    User: [{ id: 'tech-1', fullName: 'Thợ A' }, { id: 'sm-1', fullName: 'Quản lý B' }, { id: 'tech-9', fullName: 'Thợ C' }],
  };
  const manager = {
    findOneBy: vi.fn(async (entity: { name: string }) => tables[entity.name] ?? null),
    find: vi.fn(async (entity: { name: string }) => lists[entity.name] ?? []),
  };
  const claimRepo = { findOne: vi.fn().mockResolvedValue('claim' in options ? options.claim : claim()) };
  const reader = { toStaffViews: vi.fn(async (rows: any[]) => rows.map((c) => ({ id: c.id, status: c.status }))) };
  const service = new WarrantyClaimDetailService({ manager } as any, claimRepo as any, reader as any);
  return { service, manager, claimRepo, reader };
};

describe('manager reads one warranty claim in full', () => {
  it('adds the decision, who declined, the original job with the covered line marked, the coverage and the people by name', async () => {
    const { service } = make();

    const result = await service.get('claim-1');

    expect(result).toMatchObject({ id: 'claim-1', status: 'in_progress' });
    expect(result.detail.decision).toMatchObject({ finalResult: 'covered_part', smOverrodeProposal: true, reviewedBy: { id: 'sm-1', fullName: 'Quản lý B' } });
    expect(result.detail.declined).toMatchObject({ by: { fullName: 'Thợ C' }, reasonCode: 'busy' });
    expect(result.detail.originalJob).toMatchObject({ grandTotal: 1_000_000, laborTotal: 300_000, partsTotal: 700_000, paymentStatus: 'paid', laborWarrantyDays: 30 });
    expect(result.detail.originalJob.technicians).toEqual([expect.objectContaining({ id: 'tech-1', fullName: 'Thợ A', isActive: true })]);
    expect(result.detail.originalJob.lines.map((l) => [l.description, l.covered, l.faulty])).toEqual([['Công thay bo mạch', false, false], ['Board X', true, true]]);
    expect(result.detail.originalJob.lines[1]).toMatchObject({ unitPrice: 700_000, partSource: 'fixhome', warrantyDays: 90 });
    expect(result.detail.coverage).toMatchObject({ warrantyDays: 90, status: 'active' });
    expect(result.detail.visits).toEqual([expect.objectContaining({ id: 'v1', technician: { id: 'tech-1', fullName: 'Thợ A' } })]);
    expect(result.detail.partRequest).toBeNull();
    expect(result.detail.otherClaims).toEqual([]);
  });

  it('shows the warranty part with the faulty-part inspection, and who pays', async () => {
    const { service } = make({ request: { id: 'pr-1', status: 'requested', chargeTechnician: true, faultyInspectionResult: 'installation', faultyInspectionNote: 'Đấu sai cực', faultyInspectionEvidence: ['a.jpg'], faultyInspectedAt: new Date() } });

    const { detail } = await service.get('claim-1');

    expect(detail.partRequest).toMatchObject({ id: 'pr-1', chargeTechnician: true, faultyInspectionResult: 'installation', faultyInspectionEvidence: ['a.jpg'], faultyReturnedAt: null });
    expect(detail.partRequest?.items).toEqual([{ id: 'i1', name: 'Board X', quantity: 1, unitPrice: 700_000, usageStatus: 'pending' }]);
  });

  it('lists the other claims of the same order with the item each is about', async () => {
    const { service, manager } = make({ others: [{ id: 'claim-0', status: 'resolved', submittedAt: new Date('2026-10-25T01:00:00Z'), warrantyCoverageId: 'cov-1' }] });
    manager.find.mockImplementation(async (entity: { name: string }) => (entity.name === 'WarrantyClaim'
      ? [{ id: 'claim-0', status: 'resolved', submittedAt: new Date('2026-10-25T01:00:00Z'), warrantyCoverageId: 'cov-1' }]
      : entity.name === 'WarrantyCoverage' ? [{ id: 'cov-1', invoiceItemId: 'line-2' }]
        : entity.name === 'InvoiceItem' ? [{ id: 'line-2', type: 'parts_equipment', description: 'Board X', quantity: 1, unitPrice: '1', lineTotal: '1', warrantyDaysSnapshot: 90 }]
          : []));

    const { detail } = await service.get('claim-1');

    expect(detail.otherClaims).toEqual([expect.objectContaining({ id: 'claim-0', status: 'resolved', itemDescription: 'Board X' })]);
  });

  it('omits the decline block for a claim nobody declined, and answers 404 for an unknown claim', async () => {
    const clean = make({ claim: claim({ declinedByTechnicianId: null, declinedAt: null, declineReasonCode: null }) });
    expect((await clean.service.get('claim-1')).detail.declined).toBeNull();

    const missing = make({ claim: null });
    await expect(missing.service.get('nope')).rejects.toMatchObject({ response: { code: ErrorCodes.NOT_FOUND } });
  });
});
