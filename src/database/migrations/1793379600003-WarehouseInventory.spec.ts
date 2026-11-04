import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(__dirname, '1793379600003-WarehouseInventory.ts'),
  'utf8',
).replace(/\s+/g, ' ');

describe('WarehouseInventory migration contract', () => {
  it('creates only the additive warehouse, stock, and append-only movement schema', () => {
    expect(migration).toContain('CREATE TABLE warehouses');
    expect(migration).toContain('CREATE TABLE warehouse_stock');
    expect(migration).toContain('CREATE TABLE stock_movements');
    expect(migration).toContain('UNIQUE (warehouse_id, part_id)');
    expect(migration).toContain('UNIQUE (idempotency_key)');
    expect(migration).toContain('CHECK (on_hand >= reserved AND reserved >= 0)');
    expect(migration).toContain('DEFAULT 0');
    expect(migration).toContain('CREATE TRIGGER protect_stock_movements');
    expect(migration).not.toMatch(/INSERT INTO warehouses|INSERT INTO warehouse_stock/i);
    expect(migration).not.toMatch(/part_requests|invoices|wallets|payments|finance/i);
  });

  it('guards rollback from deleting warehouse stock history', () => {
    expect(migration).toContain('Refusing to drop warehouses with stock history');
    expect(migration).toContain('DROP TABLE stock_movements, warehouse_stock, warehouses');
  });
});
