import { describe, expect, it } from 'vitest';
import { calculateStockBalance } from './stock-balance.rules';

describe('calculateStockBalance', () => {
  it('starts a new part row at zero and applies a stock-in exactly once', () => {
    expect(calculateStockBalance({ onHand: 0, reserved: 0, delta: 7 })).toEqual({
      onHand: 7,
      reserved: 0,
      available: 7,
    });
  });

  it('allows a correction only when on-hand remains at least reserved', () => {
    expect(() => calculateStockBalance({ onHand: 8, reserved: 3, delta: -6 })).toThrow(
      'Stock adjustment would reduce on-hand below reserved quantity',
    );
  });

  it('rejects invalid existing balances, zero delta, and PostgreSQL integer overflow', () => {
    expect(() => calculateStockBalance({ onHand: 1, reserved: 2, delta: 1 })).toThrow(
      'Stock balance invariant is invalid',
    );
    expect(() => calculateStockBalance({ onHand: 1, reserved: 0, delta: 0 })).toThrow(
      'Stock adjustment must be a non-zero integer',
    );
    expect(() => calculateStockBalance({ onHand: 2147483647, reserved: 0, delta: 1 })).toThrow(
      'Stock balance exceeds the supported integer range',
    );
  });
});
