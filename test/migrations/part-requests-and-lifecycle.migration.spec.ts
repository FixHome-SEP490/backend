import { describe, expect, it, vi } from 'vitest';
import { PartRequestsAndLifecycle1790000000005 } from '../../src/database/migrations/1790000000005-PartRequestsAndLifecycle';

describe('PartRequestsAndLifecycle1790000000005 Migration', () => {
  it('creates part_requests, part_request_items and updates additional_cost_requests in up()', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new PartRequestsAndLifecycle1790000000005().up(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    // Enums
    expect(sql).toContain('part_request_status_enum');
    expect(sql).toContain('part_request_type_enum');
    expect(sql).toContain('fulfillment_method_enum');
    expect(sql).toContain('part_usage_status_enum');

    // Tables
    expect(sql).toContain('create table if not exists "part_requests"');
    expect(sql).toContain('"service_order_id" uuid');
    expect(sql).toContain('"technician_id" uuid');
    expect(sql).toContain('"fulfillment_method"');
    expect(sql).toContain('"shipping_fee"');
    expect(sql).toContain('"qr_token"');

    expect(sql).toContain('create table if not exists "part_request_items"');
    expect(sql).toContain('"part_request_id" uuid');
    expect(sql).toContain('"part_name_snapshot"');
    expect(sql).toContain('"usage_status"');

    // Indexes
    expect(sql).toContain('ix_part_requests_service_order');
    expect(sql).toContain('ix_part_requests_technician');
    expect(sql).toContain('ix_part_request_items_request');

    // Additional cost requests alteration
    expect(sql).toContain('additional_cost_requests');
    expect(sql).toContain('fulfillment_method');
    expect(sql).toContain('shipping_fee');
  });

  it('reverts all created tables, columns and enums in down()', async () => {
    const queries: string[] = [];
    const queryRunner = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as any;

    await new PartRequestsAndLifecycle1790000000005().down(queryRunner);

    const sql = queries.join('\n').toLowerCase();
    expect(sql).toContain('drop table if exists "part_request_items"');
    expect(sql).toContain('drop table if exists "part_requests"');
    expect(sql).toContain('drop column if exists "shipping_fee"');
    expect(sql).toContain('drop column if exists "fulfillment_method"');
    expect(sql).toContain('drop type if exists "part_usage_status_enum"');
    expect(sql).toContain('drop type if exists "fulfillment_method_enum"');
    expect(sql).toContain('drop type if exists "part_request_type_enum"');
    expect(sql).toContain('drop type if exists "part_request_status_enum"');
  });
});
