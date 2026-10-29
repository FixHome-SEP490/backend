import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { BookingsService } from './bookings.service';
import { VisitGroupsService } from '../visit-groups/visit-groups.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianReportService } from '../support-cases/technician-report.service';
import { QuotationsService } from '../quotations/quotations.service';
import { ServiceOrdersService } from '../service-orders/service-orders.service';
import { Booking } from './entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { Address } from '../users/entities/address.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { Quotation } from '../quotations/entities/quotation.entity';
import { InterruptionRebook, InterruptionRebookSource } from './entities/interruption-rebook.entity';
// @ts-ignore Vitest transforms this eager glob; the backend runtime compiles as CommonJS.
const entityModules = import.meta.glob('../../**/*.entity.ts', { eager: true });

const url = process.env.T2QA_ONSITE_TEST_URL;
const allowed = url && (() => {
  const parsed = new URL(url);
  return parsed.hostname === '127.0.0.1' && parsed.port === '55438'
    && parsed.pathname === '/fixhome_t2_onsite' && parsed.username === 'platform_t2';
})();
if (url && !allowed) throw new Error('Refusing a database other than the isolated onsite-interruption QA database');

describe.skipIf(!allowed)('verified onsite interruption PostgreSQL transactions', () => {
  let dataSource: DataSource;
  let reports: TechnicianReportService;
  let bookings: BookingsService;
  let quotes: QuotationsService;
  let orders: ServiceOrdersService;
  beforeAll(async () => {
    dataSource = new DataSource({ type: 'postgres', url,
      entities: Object.values(entityModules).flatMap(module => Object.values(module as Record<string, unknown>))
        .filter((value): value is new () => object => typeof value === 'function'),
      synchronize: false, logging: false });
    await dataSource.initialize();
    const config = { getInt: async (_: string, fallback: number) => fallback, getString: async () => 'true' };
    const audit = new AuditLogService({} as never);
    reports = new TechnicianReportService(dataSource, audit, {} as never);
    bookings = Object.assign(Object.create(BookingsService.prototype), {
      dataSource, userRepo: dataSource.getRepository(User), serviceRepo: dataSource.getRepository(Service),
      addressRepo: dataSource.getRepository(Address), auditLogService: audit, configService: config,
    }) as BookingsService;
    quotes = Object.assign(Object.create(QuotationsService.prototype), {
      dataSource, quotationRepo: dataSource.getRepository(Quotation), configService: config,
      auditLogService: audit, partRequestsService: {} as never,
    }) as QuotationsService;
    orders = Object.assign(Object.create(ServiceOrdersService.prototype), {
      dataSource, configService: config, auditLogService: audit,
    }) as ServiceOrdersService;
  });
  afterAll(async () => { if (dataSource?.isInitialized) await dataSource.destroy(); });

  async function fixture(options: { status?: string; quote?: boolean; evidence?: boolean } = {}) {
    const customerId = randomUUID(); const technicianId = randomUUID();
    const categoryId = randomUUID(); const serviceId = randomUUID(); const addressId = randomUUID();
    const bookingId = randomUUID(); const orderId = randomUUID();
    const status = options.status ?? 'under_repair';
    await dataSource.query(`INSERT INTO users (id,email,password_hash,full_name,role) VALUES ($1,$2,'qa','QA customer','customer'),($3,$4,'qa','QA technician','technician')`,
      [customerId, `${customerId}@qa.invalid`, technicianId, `${technicianId}@qa.invalid`]);
    await dataSource.query(`INSERT INTO service_categories (id,name,code) VALUES ($1,'QA category',$2)`, [categoryId, `QA-${categoryId}`]);
    await dataSource.query(`INSERT INTO services (id,category_id,name,code,pricing_mode,fixed_price,is_active) VALUES ($1,$2,'QA fixed service',$3,'fixed_price',199000,true)`,
      [serviceId, categoryId, `QA-${serviceId}`]);
    await dataSource.query(`INSERT INTO addresses (id,user_id,line1,district,province,lat,lng) VALUES ($1,$2,'QA address','Quận 1','Hồ Chí Minh',10.1,106.1)`,
      [addressId, customerId]);
    await dataSource.query(`INSERT INTO bookings (id,customer_id,service_id,address_id,description,status,booking_mode,slot,quantity,pricing_mode_snapshot,fixed_unit_price_snapshot,preferred_start_at,preferred_end_at) VALUES ($1,$2,$3,$4,'Old device','matched','scheduled','afternoon',1,'fixed_price',199000,'2030-10-29T06:00:00Z','2030-10-29T10:00:00Z')`,
      [bookingId, customerId, serviceId, addressId]);
    await dataSource.query(`INSERT INTO service_orders (id,booking_id,code,status,payment_status,labor_total,parts_total,grand_total) VALUES ($1,$2,$3,$4,'unpaid',199000,0,199000)`,
      [orderId, bookingId, `QA-${orderId}`, status]);
    await dataSource.query(`INSERT INTO technician_assignments (service_order_id,technician_id,is_active,assigned_at) VALUES ($1,$2,true,now() - interval '2 hours')`,
      [orderId, technicianId]);
    await dataSource.query(`INSERT INTO arrival_check_ins (service_order_id,technician_id,lat,lng,accuracy_meters,result,checked_in_at) VALUES ($1,$2,10.1,106.1,5,'valid',now() - interval '1 hour')`,
      [orderId, technicianId]);
    if (options.evidence) await dataSource.query(`INSERT INTO repair_evidences (service_order_id,uploader_id,type,media_url,mime_type) VALUES ($1,$2,'after','https://qa.invalid/after.jpg','image/jpeg')`,
      [orderId, technicianId]);
    if (options.quote) await dataSource.query(`INSERT INTO quotations (id,service_order_id,technician_id,status,sent_at) VALUES ($1,$2,$3,'sent',now())`,
      [randomUUID(), orderId, technicianId]);
    const request = { commandId: randomUUID(), reasonClass: 'technician_skill_gap', reasonCode: 'skill_gap',
      reason: 'Synthetic onsite inability to complete repair', photoEvidenceIds: [] as string[] };
    const technician = { id: technicianId, role: 'technician' };
    const customer = { id: customerId, role: 'customer' };
    const cannotContinue = (body = request) => reports.cannotContinue(orderId, body as never, technician);
    const confirmBody = async () => {
      const caseRows: Array<{ id: string }> = await dataSource.query(`SELECT id FROM support_cases WHERE service_order_id=$1`, [orderId]);
      return { idempotencyKey: `qa-onsite-${randomUUID()}`, addressId, date: '2030-10-30', slot: 'afternoon' as const,
        items: [{ sourceBookingId: bookingId, sourceCaseId: caseRows[0].id }] };
    };
    const confirm = async (body?: { idempotencyKey: string; addressId: string; date: string; slot: string; items: Array<{ sourceBookingId: string; sourceCaseId: string }> }, anchor = bookingId) => {
      const input = body ?? await confirmBody();
      return bookings.confirmInterruptionRebook(anchor, input as never, customer,
        (dto, owner, manager) => (Object.assign(Object.create(VisitGroupsService.prototype), {
          dataSource, bookingsService: bookings,
        }) as VisitGroupsService).create(dto, owner, manager));
    };
    return { customerId, technicianId, serviceId, addressId, bookingId, orderId, request, customer, technician,
      cannotContinue, confirm, confirmBody };
  }

  const settle = async <T>(pending: Promise<T>) => {
    try { return { ok: true as const, value: await pending }; }
    catch (error) { return { ok: false as const, error: error as { code?: string; status?: number; message?: string } }; }
  };
  const noDeadlock = (...results: Array<{ error?: { code?: string } }>) =>
    expect(results.map(result => result.error?.code)).not.toEqual(expect.arrayContaining(['40P01', '40P02']));

  it('serializes the same command into one incident and one strict receipt', async () => {
    const f = await fixture();
    const [left, right] = await Promise.all([f.cannotContinue(), f.cannotContinue()]);
    expect(right).toEqual(left);
    expect(await dataSource.query(`SELECT count(*)::int AS n FROM support_cases WHERE service_order_id=$1`, [f.orderId]))
      .toEqual([{ n: 1 }]);
    expect(await dataSource.query(`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id=$1 AND action='TECHNICIAN_CANNOT_CONTINUE_ONSITE'`, [f.orderId]))
      .toEqual([{ n: 1 }]);
  }, 15000);

  it('refuses two different commands for the same order without a second outcome', async () => {
    const f = await fixture();
    const [left, right] = await Promise.all([settle(f.cannotContinue()),
      settle(f.cannotContinue({ ...f.request, commandId: randomUUID() }))]);
    noDeadlock(left, right);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect(await dataSource.query(`SELECT count(*)::int AS n FROM support_cases WHERE service_order_id=$1`, [f.orderId]))
      .toEqual([{ n: 1 }]);
  }, 15000);

  it('serializes a concurrent customer quote rejection against the onsite stop without a deadlock', async () => {
    const f = await fixture({ status: 'en_route', quote: true });
    const quoteRow: Array<{ id: string }> = await dataSource.query(`SELECT id FROM quotations WHERE service_order_id=$1`, [f.orderId]);
    const [stop, reject] = await Promise.all([
      settle(f.cannotContinue()),
      settle(quotes.decideQuotation(quoteRow[0].id, 'REJECT', f.customer)),
    ]);
    noDeadlock(stop, reject);
    const cases: Array<{ n: number }> = await dataSource.query(`SELECT count(*)::int AS n FROM support_cases WHERE service_order_id=$1`, [f.orderId]);
    const order: Array<{ status: string }> = await dataSource.query(`SELECT status FROM service_orders WHERE id=$1`, [f.orderId]);
    expect(cases[0].n + (order[0].status === 'cancelled' ? 1 : 0)).toBe(1);
    expect(await dataSource.query(`SELECT count(*)::int AS n FROM invoices WHERE service_order_id=$1`, [f.orderId])).toEqual([{ n: 0 }]);
    expect(await dataSource.query(`SELECT count(*)::int AS n FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.service_order_id=$1`, [f.orderId])).toEqual([{ n: 0 }]);
  }, 20000);

  it('serializes completion request against the onsite stop without a deadlock or dual outcome', async () => {
    const f = await fixture({ evidence: true });
    const [stop, completion] = await Promise.all([
      settle(f.cannotContinue()),
      settle(orders.requestCompletion(f.orderId, {}, f.technician)),
    ]);
    noDeadlock(stop, completion);
    const cases: Array<{ n: number }> = await dataSource.query(`SELECT count(*)::int AS n FROM support_cases WHERE service_order_id=$1`, [f.orderId]);
    const order: Array<{ completion_requested_at: Date | null }> = await dataSource.query(`SELECT completion_requested_at FROM service_orders WHERE id=$1`, [f.orderId]);
    expect([cases[0].n === 1, order[0].completion_requested_at != null].filter(Boolean)).toHaveLength(1);
  }, 20000);

  it('serializes concurrent confirms of one idempotency key into one target and receipt', async () => {
    const f = await fixture(); await f.cannotContinue();
    const body = await f.confirmBody();
    const [left, right] = await Promise.all([f.confirm(body), f.confirm(body)]);
    expect(right).toEqual(left);
    expect(await dataSource.getRepository(InterruptionRebook).count({ where: { customerId: f.customerId } })).toBe(1);
    expect(await dataSource.getRepository(InterruptionRebookSource).count({ where: { sourceBookingId: f.bookingId } })).toBe(1);
    expect(await dataSource.getRepository(Booking).count({ where: { customerId: f.customerId } })).toBe(2);
  }, 20000);

  it('allows only one of two concurrent confirmations with different keys and keeps the source closed', async () => {
    const f = await fixture(); await f.cannotContinue();
    const [left, right] = await Promise.all([
      settle(f.confirm(await f.confirmBody())),
      settle(f.confirm(await f.confirmBody())),
    ]);
    noDeadlock(left, right);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect(await dataSource.getRepository(InterruptionRebook).count({ where: { customerId: f.customerId } })).toBe(1);
    expect(await dataSource.getRepository(InterruptionRebookSource).count({ where: { sourceBookingId: f.bookingId } })).toBe(1);
    expect(await dataSource.getRepository(Booking).count({ where: { customerId: f.customerId } })).toBe(2);
  }, 20000);
});
