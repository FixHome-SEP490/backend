export const MAX_STOCK_QUANTITY = 2_147_483_647;

export interface StockBalanceInput {
  onHand: number;
  reserved: number;
  delta: number;
}

export function calculateStockBalance({ onHand, reserved, delta }: StockBalanceInput) {
  if (
    !Number.isInteger(onHand) ||
    !Number.isInteger(reserved) ||
    onHand < 0 ||
    reserved < 0 ||
    onHand < reserved
  ) {
    throw new Error('Stock balance invariant is invalid');
  }
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error('Stock adjustment must be a non-zero integer');
  }
  const nextOnHand = onHand + delta;
  if (nextOnHand > MAX_STOCK_QUANTITY || nextOnHand < 0) {
    throw new Error('Stock balance exceeds the supported integer range');
  }
  if (nextOnHand < reserved) {
    throw new Error('Stock adjustment would reduce on-hand below reserved quantity');
  }
  return { onHand: nextOnHand, reserved, available: nextOnHand - reserved };
}
