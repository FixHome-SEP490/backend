import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BookingsService } from './bookings.service';
import { VisitGroupsService } from '../visit-groups/visit-groups.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Booking } from './entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { Address } from '../users/entities/address.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { RepairFailureRebook, RepairFailureRebookSource } from './entities/repair-failure-rebook.entity';
// @ts-ignore Vitest transforms this eager glob; the backend runtime compiles as CommonJS.
const entityModules = import.meta.glob('../../**/*.entity.ts', { eager: true });

const url = process.env.T2QA_REBOOK_TEST_URL;
const allowed = url && (() => {
  const parsed = new URL(url);
  return parsed.hostname === '127.0.0.1' && parsed.port === '55432' && parsed.pathname === '/fixhome_t2_rebook' && parsed.username === 't2qa';
})();
if (url && !allowed) throw new Error('Refusing a database other than the isolated repair-rebook QA database');

describe.skipIf(!allowed)('repair-failure rebook PostgreSQL transactions', () => {
  let dataSource: DataSource;
  let bookings: BookingsService;
  let groups: VisitGroupsService;
  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url, entities: Object.values(entityModules).flatMap(module => Object.values(module as Record<string, unknown>)).filter((value): value is new () => object => typeof value === 'function'), synchronize: false, logging: false });
    await dataSource.initialize();
    const config = { getInt: async (_: string, fallback: number) => fallback, getString: async () => 'true' };
    const audit = new AuditLogService({} as never);
    bookings = Object.assign(Object.create(BookingsService.prototype), {
      dataSource, userRepo: dataSource.getRepository(User), serviceRepo: dataSource.getRepository(Service),
      addressRepo: dataSource.getRepository(Address), auditLogService: audit, configService: config,
    });
    groups = Object.assign(Object.create(VisitGroupsService.prototype), {
      dataSource, groupRepo: dataSource.getRepository(VisitGroup), itemRepo: dataSource.getRepository(VisitGroupItem),
      bookingsService: bookings, auditLogService: audit, config,
    });
  });
  afterAll(async () => { if (dataSource?.isInitialized) await dataSource.destroy(); });

  async function fixture(failed: number, grouped: boolean) {
    const customerId = randomUUID(); const technicianId = randomUUID();
    const categoryId = randomUUID(); const serviceId = randomUUID(); const addressId = randomUUID();
    const groupId = grouped ? randomUUID() : null;
    await dataSource.query(`INSERT INTO users (id,email,password_hash,full_name,role) VALUES ($1,$2,'qa','QA customer','customer'),($3,$4,'qa','QA technician','technician')`,
      [customerId, `${customerId}@qa.invalid`, technicianId, `${technicianId}@qa.invalid`]);
    await dataSource.query(`INSERT INTO service_categories (id,name,code) VALUES ($1,'QA category',$2)`, [categoryId, `QA-${categoryId}`]);
    await dataSource.query(`INSERT INTO services (id,category_id,name,code,pricing_mode,fixed_price,is_active) VALUES ($1,$2,'QA fixed service',$3,'fixed_price',199000,true)`, [serviceId, categoryId, `QA-${serviceId}`]);
    await dataSource.query(`INSERT INTO addresses (id,user_id,line1,district,province,lat,lng) VALUES ($1,$2,'QA address','Quận 1','Hồ Chí Minh',10.1,106.1)`, [addressId, customerId]);
    if (groupId) await dataSource.query(`INSERT INTO visit_groups (id,customer_id,address_id,booking_mode,slot,preferred_start_at,preferred_end_at) VALUES ($1,$2,$3,'scheduled','morning','2030-10-28T01:00:00Z','2030-10-28T05:00:00Z')`, [groupId, customerId, addressId]);
    const sourceIds: string[] = []; const incidentIds: string[] = [];
    for (let index = 0; index < (grouped ? 3 : 1); index++) {
      const bookingId = randomUUID(); const orderId = randomUUID(); const incidentId = randomUUID();
      sourceIds.push(bookingId); incidentIds.push(incidentId);
      await dataSource.query(`INSERT INTO bookings (id,customer_id,service_id,address_id,description,status,visit_group_id,booking_mode,slot,quantity) VALUES ($1,$2,$3,$4,'Old device',$5,$6,'scheduled','morning',1)`,
        [bookingId, customerId, serviceId, addressId, index < failed ? 'cancelled' : 'matched', groupId]);
      if (groupId) await dataSource.query(`INSERT INTO visit_group_items (group_id,sequence,booking_id,service_id,outcome) VALUES ($1,$2,$3,$4,$5)`,
        [groupId, index + 1, bookingId, serviceId, index < failed ? 'failed' : 'succeeded']);
      await dataSource.query(`INSERT INTO service_orders (id,booking_id,code,status) VALUES ($1,$2,$3,$4)`,
        [orderId, bookingId, `QA-${orderId}`, index < failed ? 'cancelled' : 'accepted']);
      if (index < failed) {
        await dataSource.query(`INSERT INTO support_cases (id,case_type,booking_id,service_order_id,customer_id,technician_id,created_by_user_id,reason) VALUES ($1,'mid_job_interruption',$2,$3,$4,$5,$5,'QA failure')`,
          [incidentId, bookingId, orderId, customerId, technicianId]);
        await dataSource.query(`INSERT INTO audit_logs (actor_user_id,actor_role,action,resource_type,resource_id,"after") VALUES ($1,'technician','VISIT_DEVICE_REPAIR_FAILED','service_order',$2,$3)`,
          [technicianId, orderId, JSON.stringify({ version: 1, incidentId, request: { reason: 'other', note: null, parts: [], photoEvidenceIds: [] } })]);
      }
    }
    const body = { idempotencyKey: `qa-rebook-${randomUUID()}`, addressId, date: '2030-10-29', slot: 'afternoon' as const,
      items: sourceIds.slice(0, failed).map((sourceBookingId, index) => ({ sourceBookingId, sourceIncidentId: incidentIds[index] })) };
    const actor = { id: customerId, role: 'customer' };
    const confirm = (input = body) => bookings.confirmRepairFailureRebook(sourceIds[0], input, actor,
      (dto, customer, manager) => groups.create(dto, customer, manager));
    return { sourceIds, incidentIds, body, confirm, groupId, technicianId };
  }

  it.each([1, 2, 3])('persists %i child target(s) with source receipts and retries without another target', async count => {
    const f = await fixture(count, true);
    const first = await f.confirm(); const retry = await f.confirm();
    expect(retry).toEqual(first);
    expect(first.targetKind).toBe(count === 1 ? 'booking' : 'visit_group');
    expect(first.items).toHaveLength(count);
    const rows = await dataSource.getRepository(RepairFailureRebookSource).find({ where: { sourceBookingId: f.sourceIds[0] } });
    expect(rows).toHaveLength(1);
    const all = await dataSource.getRepository(RepairFailureRebookSource).find({ where: { rebookId: rows[0].rebookId } });
    expect(all).toHaveLength(count);
    const targets = await dataSource.getRepository(Booking).findByIds(first.items.map(item => item.bookingId));
    expect(targets).toHaveLength(count);
    expect(targets.every(target => target.status === 'submitted' && target.fixedUnitPriceSnapshot == 199000
      && target.visitGroupId === first.visitGroupId && target.slot === 'afternoon')).toBe(true);
    await expect(bookings.repairFailureDraft(f.sourceIds[0], { id: targets[0].customerId, role: 'customer' })).rejects.toThrow();
    await expect(f.confirm({ ...f.body, idempotencyKey: `qa-rebook-${randomUUID()}` })).rejects.toThrow();
  }, 15000);

  it.each([1, 2, 3])('serializes two concurrent retries for %i failed children', async count => {
    const f = await fixture(count, count > 1);
    const [left, right] = await Promise.all([f.confirm(), f.confirm()]);
    expect(right).toEqual(left);
    const receipts = await dataSource.getRepository(RepairFailureRebook).find({ where: { customerId: (await dataSource.getRepository(Booking).findOneByOrFail({ id: f.sourceIds[0] })).customerId } });
    expect(receipts).toHaveLength(1);
  }, 15000);

  it('enforces source-child uniqueness in PostgreSQL even when a caller bypasses the service', async () => {
    const f = await fixture(1, false);
    await f.confirm();
    const original = await dataSource.getRepository(RepairFailureRebookSource).findOneByOrFail({ sourceBookingId: f.sourceIds[0] });
    await expect(dataSource.transaction(async manager => {
      const incident = await manager.query(`INSERT INTO support_cases (case_type,booking_id,reason) VALUES ('mid_job_interruption',$1,'QA duplicate') RETURNING id`, [f.sourceIds[0]]);
      await manager.query(`INSERT INTO repair_failure_rebook_sources (rebook_id,source_booking_id,source_incident_id,target_booking_id) VALUES ($1,$2,$3,$4)`,
        [original.rebookId, f.sourceIds[0], incident[0].id, f.sourceIds[0]]);
    })).rejects.toMatchObject({ driverError: { code: '23505', constraint: 'uq_repair_failure_rebook_source' } });
  }, 15000);

  it('keeps live siblings visible when the failed lead assignment is inactive', async () => {
    const f = await fixture(1, true);
    const orders: Array<{ id: string; booking_id: string }> = await dataSource.query(`SELECT id, booking_id FROM service_orders WHERE booking_id = ANY($1::uuid[])`, [f.sourceIds]);
    for (const order of orders) {
      await dataSource.query(`INSERT INTO technician_assignments (service_order_id,technician_id,is_active) VALUES ($1,$2,$3)`,
        [order.id, f.technicianId, order.booking_id !== f.sourceIds[0]]);
    }
    const visible = await groups.assignedPage(f.technicianId, { page: 1, pageSize: 10 });
    expect(visible.data.map(group => group.id)).toContain(f.groupId);
    await dataSource.query(`UPDATE technician_assignments SET is_active = false WHERE service_order_id = $1`,
      [orders.find(order => order.booking_id === f.sourceIds[1])!.id]);
    const afterSiblingRelease = await groups.assignedPage(f.technicianId, { page: 1, pageSize: 10 });
    expect(afterSiblingRelease.data.map(group => group.id)).not.toContain(f.groupId);
  }, 15000);
});
