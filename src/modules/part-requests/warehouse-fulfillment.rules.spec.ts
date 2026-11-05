import { describe, expect, it } from 'vitest';
import { canonicalWarehouseQuantities, hasWholeRequestStock, warehouseBalance } from './warehouse-fulfillment.rules';
import { PartSource } from '../../shared/enums';

describe('W2 canonical single warehouse fulfillment', () => {
  const items = [
    { partCatalogId: 'a', partSource: PartSource.FIXHOME, quantity: 2 },
    { partCatalogId: 'b', partSource: PartSource.FIXHOME, quantity: 1 },
    { partCatalogId: 'a', partSource: PartSource.FIXHOME, quantity: 1 },
  ];
  it('aggregates canonical quantities in deterministic SKU order', () => {
    expect(canonicalWarehouseQuantities(items)).toEqual([{ partId: 'a', quantity: 3 }, { partId: 'b', quantity: 1 }]);
  });
  it('requires all SKUs from one warehouse, without combining A and B', () => {
    const required = canonicalWarehouseQuantities(items);
    expect(hasWholeRequestStock(required, [{ partId: 'a', onHand: 3, reserved: 0 }])).toBe(false);
    expect(hasWholeRequestStock(required, [{ partId: 'b', onHand: 5, reserved: 0 }])).toBe(false);
    expect(hasWholeRequestStock(required, [{ partId: 'a', onHand: 4, reserved: 1 }, { partId: 'b', onHand: 1, reserved: 0 }])).toBe(true);
  });
  it('does not spend reserved units', () => {
    expect(hasWholeRequestStock(canonicalWarehouseQuantities(items), [{ partId: 'a', onHand: 3, reserved: 1 }, { partId: 'b', onHand: 10, reserved: 0 }])).toBe(false);
  });
  it('reserve and release do not change physical onHand; issue changes both once', () => {
    expect(warehouseBalance(4, 1, 0, 3)).toEqual({ onHand: 4, reserved: 4 });
    expect(warehouseBalance(4, 4, 0, -3)).toEqual({ onHand: 4, reserved: 1 });
    expect(warehouseBalance(4, 4, -3, -3)).toEqual({ onHand: 1, reserved: 1 });
    expect(warehouseBalance(1, 1, 2, 0)).toEqual({ onHand: 3, reserved: 1 });
  });
  it('rejects invalid/overflow stock and incomplete canonical requests', () => {
    expect(() => warehouseBalance(1, 1, -1, 0)).toThrow();
    expect(() => warehouseBalance(1, 0, 0, -1)).toThrow();
    expect(() => warehouseBalance(2147483647, 0, 1, 0)).toThrow();
    expect(() => canonicalWarehouseQuantities([])).toThrow();
    expect(() => canonicalWarehouseQuantities([{ ...items[0], quantity: 0 }])).toThrow();
    expect(() => canonicalWarehouseQuantities([{ ...items[0], partCatalogId: null }])).toThrow();
  });
});
