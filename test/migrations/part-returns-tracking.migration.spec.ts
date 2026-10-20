import { describe, expect, it, vi } from 'vitest';
import { PartReturnsTracking1790000000042 } from '../../src/database/migrations/1790000000042-PartReturnsTracking';
import { PartItemRealtime1790000000043 } from '../../src/database/migrations/1790000000043-PartItemRealtime';
import { RealtimeChangeNotify1790000000038 } from '../../src/database/migrations/1790000000038-RealtimeChangeNotify';

/** DDL contract only. Does not claim PostgreSQL execution/locking is verified. */
describe('additive physical-return migrations (DDL contract)', () => {
  const runner = () => {
    const statements: string[] = [];
    return { statements, query: vi.fn(async (sql: string) => { statements.push(sql); }) };
  };
  it('adds a permanent mode and discrepancy audit while leaving activation, orders and finance untouched', async () => {
    const q = runner();
    await new PartReturnsTracking1790000000042().up(q as never);
    const sql = q.statements.join('\n');
    expect(sql).toContain('tracking_only boolean NOT NULL DEFAULT false');
    expect(sql).toContain('NEW.tracking_only IS DISTINCT FROM OLD.tracking_only');
    expect(sql).toContain('created_at > NEW.cohort_activated_at');
    expect(sql).toContain("'report_discrepancy'");
    expect(sql).not.toMatch(/(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:part_custody_activation|service_orders|invoices|wallets|part_custody_payouts)\b/i);
    q.statements.length = 0;
    await new PartReturnsTracking1790000000042().down(q as never);
    expect(q.statements[0]).toContain('ACCESS EXCLUSIVE');
    expect(q.statements[1]).toContain("RAISE EXCEPTION 'Cannot revert persisted");
  });
  it('keeps request READY/RECEIVED triggers and adds item parent lookup and custody notices on the same channel', async () => {
    const old = runner();
    await new RealtimeChangeNotify1790000000038().up(old as never);
    expect(old.statements.some(sql => sql.includes('CREATE TRIGGER "trg_realtime_part_requests"'))).toBe(true);
    const q = runner();
    await new PartItemRealtime1790000000043().up(q as never);
    const sql = q.statements.join('\n');
    expect(sql).toContain("r.id = (row_now->>'part_request_id')::uuid");
    expect(sql).toContain('SELECT r.service_order_id, r.technician_id INTO order_id, technician_id');
    expect(sql).toContain("pg_notify('fixhome_changes'");
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON part_request_items');
    expect(sql).toContain('AFTER INSERT OR UPDATE OR DELETE ON part_custodies');
    expect(sql).not.toContain('CREATE OR REPLACE');
    q.statements.length = 0;
    await new PartItemRealtime1790000000043().down(q as never);
    expect(q.statements.join('\n')).not.toContain('DROP FUNCTION fixhome_notify_change');
  });
});
