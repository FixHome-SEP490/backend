import { describe, expect, it } from 'vitest';
import { assertFixedPriceQuote } from './visit-fixed-quote';
import { CostItemType } from '../../shared/enums';

// PO 21/10/2026 (G0-1 1B): a fixed-price device of a visit is approved on site at the booked price.
const labor = (unitPrice: number, quantity = 1) => ({ type: CostItemType.LABOR, quantity, unitPrice });
const booking = { fixedUnitPriceSnapshot: '200000.00', quantity: 1 };

describe('assertFixedPriceQuote', () => {
  it('takes labour that adds up to the booked price, in one line or several', () => {
    expect(() => assertFixedPriceQuote([labor(200000)], booking)).not.toThrow();
    expect(() => assertFixedPriceQuote([labor(150000), labor(50000)], booking)).not.toThrow();
  });

  it('refuses another price or a part in the quote, naming the price', () => {
    expect(() => assertFixedPriceQuote([labor(250000)], booking)).toThrow('200.000đ');
    expect(() => assertFixedPriceQuote([labor(100000, 2)], { ...booking, fixedUnitPriceSnapshot: 150000 })).toThrow();
    expect(() => assertFixedPriceQuote([labor(200000), { type: CostItemType.PARTS_EQUIPMENT, quantity: 1, unitPrice: 0 }], booking)).toThrow();
    expect(() => assertFixedPriceQuote([labor(0)], { fixedUnitPriceSnapshot: null })).toThrow();
  });
});
