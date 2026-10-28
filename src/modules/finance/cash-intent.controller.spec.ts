import { describe, expect, it, vi } from 'vitest';
import { CashIntentController } from './cash-intent.controller';

describe('cash intent HTTP response', () => {
  it('does not expose receipt evidence or internal allocation rows on GET', async () => {
    const finance = { getCashIntent: vi.fn(async () => ({
      id: 'intent-1', scopeKind: 'SOLO', scopeId: 'order-1', status: 'pending',
      customerDueVnd: 120_000, grossVnd: 150_000, technicianId: 'tech-1',
      receiptEvidenceUrl: 'private-reference', allocations: [{ invoiceId: 'invoice-1' }],
    })) };
    const controller = new CashIntentController(finance as any);
    const response = await controller.get('SOLO' as any, 'order-1', { user: { id: 'customer-1', role: 'customer' } });
    expect(response.data).toMatchObject({ id: 'intent-1', status: 'pending', customerDueVnd: 120_000 });
    expect(response.data).not.toHaveProperty('receiptEvidenceUrl');
    expect(response.data).not.toHaveProperty('allocations');
  });
});
