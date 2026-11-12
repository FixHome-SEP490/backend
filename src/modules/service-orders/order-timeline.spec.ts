import { describe, expect, it } from 'vitest';
import { orderTimeline } from './service-orders.service';
import { ServiceOrderStatus } from '../../shared/enums';
import type { OrderStatusHistory } from './entities/order-status-history.entity';

/** FH-20261102-AAE90FDA: the technician withdrew and the order was cancelled in one transaction. */
const at = (iso: string) => new Date(iso);
const accepted = { id: 'h1', toStatus: 'accepted', fromStatus: null, reason: 'Technician accepted invitation', actorRole: 'technician', createdAt: at('2026-11-01T23:57:42.146Z') };
const withdrew = { id: 'h2', toStatus: 'accepted', fromStatus: 'accepted', reason: 'Kỹ thuật viên rút trước khi tới', actorRole: 'technician', createdAt: at('2026-11-01T23:58:55.290Z') };
const cancelled = { id: 'h3', toStatus: 'cancelled', fromStatus: 'accepted', reason: 'Không còn thợ thay thế', actorRole: 'system', createdAt: at('2026-11-01T23:58:55.290Z') };
const rows = (...r: object[]) => r as OrderStatusHistory[];

describe('order timeline', () => {
  it('puts the step that led to the current status last among steps of the same time, whatever order the database returns', () => {
    const order = { status: ServiceOrderStatus.CANCELLED };
    const expected = ['accepted', 'accepted', 'cancelled'];
    expect(orderTimeline(order, rows(accepted, withdrew, cancelled)).map(t => t.status)).toEqual(expected);
    expect(orderTimeline(order, rows(accepted, cancelled, withdrew)).map(t => t.status)).toEqual(expected);
    expect(orderTimeline(order, rows(cancelled, withdrew, accepted)).map(t => t.status)).toEqual(expected);
  });

  it('keeps steps of different times in time order, with their title, time and actor', () => {
    const later = { ...cancelled, createdAt: at('2026-11-02T00:00:00.000Z') };
    expect(orderTimeline({ status: ServiceOrderStatus.CANCELLED }, rows(later, accepted))).toEqual([
      { status: 'accepted', title: 'Technician accepted invitation', timestamp: '2026-11-01T23:57:42.146Z', actor: 'technician' },
      { status: 'cancelled', title: 'Không còn thợ thay thế', timestamp: '2026-11-02T00:00:00.000Z', actor: 'system' },
    ]);
  });

  it('does not change the history it is given', () => {
    const history = rows(cancelled, accepted);
    orderTimeline({ status: ServiceOrderStatus.CANCELLED }, history);
    expect(history.map(h => (h as { id: string }).id)).toEqual(['h3', 'h1']);
  });
});
