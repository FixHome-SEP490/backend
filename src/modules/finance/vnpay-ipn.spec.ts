import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { createRequire } from 'module';
import { resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource, EntityManager } from 'typeorm';
import { FinanceService } from './finance.service';
import { Payment } from './entities/payment.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { VisitGroup } from '../visit-groups/entities/visit-group.entity';
import { VisitGroupItem } from '../visit-groups/entities/visit-group-item.entity';
import { VisitGroupPayment } from '../visit-groups/entities/visit-group-payment.entity';
import { VoucherAudit, VoucherCampaign, VoucherClaim, VoucherReservation } from '../vouchers/entities/voucher.entity';
import { VoucherFundingEntry, VoucherPaymentLink } from '../vouchers/entities/voucher-funding.entity';
import { voucherAllocationDigest } from '../vouchers/voucher-allocation-digest';
import { loadVoucherSettlementFacts } from '../vouchers/voucher-settlement-evidence';
import { VouchersService } from '../vouchers/vouchers.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { User } from '../users/entities/user.entity';
import { Address } from '../users/entities/address.entity';
import { Service } from '../services/entities/service.entity';
import { ServiceCategory } from '../categories/entities/category.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { OrderStatusHistory } from '../service-orders/entities/order-status-history.entity';
import { formatVnpayDate, verifySignature } from './vnpay/vnpay.util';

const secret = 'synthetic-ipn24-hmac-secret';
const merchant = 'TEST2401';
const reservedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 120000);
const initiatedAt = new Date(+reservedAt + 60000);
const expiresAt = new Date(+reservedAt + 900000);
type Scope = 'solo' | 'visit' | 'voucher-solo' | 'voucher-visit';
const scopes: Scope[] = ['solo', 'visit', 'voucher-solo', 'voucher-visit'];
type Fields = Record<string, string | undefined>;

// Independent HMAC construction, then a URL query round trip. Never calls VNPay.
function signed(txnRef: string, amount: number, overrides: Fields = {}): Record<string, string> {
  const fields = Object.fromEntries(Object.entries({
    vnp_TmnCode: merchant, vnp_TxnRef: txnRef, vnp_Amount: String(amount * 100),
    vnp_ResponseCode: '00', vnp_TransactionStatus: '00', vnp_TransactionNo: '240001',
    vnp_PayDate: formatVnpayDate(new Date(+initiatedAt + 1000)), ...overrides,
  }).filter(([, value]) => value !== undefined)) as Record<string, string>;
  const query = Object.keys(fields).sort().map(key =>
    `${key}=${encodeURIComponent(fields[key]).replace(/%20/g, '+')}`).join('&');
  const hash = createHmac('sha512', secret).update(query, 'utf8').digest('hex');
  const parsed = Object.fromEntries(new URLSearchParams(`${query}&vnp_SecureHash=${hash}`));
  // Express can supply arrays. Keep the signed scalar encoding but exercise that runtime shape.
  for (const [key, value] of Object.entries(fields)) if (Array.isArray(value)) parsed[key] = value as unknown as string;
  return parsed;
}

