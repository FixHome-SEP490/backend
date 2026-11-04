import { PartSource } from '../../shared/enums';

export type WarehouseQuantity = { partId: string; quantity: number };
export function canonicalWarehouseQuantities(items: { partCatalogId?: string | null; partSource: PartSource; quantity: number }[]): WarehouseQuantity[] {
  const quantities = new Map<string, number>();
  if (!items.length) throw new Error('Empty warehouse request');
  for (const item of items) {
    if (item.partSource !== PartSource.FIXHOME || !item.partCatalogId || !Number.isSafeInteger(item.quantity) || item.quantity < 1) {
      throw new Error('Invalid canonical warehouse quantity');
    }
    const quantity = (quantities.get(item.partCatalogId) ?? 0) + item.quantity;
    if (quantity > 2147483647) throw new Error('Warehouse quantity overflow');
    quantities.set(item.partCatalogId, quantity);
  }
  return [...quantities].sort(([a], [b]) => a.localeCompare(b)).map(([partId, quantity]) => ({ partId, quantity }));
}

export function hasWholeRequestStock(required: WarehouseQuantity[], stock: { partId: string; onHand: number; reserved: number }[]): boolean {
  return required.length > 0 && required.every(item => stock.some(row => row.partId === item.partId && row.onHand - row.reserved >= item.quantity));
}

export function warehouseBalance(onHand: number, reserved: number, delta: number, reservationDelta: number) {
  const next = { onHand: onHand + delta, reserved: reserved + reservationDelta };
  if (![onHand, reserved, delta, reservationDelta, next.onHand, next.reserved].every(Number.isSafeInteger) ||
      next.onHand < next.reserved || next.reserved < 0 || next.onHand > 2147483647) throw new Error('Invalid warehouse balance');
  return next;
}
