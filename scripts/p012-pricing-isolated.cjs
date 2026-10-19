'use strict';
// Own disposable PostgreSQL only. No dotenv/project data-source/preview credentials.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
require('reflect-metadata');
const { DataSource } = require('typeorm');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { PassportModule } = require('@nestjs/passport');
const { JwtModule, JwtService } = require('@nestjs/jwt');
const { ConfigService } = require('@nestjs/config');
const { getRepositoryToken } = require('@nestjs/typeorm');
const request = require('supertest');
const root = path.resolve(__dirname, '..');
const load = p => require(path.join(root, 'dist', p));
const symbol = (p, s) => load(p)[s];
const docker = (...args) => cp.execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, windowsHide: true }).trim();
let container, db, app;

async function run() {
  assert.equal(fs.existsSync(path.join(root, '.env')), false, 'Refuse harness when repository .env exists');
  process.env.NODE_ENV = 'test';
  process.env.P1_CUSTODY_ENABLED = 'false';
  process.env.BACKGROUND_JOBS_INTERVAL_MS = '0';
  const password = crypto.randomBytes(24).toString('hex');
  container = docker('run', '-d', '--rm', '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=p012_pricing_test',
    '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=p012_pricing_disposable', 'postgres:16-alpine');
  assert.match(container, /^[a-f\d]{64}$/);
  const identity = JSON.parse(docker('inspect', container))[0];
  assert.equal(identity.Config.Image, 'postgres:16-alpine');
  const bindings = identity.NetworkSettings.Ports['5432/tcp'];
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].HostIp, '127.0.0.1');
  const port = Number(bindings[0].HostPort);
  for (let i = 0; i < 60; i++) {
    if (cp.spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'p012_pricing_test'], { stdio: 'ignore', windowsHide: true }).status === 0) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const connection = { type: 'postgres', host: '127.0.0.1', port, username: 'p012_pricing_test', password,
    database: 'p012_pricing_disposable', ssl: false, synchronize: false, entities: [path.join(root, 'dist/**/*.entity.js')] };
  const migrations = fs.readdirSync(path.join(root, 'dist/database/migrations')).filter(f => f.endsWith('.js'))
    .flatMap(f => Object.values(load(`database/migrations/${f}`))).filter(v => typeof v === 'function');
  const newName = 'BookingCatalogV2Pricing1790000000040';
  db = new DataSource({ ...connection, migrations: migrations.filter(m => m.name !== newName) });
  await db.initialize();
  assert.deepEqual((await db.query('SELECT current_database() AS db, current_user AS usr'))[0],
    { db: 'p012_pricing_disposable', usr: 'p012_pricing_test' });
  const baseline = await db.runMigrations();
  const repo = name => db.getRepository(name);
  const customer = await repo('User').save({ email: 'pricing@example.test', passwordHash: 'synthetic-no-login',
    fullName: 'Synthetic pricing customer', role: 'customer', status: 'active', isActive: true });
  const category = await repo('ServiceCategory').save({ code: 'SYNTHETIC_LEGACY', name: 'Synthetic legacy', isActive: true });
  const legacyService = await repo('Service').save({ categoryId: category.id, code: 'VE_SINH_DIEU_HOA_1HP',
    name: 'Synthetic legacy', pricingMode: 'fixed_price', fixedPrice: 175000, scopeDescription: 'Legacy scope', isActive: true });
  const address = await repo('Address').save({ userId: customer.id, line1: 'Synthetic fixture', province: 'Synthetic', district: 'Synthetic', lat: 10.77, lng: 106.69 });
  // Pre-migration row proves additive upgrade preserves legacy pricing/media/AI data.
  const [old] = await db.query(`INSERT INTO bookings (customer_id, service_id, address_id, description, pricing_mode_snapshot, fixed_unit_price_snapshot, scope_snapshot)
    VALUES ($1,$2,$3,'Synthetic legacy','fixed_price',175000,'Legacy scope') RETURNING id`, [customer.id, legacyService.id, address.id]);
  await db.query(`INSERT INTO fixhome_parts (sku,name,selling_price,warranty_days,warranty_policy)
    SELECT 'SYNTHETIC-' || n, 'Synthetic part ' || n, 100000,90,'Synthetic' FROM generate_series(1,792) n`);
  const partsBefore = await db.query('SELECT * FROM fixhome_parts ORDER BY id');
  await db.destroy();
  db = new DataSource({ ...connection, migrations });
  await db.initialize();
  assert.deepEqual((await db.runMigrations()).map(m => m.name), [newName]);
  assert.deepEqual(await db.runMigrations(), []);
  const oldAfter = await repo('Booking').findOneByOrFail({ id: old.id });
  assert.equal(oldAfter.catalogV2PricingSnapshot, null);
  assert.equal(Number(oldAfter.fixedUnitPriceSnapshot), 175000);
  const { stageCatalogV2Inactive } = load('database/catalog-v2/catalog-v2-stage-inactive.js');
  assert.deepEqual(await stageCatalogV2Inactive(db), { categories: 13, services: 36, priceVariants: 28, aliases: 34 });
  assert.equal((await db.query('SELECT count(*)::int n FROM service_price_variants WHERE is_active'))[0].n, 0);
  const catalog = load('database/catalog-v2/catalog-v2-review.js').CATALOG_V2_SERVICES;
  const tiers = load('database/catalog-v2/catalog-v2-approved-price-tiers.js').CATALOG_V2_APPROVED_FIXED_TIERS;
  const { ServicesService } = load('modules/services/services.service.js');
  const services = new ServicesService(repo('Service'), repo('ServiceCategory'));
  const { BookingsService } = load('modules/bookings/bookings.service.js');
  const audit = { log: async () => {}, logWithManager: async () => {} };
  const config = { getInt: async (_, fallback) => fallback };
  const bookings = new BookingsService(repo('Booking'), repo('BookingMedia'), repo('User'), repo('Service'), repo('Address'),
    repo('TechnicianProfile'), repo('TechnicianSkill'), audit, db, { claim: async () => { throw Error('Unexpected provider'); } }, config);
  const { InvitationsService } = load('modules/bookings/invitations.service.js');
  const invitations = new InvitationsService(repo('BookingInvitation'), repo('Booking'), db, config, audit,
    { ensureConversation: async () => undefined, attachToServiceOrder: async () => undefined });
  const { RbacService } = load('modules/rbac/rbac.service.js');
  // Real database role/permission checks; no authorization guard overrides.
  for (const [roleCode, permissions] of [['customer', ['booking:create', 'booking:read_own', 'invitation:shortlist']], ['technician', ['invitation:respond']]]) {
    let role = await repo('RoleEntity').findOneBy({ code: roleCode });
    if (!role) role = await repo('RoleEntity').save({ code: roleCode, name: roleCode });
    for (const code of permissions) {
      let permission = await repo('Permission').findOneBy({ code });
      if (!permission) permission = await repo('Permission').save({ code, resource: code.split(':')[0], action: code.split(':')[1] });
      await repo('RolePermission').save({ roleId: role.id, permissionId: permission.id });
    }
  }
  const rbac = new RbacService(repo('RolePermission'), repo('UserScope'));
  const { JwtStrategy } = load('modules/auth/strategies/jwt.strategy.js');
  const secret = crypto.randomBytes(32).toString('hex');
  const module = await Test.createTestingModule({ imports: [PassportModule, JwtModule.register({ secret })],
    controllers: [symbol('modules/services/services.controller.js', 'ServicesController'), symbol('modules/bookings/bookings.controller.js', 'BookingsController'),
      symbol('modules/bookings/invitations.controller.js', 'InvitationsController')],
    providers: [JwtStrategy,
      { provide: getRepositoryToken(symbol('modules/users/entities/user.entity.js', 'User')), useValue: repo('User') },
      { provide: ConfigService, useValue: new ConfigService({ JWT_ACCESS_SECRET: secret }) },
      { provide: RbacService, useValue: rbac }, { provide: ServicesService, useValue: services },
      { provide: BookingsService, useValue: bookings }, { provide: InvitationsService, useValue: invitations },
      { provide: symbol('modules/bookings/booking-private-media-content.service.js', 'BookingPrivateMediaContentService'), useValue: {} }] }).compile();
  app = module.createNestApplication();
  app.useLogger(false);
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalInterceptors(new (symbol('common/interceptors/transform.interceptor.js', 'TransformInterceptor'))());
  app.useGlobalFilters(new (symbol('common/filters/http-exception.filter.js', 'HttpExceptionFilter'))());
  await app.init();
  const http = () => request(app.getHttpServer());
  const token = module.get(JwtService).sign({ sub: customer.id, role: customer.role });
  const date = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const payload = { serviceId: legacyService.id, addressId: address.id, description: 'Synthetic pricing request', mode: 'scheduled', date, slot: 'morning' };
  const post = (body, expected = 201) => http().post('/api/v1/bookings').auth(token, { type: 'bearer' }).send(body).expect(expected);
  const serviceRows = await repo('Service').find();
  const idFor = code => serviceRows.find(s => s.code === code).id;
  const get = (code, query = {}, expected = 200) => http().get(`/api/v1/services/${idFor(code)}/catalog-v2-pricing`).query(query).expect(expected);
  await get('AC-02', {}, 404);
  // Selective M1/M2 activation ONLY in this disposable database after unit gates.
  const openCodes = catalog.filter(s => ['M1', 'M2'].includes(s.phase)).map(s => s.code);
  await db.query('UPDATE service_categories SET is_active = true WHERE id IN (SELECT category_id FROM services WHERE code = ANY($1))', [openCodes]);
  await db.query('UPDATE services SET is_active = true WHERE code = ANY($1)', [openCodes]);
  await db.query('UPDATE service_price_variants SET is_active = true WHERE service_id IN (SELECT id FROM services WHERE code = ANY($1))', [openCodes]);
  const facts = code => code === 'AC-02-01' ? { acMounting: 'wall', acHorsepower: 'up_to_1_5' }
    : code === 'AC-02-02' ? { acMounting: 'wall', acHorsepower: '2_to_2_5' }
      : code === 'AC-02-03' ? { acMounting: 'ceiling' }
        : code.startsWith('WM-02') ? { washerLoadingStyle: ['WM-02-05','WM-02-06'].includes(code) ? 'top' : 'front',
          washerCapacityKg: ['WM-02-05','WM-02-07'].includes(code) ? 9 : 9.1 } : undefined;
  let fixedBooking;
  for (const tier of tiers) {
    const deviceAttributes = facts(tier.variantCode);
    const preview = await get(tier.serviceCode, { selectedVariantCode: tier.variantCode, ...deviceAttributes });
    assert.equal(preview.body.data.status, 'FIXED_PRICE');
    assert.deepEqual(preview.body.data.missingAttributes, []);
    assert.equal(preview.body.data.priceBinding, false);
    assert.equal(preview.body.data.selectedVariant.laborPriceVnd, tier.laborPriceVnd);
    const response = await post({ ...payload, serviceId: idFor(tier.serviceCode), selectedVariantCode: tier.variantCode, deviceAttributes });
    const b = response.body.data;
    assert.equal(b.pricingModeSnapshot, 'fixed_price');
    assert.equal(Number(b.fixedUnitPriceSnapshot), tier.laborPriceVnd);
    assert.equal(b.scopeSnapshot, tier.conditionVi);
    assert.equal(b.catalogV2PricingSnapshot.selectedVariant.variantCode, tier.variantCode);
    assert.equal(b.catalogV2PricingSnapshot.priceBinding, true);
    assert.deepEqual(b.catalogV2PricingSnapshot.missingAttributes, []);
    const persisted = await repo('Booking').findOneByOrFail({ id: b.id });
    assert.deepEqual(persisted.catalogV2PricingSnapshot, b.catalogV2PricingSnapshot);
    if (tier.variantCode === 'AC-02-01') fixedBooking = b;
  }
  for (const code of openCodes) {
    const fallback = (await post({ ...payload, serviceId: idFor(code) })).body.data;
    assert.equal(fallback.pricingModeSnapshot, 'inspection_required');
    assert.equal(fallback.fixedUnitPriceSnapshot, null);
    assert.equal(fallback.catalogV2PricingSnapshot.selectedVariant, null);
  }
  assert.deepEqual((await get('AC-02')).body.data.priceRange, { minLaborVnd: 199000, maxLaborVnd: 449000, labelVi: 'Giá tham khảo', priceBinding: false });
  assert.equal((await get('AC-02', { acMounting: 'ceiling' })).body.data.bindingReady, false);
  assert.equal((await get('WM-02', { washerLoadingStyle: 'front', washerCapacityKg: '9.1' })).body.data.selectedVariant.variantCode, 'WM-02-08');
  await get('AC-02', { selectedVariantCode: 'WM-02-05' }, 400);
  await get('AC-02', { selectedVariantCode: 'AC-02-01', acMounting: 'wall', acHorsepower: '2_to_2_5' }, 400);
  await get('AC-03', { selectedVariantCode: 'AC-03-04', acMounting: 'ceiling' }, 400);
  await get('WM-02', { washerCapacityKg: '9.01' }, 400);
  await get('AC-02', { fixedPrice: 1 }, 400);
  await get('AC-02', { selectedVariantCode: 'AC-02-01', variantCode: 'AC-02-02' }, 400);
  await http().get('/api/v1/services/invalid/catalog-v2-pricing').expect(400);
  await http().post('/api/v1/bookings').send(payload).expect(401);
  await post({ ...payload, serviceId: idFor('AC-02'), selectedVariantCode: 'WM-02-05' }, 400);
  await post({ ...payload, fixedPrice: 1 }, 400);
  const legacy = (await post({ ...payload, mediaUrls: ['https://example.test/synthetic.jpg'], deviceAttributes: { acMounting: 'wall' } })).body.data;
  assert.equal(Number(legacy.fixedUnitPriceSnapshot), 175000);
  assert.equal(legacy.media[0].url, 'https://example.test/synthetic.jpg');
  assert.equal(legacy.aiSummary, null);
  await post({ ...payload, variantCode: 'AC-02-01' }, 422);
  await db.query('UPDATE service_price_variants SET is_active = false WHERE variant_code = $1', ['AC-02-01']);
  await get('AC-02', { selectedVariantCode: 'AC-02-01' }, 400);
  const inactive = (await post({ ...payload, serviceId: idFor('AC-02'), deviceAttributes: facts('AC-02-01') })).body.data;
  assert.equal(inactive.fixedUnitPriceSnapshot, null);
  await db.query('UPDATE service_price_variants SET is_active = true, fixed_labor_price_vnd = 1 WHERE variant_code = $1', ['AC-02-01']);
  await get('AC-02', { selectedVariantCode: 'AC-02-01' }, 400);
  const historical = (await http().get(`/api/v1/bookings/${fixedBooking.id}`).auth(token, { type: 'bearer' }).expect(200)).body.data;
  assert.equal(Number(historical.fixedUnitPriceSnapshot), 199000);
  for (const [column, expression] of [['catalog_v2_pricing_snapshot', 'NULL'], ['fixed_unit_price_snapshot', '1'], ['scope_snapshot', "'Changed'"], ['device_attributes_snapshot', "'{}'::jsonb"], ['pricing_mode_snapshot', "'inspection_required'"], ['quantity', '2']]) {
    await assert.rejects(db.query(`UPDATE bookings SET ${column} = ${expression} WHERE id = $1`, [fixedBooking.id]), /immutable/);
  }
  await repo('Booking').update(fixedBooking.id, { customerNote: 'Synthetic note' });
  const Migration = symbol('database/migrations/1790000000040-BookingCatalogV2Pricing.js', newName);
  const runner = db.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  await assert.rejects(new Migration().down(runner), /refusing destructive rollback/);
  await runner.rollbackTransaction();
  await runner.release();
  await db.query('UPDATE service_price_variants SET fixed_labor_price_vnd = 199000 WHERE variant_code = $1', ['AC-02-01']);

  // 32 verified active synthetic skills, one real candidate -> shortlist -> accept.
  const tech = await repo('User').save({ email: 'pricing-tech@example.test', passwordHash: 'synthetic-no-login', fullName: 'Synthetic technician', role: 'technician', status: 'active', isActive: true });
  const profile = await repo('TechnicianProfile').save({ userId: tech.id, verificationStatus: 'verified', isAvailable: true, onboardingStatus: 'completed' });
  await repo('TechnicianSkill').save(openCodes.map(code => ({ technicianId: profile.id, serviceId: idFor(code), level: 'INTERMEDIATE', isActive: true, verificationStatus: 'verified' })));
  assert.equal(await repo('TechnicianSkill').count(), 32);
  await repo('Address').save({ userId: tech.id, line1: 'Synthetic work', district: 'Synthetic', province: 'Synthetic', isDefault: true, lat: 10.77, lng: 106.69 });
  await repo('TechnicianSchedule').save(Array.from({ length: 7 }, (_, dayOfWeek) => ({ technicianId: profile.id, dayOfWeek, startTime: '00:00', endTime: '24:00' })));
  const candidates = await bookings.getCandidates(fixedBooking.id, { id: customer.id, role: 'customer' });
  assert.ok(candidates.some(c => c.userId === tech.id || c.technicianId === tech.id));
  const shortlist = await http().post(`/api/v1/bookings/${fixedBooking.id}/shortlist`).auth(token, { type: 'bearer' }).send({ technicianIds: [tech.id] }).expect(201);
  assert.ok(shortlist.body.data);
  const invitation = await repo('BookingInvitation').findOneByOrFail({ bookingId: fixedBooking.id, technicianId: tech.id, status: 'pending' });
  const techToken = module.get(JwtService).sign({ sub: tech.id, role: tech.role });
  await http().post(`/api/v1/invitations/${invitation.id}/respond`).auth(techToken, { type: 'bearer' }).send({ action: 'ACCEPT' }).expect(200);
  assert.equal((await repo('ServiceOrder').findOneByOrFail({ bookingId: fixedBooking.id })).status, 'accepted');
  const closedCodes = catalog.filter(s => ['GATE','LATER'].includes(s.phase)).map(s => s.code);
  for (const code of closedCodes) await get(code, {}, 404);
  assert.equal((await db.query('SELECT count(*)::int n FROM services WHERE code = ANY($1) AND is_active', [closedCodes]))[0].n, 0);
  assert.deepEqual((await db.query('SELECT enabled, activated_at FROM part_custody_activation'))[0], { enabled: false, activated_at: null });
  assert.deepEqual(await db.query('SELECT * FROM fixhome_parts ORDER BY id'), partsBefore);
  assert.equal((await db.query('SELECT count(*)::int n FROM services WHERE code = ANY($1) AND fixed_price IS NOT NULL', [openCodes]))[0].n, 0);
  console.log('P012_PRICING_PG_HTTP_PASS ' + JSON.stringify({ baselineMigrations: baseline.length, upgrade: newName, fixedTiers: tiers.length, fallbackServices: openCodes.length,
    syntheticSkills: 32, matchingAccept: true, immutableSnapshots: true, legacyMedia: true, partsPreserved: 792, p1Off: true, gateLaterInactive: true }));
  await app.close(); app = null;
  // Fresh chain and safe rollback before snapshots exist.
  await db.query('CREATE DATABASE p012_pricing_fresh');
  await db.destroy();
  db = new DataSource({ ...connection, database: 'p012_pricing_fresh', migrations });
  await db.initialize();
  assert.equal((await db.runMigrations()).length, migrations.length);
  await db.undoLastMigration();
  assert.deepEqual((await db.runMigrations()).map(m => m.name), [newName]);
  console.log('P012_PRICING_FRESH_ROLLBACK_PASS migrations=' + migrations.length);
  // Existing E2E creates its own schemas; public must be empty to avoid enum discovery collisions.
  await db.query('CREATE DATABASE p012_pricing_e2e');
  await db.destroy();
  if (process.argv.includes('--full-e2e')) {
    const env = Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','APPDATA','LOCALAPPDATA','COMSPEC','USERPROFILE','WINDIR'].filter(k => process.env[k]).map(k => [k,process.env[k]]));
    Object.assign(env, { NODE_ENV: 'test', MAIL_TRANSPORT: 'json', P1_CUSTODY_ENABLED: 'false', DATABASE_HOST: '127.0.0.1', DATABASE_PORT: String(port),
      DATABASE_USER: connection.username, DATABASE_PASSWORD: password, DATABASE_NAME: 'p012_pricing_e2e', DATABASE_SSL: 'false', JWT_ACCESS_SECRET: secret, JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('hex') });
    const log = path.join(os.tmpdir(), 'fixhome-p012-pricing-e2e.log');
    const result = cp.spawnSync(process.platform === 'win32' ? process.env.ComSpec : 'npm', process.platform === 'win32' ? ['/d','/c','npm run test:e2e'] : ['run','test:e2e'],
      { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
    console.log('P012_PRICING_FULL_E2E ' + JSON.stringify({ exitCode: result.status, timedOut: result.error?.code === 'ETIMEDOUT', log }));
    if (result.status !== 0) process.exitCode = 1;
  }
}
run().catch(error => { console.error('P012_PRICING_FAILED ' + error.message); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close();
  if (db?.isInitialized) await db.destroy();
  if (container) { docker('rm', '-f', container); console.log('P012_PRICING_OWN_CONTAINER_REMOVED'); }
});