// Storage double only: all callback, allocation, signed-proof, funding and redemption
// code stays real. This deliberately does NOT simulate concurrent PostgreSQL locks.
function memorySource() {
  const tables = new Map<string, any[]>();
  const list = (entity: any) => {
    const name = typeof entity === 'string' ? entity : entity.name;
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  const matches = (row: any, where: any): boolean => !where || (Array.isArray(where)
    ? where.some(filter => matches(row, filter))
    : Object.entries(where).every(([key, value]: [string, any]) => {
      if (value?._type === 'in') return value._value.includes(row[key]);
      // TypeORM's default ignores undefined filters: missing TxnRef must never get here.
      return value === undefined || row[key] === value;
    }));
  const find = async (entity: any, options?: any) => list(entity).filter(row => matches(row, options?.where))
    .map(row => typeof entity === 'string' ? structuredClone(row) : Object.assign(new entity(), structuredClone(row)));
  const findOne = async (entity: any, options: any) => (await find(entity, options))[0] ?? null;
  const save = async (entity: any, value?: any) => {
    if (value === undefined) { value = entity; entity = entity.constructor; }
    value.id ??= randomUUID();
    const rows = list(entity), index = rows.findIndex(row => row.id === value.id);
    if (index < 0) rows.push(structuredClone(value));
    else rows[index] = structuredClone(value);
    return value;
  };
  const update = async (entity: any, where: any, patch: any) => {
    let affected = 0;
    for (const row of list(entity)) if (matches(row, where)) { Object.assign(row, patch); affected++; }
    return { affected };
  };
  const repository = (entity: any) => ({
    find: (options?: any) => find(entity, options), findOne: (options: any) => findOne(entity, options),
    findOneBy: (where: any) => findOne(entity, { where }),
    findOneByOrFail: async (where: any) => {
      const row = await findOne(entity, { where }); if (!row) throw Error('Missing fixture row'); return row;
    },
    create: (value: any) => Object.assign(new entity(), value),
    save: (value: any) => save(entity, value), update: (where: any, patch: any) => update(entity, where, patch),
  });
  const manager = {
    queryRunner: { isTransactionActive: true }, getRepository: repository, find, findOne,
    findBy: (entity: any, where: any) => find(entity, { where }),
    findOneBy: (entity: any, where: any) => findOne(entity, { where }),
    findOneOrFail: async (entity: any, options: any) => {
      const row = await findOne(entity, options); if (!row) throw Error('Missing fixture row'); return row;
    },
    create: (entity: any, value: any) => Object.assign(new entity(), value), save, update,
    count: async (entity: any, options: any) => (await find(entity, options)).length,
    insert: async (entity: any, values: any) => {
      for (const value of Array.isArray(values) ? values : [values]) await save(entity, value);
    },
    query: async (sql: string) => {
      if (sql !== 'SELECT clock_timestamp() AS now') throw Error(`Unexpected fixture SQL: ${sql}`);
      return [{ now: new Date() }];
    },
    createQueryBuilder: () => {
      let groupId: string, exceptId: string, patch: object;
      const builder = {
        update: () => builder, set: (value: object) => { patch = value; return builder; },
        where: (_sql: string, values: any) => { groupId = values.groupId; return builder; },
        andWhere: (_sql: string, values?: any) => { if (values?.exceptId) exceptId = values.exceptId; return builder; },
        execute: async () => {
          for (const row of list(VisitGroupPayment)) if (row.visitGroupId === groupId && row.id !== exceptId &&
            ['pending', 'pending_confirmation'].includes(row.status)) Object.assign(row, patch);
          return { affected: 0 };
        },
      };
      return builder;
    },
  };
  return {
    manager, getRepository: repository,
    transaction: async (work: (value: any) => Promise<any>) => {
      const before = structuredClone(tables);
      try { return await work(manager); } catch (error) {
        tables.clear(); for (const [key, rows] of before) tables.set(key, rows); throw error;
      }
    },
  } as unknown as DataSource;
}

function serviceFor(db: DataSource, Finance = FinanceService, Vouchers = VouchersService,
  evidence = loadVoucherSettlementFacts, auditEntity: any = AuditLog) {
  const vouchers = new Vouchers(db, { settlement: evidence } as any);
  return Object.assign(Object.create(Finance.prototype), {
    dataSource: db, paymentRepository: db.getRepository(Payment.name), vouchersService: vouchers,
    config: { get: (key: string) => key === 'VNPAY_HASH_SECRET' ? secret : key === 'VNPAY_TMN_CODE' ? merchant : undefined },
    auditLogService: { logWithManager: async (manager: EntityManager, value: object) => manager.save(auditEntity, value) },
    logger: { warn: () => undefined, error: () => undefined },
  }) as FinanceService;
}

async function fixture(db: DataSource, scope: Scope) {
  const visit = scope.endsWith('visit'), funded = scope.startsWith('voucher');
  // Names also work with the compiled entities used by the PostgreSQL suite.
  const save = (entity: any, value: any) => db.getRepository(entity.name).save(value);
  const customerId = randomUUID(), groupId = randomUUID(), txnRef = randomUUID();
  const providerReference = BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`).toString();
  const technicianId = randomUUID();
  for (const [id, role] of [[customerId, 'customer'], [technicianId, 'technician']]) {
    await save(User, { id, email: `${id}@example.test`, passwordHash: 'synthetic-no-login', fullName: 'Synthetic IPN24 actor', role, status: 'active' });
  }
  const address = await save(Address, { userId: customerId, line1: 'Synthetic location', province: 'Synthetic', district: 'Synthetic' });
  const category = await save(ServiceCategory, { name: 'Synthetic category', code: randomUUID() });
  const repair = await save(Service, { categoryId: category.id, code: randomUUID(), name: 'Synthetic repair', pricingMode: 'fixed_price', fixedPrice: 100000 });
  const invoices: any[] = [];
  if (visit) await save(VisitGroup, { id: groupId, customerId, addressId: address.id, status: 'submitted',
    bookingMode: 'scheduled', slot: 'morning', preferredStartAt: reservedAt, preferredEndAt: expiresAt, idempotencyKey: randomUUID() });
  for (let n = 0; n < (visit ? 2 : 1); n++) {
    const booking = await save(Booking, { id: randomUUID(), customerId, visitGroupId: visit ? groupId : null,
      serviceId: repair.id, addressId: address.id, description: 'Synthetic IPN24 request',
      status: 'matched', serviceNameSnapshot: 'Synthetic repair' });
    const order = await save(ServiceOrder, { id: randomUUID(), bookingId: booking.id, code: `IPN24-${randomUUID()}`,
      status: 'under_repair', paymentStatus: 'unpaid', completionRequestedAt: initiatedAt });
    await save(TechnicianAssignment, { serviceOrderId: order.id, technicianId, isActive: true });
    invoices.push(await save(Invoice, { id: randomUUID(), serviceOrderId: order.id, grandTotal: 100000,
      laborTotal: 100000, partsTotal: 0, fixHomePartsTotal: 0, technicianPartsTotal: 0,
      technicianPartWarrantyFeeTotal: 0, shippingFee: 0, commissionRateSnapshot: 0.1, commissionAmount: 10000,
      paymentStatus: 'unpaid', paidAt: null }));
    if (visit) await save(VisitGroupItem, { groupId, bookingId: booking.id, serviceId: repair.id, sequence: n + 1, outcome: 'succeeded' });
  }
  const amount = invoices.length * (funded ? 50000 : 100000);
  const attemptEntity = visit ? VisitGroupPayment : Payment;
  const attempt = await save(attemptEntity, { id: randomUUID(), invoiceId: visit ? undefined : invoices[0].id,
    purpose: 'invoice', amount, currency: 'VND', mode: 'LIVE', provider: 'vnpay', rail: 'vnpay',
    visitGroupId: visit ? groupId : undefined, status: 'pending', idempotencyKey: txnRef,
    allocations: invoices.map(invoice => ({ invoiceId: invoice.id, serviceOrderId: invoice.serviceOrderId,
      amount: funded ? 50000 : 100000 })), requestedByUserId: customerId, requestedAt: initiatedAt,
    failureCode: null, verifiedAt: null, providerReference: null });
  let campaignId: string, reservationId: string, linkId: string;
  if (funded) {
    campaignId = randomUUID(); reservationId = randomUUID(); linkId = randomUUID();
    const claimId = randomUUID(), attemptId = randomUUID();
    const policy = { discount: 'FIXED', value: 50000 * invoices.length, capVnd: null, minimumVnd: 0,
      categoryIds: [], serviceIds: [], components: ['LABOR', 'PARTS'] };
    await save(VoucherCampaign, { id: campaignId, code: randomUUID().replace(/-/g, '').toUpperCase(), name: 'Synthetic IPN24', kind: 'GENERAL', policy,
      startsAt: reservedAt, endsAt: expiresAt, active: false, quota: 100, redeemed: 0,
      status: 'DRAFT', version: 1, publishedAt: null });
    await db.getRepository(VoucherCampaign.name).update({ id: campaignId }, {
      status: 'PUBLISHED', version: 2, active: true, publishedAt: reservedAt,
    });
    await save(VoucherClaim, { id: claimId, campaignId, customerId, campaignKind: 'GENERAL', policySnapshot: policy,
      sourceKind: null, sourceId: null, sourceKey: null, redeemedAt: null });
    const scopeId = visit ? groupId : invoices[0].serviceOrderId;
    await save(VoucherReservation, { id: reservationId, campaignId, claimId, customerId, scopeId, attemptId,
      state: 'RESERVED', reservedAt, expiresAt, policySnapshot: policy, settlementId: null,
      checkoutSnapshot: { scopeId, customerId, snapshotId: randomUUID(), eligibleSubtotalVnd: invoices.length * 100000,
        finalized: true, paymentState: 'NOT_STARTED', items: [{ categoryId: category.id, serviceId: repair.id }] } });
    const allocationSnapshot = invoices.map(invoice => ({ invoiceId: invoice.id, originalGrossVnd: 100000,
      eligibleBaseVnd: 100000, subsidyVnd: 50000, customerDueVnd: 50000,
      commissionAmountVnd: 10000, commissionRateSnapshot: 0.1, originalPlatformDueVnd: 10000,
      technicianEntitlementVnd: 90000 }));
    const allocationSha256 = voucherAllocationDigest(allocationSnapshot);
    await save(VoucherPaymentLink, { id: linkId, reservationId, attemptId, customerId, scopeId,
      scopeKind: visit ? 'VISIT_GROUP' : 'SOLO', rail: 'VNPAY', paymentId: visit ? null : attempt.id,
      visitGroupPaymentId: visit ? attempt.id : null, cashSettlementId: null, providerTxnRef: txnRef,
      providerInitiatedAt: initiatedAt, originalGrossVnd: invoices.length * 100000,
      eligibleBaseVnd: invoices.length * 100000, subsidyVnd: invoices.length * 50000, customerDueVnd: amount,
      allocationSnapshot, allocationSha256 });
    await save(VoucherFundingEntry, { linkId, kind: 'PROVIDER_PENDING', amountVnd: 0,
      evidenceSha256: allocationSha256, idempotencyKey: `pending:${linkId}` });
  }
  return { txnRef, amount, invoices, attempt, visit, funded, campaignId, reservationId, linkId, providerReference,
    query: (fields: Fields = {}) => signed(txnRef, amount, { vnp_TransactionNo: providerReference, ...fields }),
    state: () => db.getRepository(attemptEntity.name).findOneByOrFail({ id: attempt.id }),
    entries: () => db.getRepository(VoucherFundingEntry.name).find({ where: { linkId } }),
    invoiceStates: async () => Promise.all(invoices.map(invoice => db.getRepository(Invoice.name).findOneByOrFail({ id: invoice.id }))),
  };
}

async function assertUnchanged(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.state()).toMatchObject({ status: 'pending', failureCode: null, verifiedAt: null });
  expect((await f.invoiceStates()).map(invoice => invoice.paymentStatus)).toEqual(f.invoices.map(() => 'unpaid'));
  if (f.funded) expect((await f.entries()).map(entry => entry.kind)).toEqual(['PROVIDER_PENDING']);
}

async function assertSettled(db: DataSource, f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.state()).toMatchObject({ status: 'verified', failureCode: null, providerReference: f.providerReference });
  expect((await f.invoiceStates()).map(invoice => [invoice.paymentStatus, Number(invoice.grandTotal)]))
    .toEqual(f.invoices.map(() => ['paid', 100000]));
  for (const invoice of f.invoices) {
    expect(await db.getRepository(ServiceOrder.name).findOneByOrFail({ id: invoice.serviceOrderId }))
      .toMatchObject({ status: 'completed', paymentStatus: 'paid' });
    const dues = await db.getRepository(CommissionDue.name).find({ where: { serviceOrderId: invoice.serviceOrderId } });
    expect(dues.map(due => [due.status, Number(due.dueAmount)])).toEqual([['paid', 10000]]);
    expect(await db.getRepository(OrderStatusHistory.name).find({ where: { serviceOrderId: invoice.serviceOrderId, toStatus: 'completed' } }))
      .toHaveLength(1);
  }
  const receipts = await db.getRepository(Payment.name).find({ where: { status: 'verified' } });
  expect(receipts.filter(row => row.id === f.attempt.id || row.idempotencyKey.startsWith(`${f.txnRef}:`)))
    .toHaveLength(f.visit ? f.invoices.length : 1);
  if (f.funded) {
    const entries = await f.entries();
    expect(entries.filter(entry => entry.kind === 'PROVIDER_PAID')).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === 'SUBSIDY_COMMITTED').map(entry => Number(entry.amountVnd)))
      .toEqual(f.invoices.map(() => 50000));
    expect(entries.some(entry => ['PROVIDER_FAILED', 'QUARANTINED'].includes(entry.kind))).toBe(false);
    expect(await db.getRepository(VoucherCampaign.name).findOneByOrFail({ id: f.campaignId })).toMatchObject({ redeemed: 1 });
    expect(await db.getRepository(VoucherReservation.name).findOneByOrFail({ id: f.reservationId })).toMatchObject({ state: 'REDEEMED' });
    expect(await db.getRepository(VoucherAudit.name).find({ where: { action: 'REDEEM', resourceId: f.reservationId } })).toHaveLength(1);
  }
}

const incomplete: [string, Fields][] = [
  ['missing response', { vnp_ResponseCode: undefined }],
  ['missing transaction status', { vnp_TransactionStatus: undefined }],
  ['missing both', { vnp_ResponseCode: undefined, vnp_TransactionStatus: undefined }],
  ['empty response', { vnp_ResponseCode: '' }],
  ['empty transaction status', { vnp_TransactionStatus: '' }],
  ['non-numeric response', { vnp_ResponseCode: 'OK' }],
  ['unknown non-numeric status', { vnp_TransactionStatus: 'UNKNOWN' }],
  ['short response', { vnp_ResponseCode: '0' }],
  ['padded status', { vnp_TransactionStatus: '00 ' }],
  ['newline status', { vnp_TransactionStatus: '00\n' }],
  ['array status', { vnp_TransactionStatus: ['00'] as unknown as string }],
  ['array response', { vnp_ResponseCode: ['00'] as unknown as string }],
];
const failed: Fields = { vnp_ResponseCode: '24', vnp_TransactionStatus: '02', vnp_PayDate: undefined };

describe.each(scopes)('BUG #24 signed IPN %s', scope => {
  it.each(incomplete)('%s leaves no false failure/evidence; later success settles exactly once', async (_name, fields) => {
    const db = memorySource(), service = serviceFor(db), f = await fixture(db, scope);
    const malformed = f.query(fields);
    expect(verifySignature(malformed, secret)).toBe(true);
    // State assertions precede response assertions so RED proves the financial bug.
    const result = await service.handleVnpayIpn(malformed);
    await assertUnchanged(f);
    expect(result.RspCode).toBe('99');
    expect((await service.handleVnpayIpn(f.query())).RspCode).toBe('00');
    await service.handleVnpayIpn(f.query());
    expect((await service.handleVnpayIpn(malformed)).RspCode).toBe('99');
    await assertSettled(db, f);
  });

  it('accepts signed 00/00 once; repeated success never duplicates settlement', async () => {
    const db = memorySource(), service = serviceFor(db), f = await fixture(db, scope);
    expect((await service.handleVnpayIpn(f.query())).RspCode).toBe('00');
    await service.handleVnpayIpn(f.query());
    await assertSettled(db, f);
  });

  it('records genuine failure once; later conflicting success never pays or redeems', async () => {
    const db = memorySource(), service = serviceFor(db), f = await fixture(db, scope);
    expect((await service.handleVnpayIpn(f.query(failed))).RspCode).toBe('00');
    await service.handleVnpayIpn(f.query(failed));
    await service.handleVnpayIpn(f.query());
    expect(await f.state()).toMatchObject({ status: 'failed', failureCode: 'VNPAY_24' });
    expect((await f.invoiceStates()).every(invoice => invoice.paymentStatus === 'unpaid')).toBe(true);
    if (f.funded) {
      expect((await f.entries()).filter(entry => entry.kind === 'PROVIDER_FAILED')).toHaveLength(1);
      expect((await f.entries()).some(entry => ['PROVIDER_PAID', 'SUBSIDY_COMMITTED'].includes(entry.kind))).toBe(false);
    }
  });

  it('does not downgrade settled money when a failure arrives afterwards', async () => {
    const db = memorySource(), service = serviceFor(db), f = await fixture(db, scope);
    await service.handleVnpayIpn(f.query());
    await service.handleVnpayIpn(f.query(failed));
    expect(await f.state()).toMatchObject({ status: 'verified', failureCode: null });
    expect((await f.invoiceStates()).every(invoice => invoice.paymentStatus === 'paid')).toBe(true);
    if (f.funded) {
      expect((await f.entries()).filter(entry => entry.kind === 'SUBSIDY_COMMITTED')).toHaveLength(f.invoices.length);
      expect(await db.getRepository(VoucherCampaign).findOneByOrFail({ id: f.campaignId })).toMatchObject({ redeemed: 1 });
    }
  });

  it.each(['signature', 'amount', 'missing txn ref', 'empty txn ref', 'unknown txn ref'])(
    'rejects %s without settlement', async invalid => {
      const db = memorySource(), service = serviceFor(db), f = await fixture(db, scope);
      const query = f.query(invalid === 'amount' ? { vnp_Amount: '100' }
        : invalid === 'missing txn ref' ? { vnp_TxnRef: undefined }
          : invalid === 'empty txn ref' ? { vnp_TxnRef: '' }
            : invalid === 'unknown txn ref' ? { vnp_TxnRef: randomUUID() } : {});
      if (invalid === 'signature') query.vnp_SecureHash = '0'.repeat(128);
      const result = await service.handleVnpayIpn(query);
      // KNOWN_F4_WRONG_AMOUNT_RESPONSE: voucher returns 00 instead of 04.
      // Outside #24; provider response/ledger remediation needs the finance owner gate.
      if (invalid !== 'amount' || !f.funded) {
        expect(result.RspCode).toBe(invalid === 'signature' ? '97' : invalid.includes('txn ref') ? '01' : '04');
      }
      expect((await f.state()).status).toBe('pending');
      expect((await f.invoiceStates()).every(invoice => invoice.paymentStatus === 'unpaid')).toBe(true);
      if (f.funded) expect((await f.entries()).some(entry => ['PROVIDER_PAID', 'SUBSIDY_COMMITTED'].includes(entry.kind))).toBe(false);
    });

  it('never routes a signed VNPay callback to a wallet/cash attempt', async () => {
    const db = memorySource(), service = serviceFor(db), f = await fixture(db, scope);
    await db.getRepository(f.visit ? 'VisitGroupPayment' : 'Payment').update({ id: f.attempt.id }, f.visit ? { rail: 'cash' } : { provider: 'wallet' });
    expect((await service.handleVnpayIpn(f.query())).RspCode).toBe('01');
    await assertUnchanged(f);
  });

  it('characterizes numeric unknown status without introducing a new provider rule', async () => {
    const db = memorySource(), service = serviceFor(db), f = await fixture(db, scope);
    await service.handleVnpayIpn(f.query({ vnp_ResponseCode: '99', vnp_TransactionStatus: '99', vnp_PayDate: undefined }));
    // Existing legacy semantics differ from F4 quarantine. Changing this requires the owner gate.
    expect((await f.state()).status).toBe(f.funded ? 'pending' : 'failed');
    expect((await f.invoiceStates()).every(invoice => invoice.paymentStatus === 'unpaid')).toBe(true);
    if (f.funded) expect((await f.entries()).map(entry => entry.kind)).toEqual(['PROVIDER_PENDING', 'QUARANTINED']);
  });
});

// Explicit opt-in, fixed localhost identity, no AppModule/dotenv or project data source.
// Run against a new postgres:16 container after compiling the backend.
const pgPort = Number(process.env.F1_IPN24_DISPOSABLE_POSTGRES_PORT);
describe.skipIf(!pgPort)('BUG #24 isolated PG16 concurrent/reordered callbacks', () => {
  let db: DataSource;
  let service: FinanceService;
  beforeAll(async () => {
    if (!Number.isInteger(pgPort) || pgPort < 1024 || pgPort > 65535) throw Error('Invalid isolated PostgreSQL port');
    const runtime = createRequire(resolve('package.json'));
    const load = (file: string, symbol: string) => runtime(`./dist/modules/${file}.js`)[symbol];
    db = new DataSource({ type: 'postgres', host: '127.0.0.1', port: pgPort, username: 'fixhome_f1_test',
      password: 'disposable_f1_only', database: 'fixhome_f1_disposable',
      entities: [resolve('dist/**/*.entity.js')], migrations: [resolve('dist/database/migrations/*.js')],
      synchronize: false, logging: false, extra: { max: 12, options: '-c lock_timeout=5000 -c statement_timeout=15000' } });
    await db.initialize();
    expect((await db.query('SELECT current_database() AS db, current_user AS usr'))[0])
      .toEqual({ db: 'fixhome_f1_disposable', usr: 'fixhome_f1_test' });
    expect((await db.query('SHOW server_version'))[0].server_version).toMatch(/^16\./);
    await db.runMigrations();
    service = serviceFor(db, load('finance/finance.service', 'FinanceService'), load('vouchers/vouchers.service', 'VouchersService'),
      load('vouchers/voucher-settlement-evidence', 'loadVoucherSettlementFacts'), load('audit-log/entities/audit-log.entity', 'AuditLog'));
  }, 60000);
  afterAll(async () => { if (db?.isInitialized) await db.destroy(); });

  it.each(scopes)('%s serializes malformed + duplicate success without double settlement', async scope => {
    const f = await fixture(db, scope);
    const results = await Promise.all([
      service.handleVnpayIpn(f.query({ vnp_ResponseCode: undefined })),
      service.handleVnpayIpn(f.query({ vnp_TransactionStatus: undefined })),
      ...Array.from({ length: 4 }, () => service.handleVnpayIpn(f.query())),
    ]);
    expect(results.slice(0, 2).map(result => result.RspCode)).toEqual(['99', '99']);
    await assertSettled(db, f);
  }, 60000);

  it.each(scopes)('%s ignores each incomplete replay before a later success', async scope => {
    const f = await fixture(db, scope);
    for (const fields of [
      { vnp_ResponseCode: undefined }, { vnp_TransactionStatus: undefined },
      { vnp_ResponseCode: undefined, vnp_TransactionStatus: undefined },
    ]) {
      expect((await service.handleVnpayIpn(f.query(fields))).RspCode).toBe('99');
      await assertUnchanged(f);
    }
    await Promise.all(Array.from({ length: 4 }, () => service.handleVnpayIpn(f.query())));
    await assertSettled(db, f);
  }, 60000);

  it.each(scopes)('%s keeps a repeated genuine failure terminal when success arrives later', async scope => {
    const f = await fixture(db, scope);
    await Promise.all(Array.from({ length: 4 }, () => service.handleVnpayIpn(f.query(failed))));
    await service.handleVnpayIpn(f.query());
    expect(await f.state()).toMatchObject({ status: 'failed', failureCode: 'VNPAY_24' });
    expect((await f.invoiceStates()).every(invoice => invoice.paymentStatus === 'unpaid')).toBe(true);
    for (const invoice of f.invoices) {
      expect(await db.getRepository(CommissionDue.name).find({ where: { serviceOrderId: invoice.serviceOrderId } })).toHaveLength(0);
    }
    if (f.funded) {
      const entries = await f.entries();
      expect(entries.filter(entry => entry.kind === 'PROVIDER_FAILED')).toHaveLength(1);
      expect(entries.some(entry => ['PROVIDER_PAID', 'SUBSIDY_COMMITTED'].includes(entry.kind))).toBe(false);
      expect(await db.getRepository(VoucherCampaign.name).findOneByOrFail({ id: f.campaignId })).toMatchObject({ redeemed: 0 });
    }
  }, 60000);

  it.each(scopes)('%s retains one settlement when repeated failure follows success', async scope => {
    const f = await fixture(db, scope);
    await service.handleVnpayIpn(f.query());
    await assertSettled(db, f);
    await Promise.all(Array.from({ length: 4 }, () => service.handleVnpayIpn(f.query(failed))));
    expect(await f.state()).toMatchObject({ status: 'verified', failureCode: null });
    expect((await f.invoiceStates()).every(invoice => invoice.paymentStatus === 'paid')).toBe(true);
    if (f.funded) {
      expect((await f.entries()).filter(entry => entry.kind === 'SUBSIDY_COMMITTED')).toHaveLength(f.invoices.length);
      expect((await f.entries()).filter(entry => entry.kind === 'PROVIDER_FAILED')).toHaveLength(0);
      expect(await db.getRepository(VoucherCampaign.name).findOneByOrFail({ id: f.campaignId })).toMatchObject({ redeemed: 1 });
    }
  }, 60000);
});
