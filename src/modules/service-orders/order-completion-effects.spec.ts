import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { applyOrderCompletionEffects } from './order-completion-effects';
import { InvoiceItem } from './entities/invoice-item.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { TechnicianAssignment } from './entities/technician-assignment.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { PartSource } from '../../shared/enums';

function managerWith(items: Partial<InvoiceItem>[]) {
  const insert = vi.fn(async (_entity: unknown, _rows: unknown) => undefined);
  const manager = {
    find: vi.fn(async (entity: unknown) => (entity === InvoiceItem ? items : [])),
    findOne: vi.fn(async (entity: unknown) => {
      if (entity === Booking) return { id: 'b1', customerId: 'cust' };
      if (entity === TechnicianAssignment) return { technicianId: 'tech', isActive: true };
      return null;
    }),
    insert,
  } as unknown as EntityManager;
  return { manager, insert };
}

const order = { id: 'o1', code: 'FH-20261007-ABC', bookingId: 'b1' };
const notices = (insert: ReturnType<typeof vi.fn>) =>
  insert.mock.calls.filter(([entity]) => entity === Notification).flatMap(([, rows]) => rows as Array<{ userId: string; message: string; type: string }>);

describe('applyOrderCompletionEffects', () => {
  it('notifies customer and technician once each, inside the same manager', async () => {
    const { manager, insert } = managerWith([{ id: 'i1', warrantyDaysSnapshot: 0 }]);
    await applyOrderCompletionEffects(manager, order, 'inv1', new Date('2026-10-07T10:00:00Z'));
    const rows = notices(insert);
    expect(rows.map((r) => r.userId).sort()).toEqual(['cust', 'tech']);
    expect(rows.every((r) => r.type === 'ORDER_COMPLETED')).toBe(true);
  });

  it('does not claim a warranty when no line carries one', async () => {
    const { manager, insert } = managerWith([{ id: 'i1', warrantyDaysSnapshot: 0 }]);
    await applyOrderCompletionEffects(manager, order, 'inv1', new Date());
    expect(insert.mock.calls.some(([entity]) => entity === WarrantyCoverage)).toBe(false);
    expect(notices(insert).find((r) => r.userId === 'cust')?.message).not.toMatch(/bảo hành/i);
  });

  it('starts coverage for warranty lines and says so', async () => {
    const now = new Date('2026-10-07T10:00:00Z');
    const { manager, insert } = managerWith([
      { id: 'i1', warrantyDaysSnapshot: 30, partSource: null },
      { id: 'i2', warrantyDaysSnapshot: 90, partSource: PartSource.TECHNICIAN, partWarrantyOption: null },
    ]);
    await applyOrderCompletionEffects(manager, order, 'inv1', now);
    const coverage = insert.mock.calls.filter(([entity]) => entity === WarrantyCoverage).map(([, row]) => row as { invoiceItemId: string; expiresAt: Date });
    expect(coverage.map((c) => c.invoiceItemId)).toEqual(['i1']);
    expect(coverage[0].expiresAt.toISOString()).toBe('2026-11-06T10:00:00.000Z');
    expect(notices(insert).find((r) => r.userId === 'cust')?.message).toMatch(/bảo hành/i);
  });
});
