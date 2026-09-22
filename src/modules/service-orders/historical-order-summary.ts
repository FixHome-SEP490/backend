import type { ServiceOrder } from './entities/service-order.entity';

// Deliberately narrow: old assignees may retain a work-history entry,
// but no booking identifiers, addresses, customer data, GPS, media or AI.
export interface HistoricalOrderSummary {
  id: string;
  code: string;
  status: ServiceOrder['status'];
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  historical: true;
}

export function historicalOrderSummary(order: ServiceOrder): HistoricalOrderSummary {
  return {
    id: order.id,
    code: order.code,
    status: order.status,
    createdAt: order.createdAt,
    completedAt: order.completedAt ?? null,
    cancelledAt: order.cancelledAt ?? null,
    historical: true,
  };
}