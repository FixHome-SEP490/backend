import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Client } from 'pg';
import { randomUUID, createHash } from 'crypto';
import { resolve } from 'path';
import { createRequire } from 'module';
import { JwtService } from '@nestjs/jwt';
import { getStorageToken, ThrottlerStorageService } from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerDev1Cases } from './dev1-cases';
import { registerBookingDraftCases } from './booking-draft-cases';
import { installKycBucket, kycBucket, uploadedKyc } from './kyc-bucket';

// Always use a new schema; never synchronize/drop the configured database.
const schema = `member1_e2e_${randomUUID().replace(/-/g, '')}`;
const replayDatabase = `member1_replay_${randomUUID().replace(/-/g, '')}`;
const password = 'SecurePassword123!';
const accessSecret = 'e2e-only-access-secret-with-at-least-32-characters';
const refreshSecret = 'e2e-only-refresh-secret-with-at-least-32-characters';
const runtimeRequire = createRequire(resolve('package.json'));
type Session = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string };
};

describe('Member 1 HTTP, PostgreSQL and migration gates', () => {
  let app: INestApplication;
  let db: DataSource;
  let replayDb: DataSource;
  let adminClient: Client;
  let customer: Session;
  let technician: Session;
  let admin: Session;
  let jwt: JwtService;
  const documentFor = (technicianId: string) => uploadedKyc({
    documentType: 'citizen_id_front',
    storageObjectPath: `kyc/${technicianId}/id-front.jpg`,
    fileName: 'id-front.jpg',
    fileSize: 1024,
    mimeType: 'image/jpeg',
  });
  const facePhotoFor = (technicianId: string) => uploadedKyc({
    documentType: 'face_photo',
    storageObjectPath: `kyc/${technicianId}/face-photo.jpg`,
    fileName: 'face-photo.jpg',
    fileSize: 1024,
    mimeType: 'image/jpeg',
  });
  const http = () => request(app.getHttpServer());
  const bearer = (session: Session) => `Bearer ${session.accessToken}`;
  const register = async (
    role = 'customer',
    extra: Record<string, unknown> = {},
  ): Promise<Session> => {
    const email = `${randomUUID()}@example.test`;
    await http()
      .post('/api/v1/auth/register')
      .send({
        email,
        password,
        fullName: 'Audit Test User',
        role,
        ...extra,
      })
      .expect(201);
    await db.query(
      'UPDATE users SET status = $1, is_email_verified = true WHERE email = $2',
      ['active', email],
    );
    const [userRow] = await db.query(
      'SELECT id, email, full_name, role, status FROM users WHERE email = $1',
      [email],
    );
    return freshLogin({ user: userRow, accessToken: '', refreshToken: '' });
  };
  const freshLogin = async (session: Session): Promise<Session> => {
    const response = await http()
      .post('/api/v1/auth/login')
      .send({ identifier: session.user.email, password })
      .expect(200);
    return response.body.data;
  };
  // Trusted test fixture: production public registration is customer-only.
  const provisionTechnician = async (): Promise<Session> => {
    const session = await register();
    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['technician', session.user.id]);
    await db.query('INSERT INTO technician_profiles (user_id) VALUES ($1)', [session.user.id]);
    return freshLogin(session);
  };
  const createCategory = async () =>
    (
      await http()
        .post('/api/v1/admin/service-categories')
        .set('Authorization', bearer(admin))
        .send({ name: 'Audit Category', code: randomUUID() })
        .expect(201)
    ).body.data;
  const createService = async (
    categoryId: string,
    extra: Record<string, unknown> = {},
  ) =>
    (
      await http()
        .post('/api/v1/admin/services')
        .set('Authorization', bearer(admin))
        .send({
          name: 'Audit Service',
          code: randomUUID(),
          categoryId,
          minPrice: 100,
          maxPrice: 200,
          ...extra,
        })
        .expect(201)
    ).body.data;
  const submit = (session: Session) =>
    http()
      .post('/api/v1/technicians/me/verification')
      .set('Authorization', bearer(session))
      .send({
        documents: [
          documentFor(session.user.id),
          facePhotoFor(session.user.id),
        ],
      });
  const review = (id: string, action: string, session = admin) =>
    http()
      .patch(`/api/v1/admin/technician-verifications/${id}/${action}`)
      .set('Authorization', bearer(session))
      .send(
        action === 'reject'
          ? { rejectionReason: 'Document is unreadable' }
          : {},
      );

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: accessSecret,
      JWT_REFRESH_SECRET: refreshSecret,
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
      SUPABASE_KYC_BUCKET: 'kyc-private',
      CORS_ORIGIN: 'http://localhost:5173',
      DATABASE_SSL: 'false',
    });
    process.env.DATABASE_PASSWORD ||= 'postgres';
    const connection = {
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      user: process.env.DATABASE_USER || 'postgres',
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME || 'fixhome',
    };
    adminClient = new Client(connection);
    await adminClient.connect();
    await adminClient.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;`);
    await adminClient.query(`CREATE SCHEMA "${schema}"`);
    const databaseOptions = {
      type: 'postgres' as const,
      host: connection.host,
      port: connection.port,
      username: connection.user,
      password: connection.password,
      database: connection.database,
      schema,
      extra: { options: `-c search_path=${schema},public` },
      entities: [resolve('dist/**/*.entity.js')],
      migrations: [resolve('dist/database/migrations/*.js')],
      synchronize: false,
      logging: false,
    };
    db = new DataSource(databaseOptions);
    await db.initialize();
    // This legacy E2E fixture uses a private schema; funding F4 targets public and requires
    // the already-deployed voucher baseline. Exclude F4 from this unrelated fixture only.
    // Private-schema legacy E2E cannot run public-schema finance cutovers.
    // Cash/reputation DDL has its own isolated PostgreSQL release test.
    db.migrations.splice(0, db.migrations.length, ...db.migrations.filter(m =>
      !['VoucherFundingLedger1792994400001', 'VoucherCampaignLifecycle1793116800000',
        'CashPaymentIntents1793293200000', 'TechnicianResponsibility1793293200001'].includes(m.name)
    ));
    expect(await db.runMigrations()).toHaveLength(db.migrations.length);
    // HTTP uses current entities, including 0015's invoice provenance column.
    // Only historical rollback/adoption tests use a separate pre-cutover DB.
    // A separate database also isolates old migrations' global enum-name checks.
    if (!/^member1_replay_[a-f0-9]{32}$/.test(replayDatabase)) throw new Error('Unsafe replay fixture');
    await adminClient.query(`CREATE DATABASE "${replayDatabase}"`);
    replayDb = await new DataSource({ ...databaseOptions, database: replayDatabase, schema: 'public',
      extra: { options: '-c search_path=public' } }).initialize();
    await replayDb.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    replayDb.migrations.splice(0, replayDb.migrations.length, ...replayDb.migrations.filter(m =>
      db.migrations.some(current => current.name === m.name) &&
      !['W3PositivePhysicalDelivery1793466000014', 'W3InvoicePaymentEnable1793466000015',
        'W3ZeroFeeInvoice1793466000016', 'WarehouseNearestGeo1794048000000'].includes(m.name)));
    expect(await replayDb.runMigrations()).toHaveLength(replayDb.migrations.length);
    expect(await replayDb.query("SELECT convalidated FROM pg_constraint WHERE conrelid='invoices'::regclass AND conname='ck_invoice_shipping_cutover_closed'"))
      .toEqual([{ convalidated: true }]);
    await replayDb.undoLastMigration();
    await replayDb.undoLastMigration();
    expect(await replayDb.runMigrations()).toHaveLength(2);
    // The old private-schema suite omits F4; include its nullable SupportCase field
    // only as a fixture compatibility column, never as a substitute for funding DDL.
    await db.query('ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS voucher_gross_refund_vnd bigint NULL');
    // Private-schema legacy E2E skips the public cash/reputation migration chain.
    // Give the current TypeORM entities nullable compatibility columns ONLY inside
    // this disposable fixture; actual DDL/RLS/indexes run in cash-reputation.postgres.spec.ts.
    await db.query(`ALTER TABLE support_cases
      ADD COLUMN IF NOT EXISTS reason_class varchar(32),
      ADD COLUMN IF NOT EXISTS reason_code varchar(48),
      ADD COLUMN IF NOT EXISTS responsibility varchar(32),
      ADD COLUMN IF NOT EXISTS responsibility_command_id uuid,
      ADD COLUMN IF NOT EXISTS responsibility_actor_id uuid,
      ADD COLUMN IF NOT EXISTS responsibility_reason varchar(2000),
      ADD COLUMN IF NOT EXISTS responsibility_evidence_refs jsonb,
      ADD COLUMN IF NOT EXISTS responsibility_decided_at timestamptz`);
    await db.query('ALTER TABLE reputation_events ADD COLUMN IF NOT EXISTS support_case_id uuid');
    // This private legacy E2E fixture intentionally excludes F4 funding migrations.
    // The old technician-replacement path now checks payment links fail-closed;
    // provide an EMPTY synthetic table only inside this disposable test schema.
    // The actual F4 schema and ledger are tested by the isolated funding gate.
    await db.query(`CREATE TABLE IF NOT EXISTS voucher_payment_links (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      created_at timestamptz NOT NULL DEFAULT now(),
      reservation_id uuid,
      attempt_id uuid,
      customer_id uuid,
      scope_id uuid NOT NULL,
      scope_kind varchar(16),
      rail varchar(8),
      payment_id uuid,
      cash_settlement_id uuid,
      visit_group_payment_id uuid,
      provider_txn_ref varchar(128),
      provider_initiated_at timestamptz,
      original_gross_vnd bigint,
      eligible_base_vnd bigint,
      subsidy_vnd bigint,
      customer_due_vnd bigint,
      allocation_snapshot jsonb,
      allocation_sha256 char(64)
    )`);
    const { seedRbac } = runtimeRequire('./dist/database/seeds/seed-rbac.js');
    await seedRbac(db);
    const { AppModule } = runtimeRequire('./dist/app.module.js');
    const { configureApplication } = runtimeRequire('./dist/setup-app.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DataSource)
      .useValue(db)
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    configureApplication(app);
    await app.init();
    installKycBucket(app);
    jwt = app.get(JwtService);
    customer = await register();
    technician = await provisionTechnician();
    admin = await register();
    await db.query('UPDATE users SET role = $1 WHERE id = $2', [
      'admin',
      admin.user.id,
    ]);
    admin = await freshLogin(admin);
  }, 60000);

  beforeEach(() => {
    const storage = app.get<ThrottlerStorageService>(getStorageToken());
    storage.onApplicationShutdown();
    storage.storage.clear();
  });
  registerDev1Cases(() => ({ app, db, register, provisionTechnician }));
  registerBookingDraftCases(() => ({ app, db, register, technician, admin }));

  afterAll(async () => {
    if (app) await app.close();
    if (db?.isInitialized) await db.destroy();
    if (replayDb?.isInitialized) await replayDb.destroy();
    if (adminClient) {
      if (!/^member1_replay_[a-f0-9]{32}$/.test(replayDatabase)) throw new Error('Unsafe replay cleanup');
      await adminClient.query(`DROP DATABASE IF EXISTS "${replayDatabase}"`);
      await adminClient.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await adminClient.end();
    }
  });

  it.each(['/health', '/api/v1/health'])(
    'boots with real DB and shared envelope: %s',
    async (path) => {
      const response = await http().get(path).expect(200);
      expect(response.body).toMatchObject({
        success: true,
        statusCode: 200,
        data: { status: 'ok', dependencies: { database: 'connected' } },
      });
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    },
  );
  it('serves Swagger with real DTO, bearer security and required endpoints', async () => {
    const response = await http().get('/api/docs-json').expect(200);
    expect(response.body.components.securitySchemes.bearer).toBeDefined();
    for (const path of [
      '/api/v1/auth/register',
      '/api/v1/users/me',
      '/api/v1/admin/users/{id}/status',
      '/api/v1/technicians/me/verification',
      '/api/v1/services',
    ])
      expect(response.body.paths[path]).toBeDefined();
    expect(
      response.body.components.schemas.RejectVerificationDto.required,
    ).toContain('rejectionReason');
  });
  it('only permits configured CORS origins', async () => {
    expect(
      (await http().get('/health').set('Origin', 'https://untrusted.test'))
        .headers['access-control-allow-origin'],
    ).toBeUndefined();
    expect(
      (await http().get('/health').set('Origin', 'http://localhost:5173'))
        .headers['access-control-allow-origin'],
    ).toBe('http://localhost:5173');
  });
  it.each(['customer', 'technician'])(
    'registers %s with hash and safe profile',
    async (role) => {
      const session = await register(role);
      const [user] = await db.query('SELECT * FROM users WHERE id = $1', [
        session.user.id,
      ]);
      expect(await bcrypt.compare(password, user.password_hash)).toBe(true);
      expect(session.user).not.toHaveProperty('passwordHash');
      expect(jwt.decode(session.accessToken)).not.toHaveProperty('email');
      const [token] = await db.query(
        'SELECT * FROM refresh_tokens WHERE user_id = $1',
        [session.user.id],
      );
      expect(token.token_hash).toBe(
        createHash('sha256').update(session.refreshToken).digest('hex'),
      );
      expect(new Date(token.expires_at).getTime()).toBe(
        (jwt.decode(session.refreshToken) as { exp: number }).exp * 1000,
      );
    },
  );
  it.each(['admin', 'service_manager'])(
    'blocks public registration of %s',
    async (role) => {
      await http()
        .post('/api/v1/auth/register')
        .send({
          email: 'forbidden@example.test',
          fullName: 'Forbidden Actor',
          password,
          role,
        })
        .expect(400);
    },
  );
  it.each([
    { email: 'invalid' },
    { password: 'weakpass' },
    { password: 'A1!' + 'é'.repeat(36) },
    { fullName: '   ' },
    { phoneNumber: '0|12345678' },
    { role: null },
    { passwordHash: 'injected' },
  ])('rejects invalid registration %j', async (invalid) => {
    await http()
      .post('/api/v1/auth/register')
      .send({
        email: 'validation@example.test',
        fullName: 'Audit User',
        password,
        ...invalid,
      })
      .expect(400);
  });
  it('handles duplicate email and equivalent +84 phone identifiers', async () => {
    const first = await register('customer', { phoneNumber: '0912345678' });
    await http()
      .post('/api/v1/auth/register')
      .send({
        email: first.user.email.toUpperCase(),
        password,
        fullName: 'Duplicate',
      })
      .expect(409);
    await http()
      .post('/api/v1/auth/register')
      .send({
        email: 'phone@example.test',
        phoneNumber: '+84912345678',
        password,
        fullName: 'Duplicate',
      })
      .expect(409);
    await http()
      .post('/api/v1/auth/login')
      .send({ identifier: '+84912345678', password })
      .expect(200);
  });
  it('maps a concurrent duplicate registration to 409', async () => {
    const body = {
      email: `${randomUUID()}@example.test`,
      password,
      fullName: 'Concurrent',
    };
    const results = await Promise.all([
      http().post('/api/v1/auth/register').send(body),
      http().post('/api/v1/auth/register').send(body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it('supports email alias and rejects wrong or unknown credentials', async () => {
    await http()
      .post('/api/v1/auth/login')
      .send({ email: customer.user.email, password })
      .expect(200);
    for (const identifier of [customer.user.email, 'unknown@example.test'])
      await http()
        .post('/api/v1/auth/login')
        .send({ identifier, password: 'WrongPassword!' })
        .expect(401);
  });
  it.each(['locked', 'suspended'])(
    'enforces %s across login, JWT and refresh, with no revived sessions',
    async (status) => {
      const session = await register();
      await http()
        .patch(`/api/v1/admin/users/${session.user.id}/status`)
        .set('Authorization', bearer(admin))
        .send({ status })
        .expect(200);
      await http()
        .post('/api/v1/auth/login')
        .send({ identifier: session.user.email, password })
        .expect(403);
      await http()
        .get('/api/v1/auth/me')
        .set('Authorization', bearer(session))
        .expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(403);
      await http()
        .patch(`/api/v1/admin/users/${session.user.id}/status`)
        .set('Authorization', bearer(admin))
        .send({ status: 'active' })
        .expect(200);
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken })
        .expect(401);
    },
  );
  it('rotates same-second tokens once and rejects concurrent refresh/reuse', async () => {
    const session = await freshLogin(customer);
    const results = await Promise.all([
      http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken }),
      http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(
      results.find((r) => r.status === 200).body.data.refreshToken,
    ).not.toBe(session.refreshToken);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(401);
  });
  it('rejects invalid, expired and unknown refresh tokens', async () => {
    const expired = jwt.sign(
      { sub: customer.user.id },
      { secret: refreshSecret, expiresIn: -1 },
    );
    const unknown = jwt.sign(
      { sub: customer.user.id },
      { secret: refreshSecret, expiresIn: '1h', jwtid: randomUUID() },
    );
    for (const token of ['invalid', expired, unknown, customer.accessToken])
      await http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(401);
  });
  it('logout revokes only the owned session and validates its DTO', async () => {
    const first = await freshLogin(customer);
    const second = await freshLogin(customer);
    expect(first.refreshToken).not.toBe(second.refreshToken);
    await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', bearer(first))
      .send({ refreshToken: 123 })
      .expect(400);
    await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', bearer(technician))
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    const logout = await http()
      .post('/api/v1/auth/logout')
      .set('Authorization', bearer(first))
      .send({ refreshToken: first.refreshToken })
      .expect(200);
    expect(logout.body.data).toEqual({ loggedOut: true });
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    await http()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: second.refreshToken })
      .expect(200);
  });
  it('requires a valid unexpired JWT', async () => {
    await http().get('/api/v1/auth/me').expect(401);
    const expired = jwt.sign(
      { sub: customer.user.id },
      { secret: accessSecret, expiresIn: -1 },
    );
    for (const token of ['invalid', expired, customer.refreshToken])
      await http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    await http()
      .get('/api/v1/auth/me')
      .set('Authorization', bearer(customer))
      .expect(200);
  });
  it('RBAC blocks Customer/Technician/Manager at admin user and verification APIs', async () => {
    const manager = await register();
    await db.query('UPDATE users SET role = $1 WHERE id = $2', [
      'service_manager',
      manager.user.id,
    ]);
    for (const actor of [customer, technician, manager]) {
      await http()
        .get('/api/v1/admin/users')
        .set('Authorization', bearer(actor))
        .expect(403);
      await review(randomUUID(), 'approve', actor).expect(403);
    }
    await http()
      .get('/api/v1/admin/users')
      .set('Authorization', bearer(admin))
      .expect(200);
  });
  it('filters the audit log and strikes by a seeded account id whose version nibble is 0', async () => {
    // Shared database seed accounts look like a0000000-0000-0000-0000-000000000001 (bug 31).
    const legacyId = `a0000000-0000-0000-0000-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const otherId = randomUUID();
    await db.query(
      `INSERT INTO users (id,email,password_hash,full_name,role,status) VALUES ($1,$2,'unused-hash','Seed Admin Legacy','admin','active')`,
      [legacyId, `${randomUUID()}@example.test`],
    );
    await db.query(
      `INSERT INTO audit_logs (actor_user_id, actor_role, action, resource_type, resource_id) VALUES ($1,'admin','CONFIG_UPDATE','system_config','legacy-actor-check'), ($2,'admin','CONFIG_UPDATE','system_config','other-actor-check')`,
      [legacyId, otherId],
    );
    const filtered = await http()
      .get('/api/v1/admin/audit-logs')
      .query({ page: 1, limit: 10, actorUserId: legacyId })
      .set('Authorization', bearer(admin))
      .expect(200);
    expect(filtered.body.meta.total).toBe(1);
    expect(filtered.body.data).toHaveLength(1);
    expect(filtered.body.data[0]).toMatchObject({ actorUserId: legacyId, resourceId: 'legacy-actor-check' });
    await http()
      .get('/api/v1/admin/audit-logs')
      .query({ actorUserId: legacyId.toUpperCase() })
      .set('Authorization', bearer(admin))
      .expect(200);
    for (const bad of [legacyId.slice(0, 20), `${legacyId}0`, legacyId.replace(/-/g, ''), 'admin', `${legacyId}' OR '1'='1`]) {
      const response = await http()
        .get('/api/v1/admin/audit-logs')
        .query({ actorUserId: bad })
        .set('Authorization', bearer(admin))
        .expect(400);
      expect(response.body.error.details).toContain('actorUserId must be a UUID');
    }
    await http()
      .get('/api/v1/strikes')
      .query({ userId: legacyId })
      .set('Authorization', bearer(admin))
      .expect(200);
    await http()
      .get('/api/v1/strikes')
      .query({ userId: 'not-a-user-id' })
      .set('Authorization', bearer(admin))
      .expect(400);
    await http()
      .get('/api/v1/admin/audit-logs')
      .query({ actorUserId: legacyId })
      .set('Authorization', bearer(customer))
      .expect(403);
  });
  it('updates only own permitted fields and rejects system fields/null names', async () => {
    await http()
      .patch('/api/v1/users/me')
      .set('Authorization', bearer(customer))
      .send({ fullName: 'Updated Customer' })
      .expect(200);
    for (const body of [
      { role: 'admin' },
      { status: 'locked' },
      { accountStatus: 'active' },
      { isActive: false },
      { fullName: null },
      { fullName: '  ' },
    ])
      await http()
        .patch('/api/v1/users/me')
        .set('Authorization', bearer(customer))
        .send(body)
        .expect(400);
    const profile = await http()
      .get('/api/v1/users/me')
      .set('Authorization', bearer(technician))
      .expect(200);
    expect(profile.body.data.fullName).toBe('Audit Test User');
    expect(profile.body.data).not.toHaveProperty('passwordHash');
  });
  it('validates admin filters/pagination and returns sanitized data', async () => {
    const users = await http()
      .get('/api/v1/admin/users?role=customer&status=active&limit=2&page=1')
      .set('Authorization', bearer(admin))
      .expect(200);
    expect(users.body.data.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(users.body)).not.toContain('passwordHash');
    for (const query of [
      'page=1.5',
      'page=0',
      'limit=101',
      'role=hacker',
      'status=deleted',
    ])
      await http()
        .get(`/api/v1/admin/users?${query}`)
        .set('Authorization', bearer(admin))
        .expect(400);
  });
  it('catalog uses active category AND service, including direct IDs and bypass query flags', async () => {
    const category = await createCategory();
    const service = await createService(category.id);
    await http().get(`/api/v1/services/${service.id}`).expect(200);
    await http()
      .patch(`/api/v1/admin/services/${service.id}/status`)
      .set('Authorization', bearer(admin))
      .send({ isActive: false })
      .expect(200);
    await http().get(`/api/v1/services/${service.id}`).expect(404);
    expect(
      (
        await http()
          .get(`/api/v1/services?categoryId=${category.id}&isActive=false`)
          .expect(200)
      ).body.data,
    ).toHaveLength(0);
    expect(
      (
        await http()
          .get(`/api/v1/service-categories/${category.id}`)
          .expect(200)
      ).body.data.services,
    ).toHaveLength(0);
    await http()
      .patch(`/api/v1/admin/services/${service.id}/status`)
      .set('Authorization', bearer(admin))
      .send({ isActive: true })
      .expect(200);
    await http()
      .patch(`/api/v1/admin/service-categories/${category.id}/status`)
      .set('Authorization', bearer(admin))
      .send({ isActive: false })
      .expect(200);
    await http().get(`/api/v1/services/${service.id}`).expect(404);
    await http().get(`/api/v1/service-categories/${category.id}`).expect(404);
    expect(
      (
        await http().get('/api/v1/service-categories?all=true').expect(200)
      ).body.data.some((c: { id: string }) => c.id === category.id),
    ).toBe(false);
    await http()
      .get(`/api/v1/admin/services/${service.id}`)
      .set('Authorization', bearer(admin))
      .expect(200);
  });
  it('validates catalog price ranges, status booleans and duplicate codes', async () => {
    const category = await createCategory();
    const service = await createService(category.id);
    await http()
      .post('/api/v1/admin/services')
      .set('Authorization', bearer(admin))
      .send({ name: 'Duplicate', code: service.code, categoryId: category.id })
      .expect(409);
    for (const body of [
      { minPrice: 300 },
      { basePrice: -1 },
      { maxPrice: 1.001 },
      { basePrice: 1e12 },
      { name: null },
    ])
      await http()
        .patch(`/api/v1/admin/services/${service.id}`)
        .set('Authorization', bearer(admin))
        .send(body)
        .expect(400);
    for (const body of [
      {},
      { isActive: 'false' },
      { isActive: null },
      { isActive: true, injected: true },
    ])
      await http()
        .patch(`/api/v1/admin/services/${service.id}/status`)
        .set('Authorization', bearer(admin))
        .send(body)
        .expect(400);
    await http()
      .post('/api/v1/admin/services')
      .set('Authorization', bearer(customer))
      .send({})
      .expect(403);
  });
  it('verification is owned, atomic under concurrent submission, and hides relation hashes', async () => {
    const tech = await provisionTechnician();
    const submissions = await Promise.all([submit(tech), submit(tech)]);
    expect(submissions.map((r) => r.status).sort()).toEqual([201, 409]);
    const id = submissions.find((r) => r.status === 201).body.data.id;
    const detail = await http()
      .get(`/api/v1/admin/technician-verifications/${id}`)
      .set('Authorization', bearer(admin))
      .expect(200);
    expect(detail.body.data.documents).toHaveLength(2);
    expect(JSON.stringify(detail.body)).not.toContain('passwordHash');
    expect(
      (
        await http()
          .get('/api/v1/technicians/me/verification')
          .set('Authorization', bearer(technician))
          .expect(200)
      ).body.data,
    ).toBeNull();
    await submit(customer).expect(403);
  });
  it('accepts a face video instead of a face photo, as the web sends since 25/09/2026', async () => {
    const tech = await register('technician');
    const video = uploadedKyc({ documentType: 'face_video', storageObjectPath: `kyc/${tech.user.id}/face.webm`, fileName: 'face-liveness.webm', fileSize: 2_000_000, mimeType: 'video/webm' });
    const created = (await http().post('/api/v1/technicians/me/verification').set('Authorization', bearer(tech))
      .send({ documents: [documentFor(tech.user.id), video] }).expect(201)).body.data;
    const [stored] = await db.query("SELECT document_type, mime_type FROM verification_documents WHERE verification_id = $1 AND document_type = 'face_video'", [created.id]);
    expect(stored).toEqual({ document_type: 'face_video', mime_type: 'video/webm' });
    const other = await register('technician');
    // The extension must still match the video type.
    await http().post('/api/v1/technicians/me/verification').set('Authorization', bearer(other))
      .send({ documents: [documentFor(other.user.id), { ...video, storageObjectPath: `kyc/${other.user.id}/face.webm`, fileName: 'face.png' }] }).expect(400);
    await http().post('/api/v1/technicians/me/verification/documents/upload-url').set('Authorization', bearer(other))
      .send({ mimeType: 'video/quicktime' }).expect(400);
  });

  it('accepts only documents this technician really uploaded (DEF-r2-mobile-01)', async () => {
    const tech = await provisionTechnician();
    const other = await provisionTechnician();
    const send = (documents: unknown[]) =>
      http().post('/api/v1/technicians/me/verification').set('Authorization', bearer(tech)).send({ documents });
    const issue = async (session: Session) =>
      (await http().post('/api/v1/technicians/me/verification/documents/upload-url').set('Authorization', bearer(session))
        .send({ mimeType: 'image/jpeg' }).expect(201)).body.data.storageObjectPath as string;
    const doc = (documentType: string, storageObjectPath: string) =>
      ({ documentType, storageObjectPath, fileName: `${documentType}.jpg`, fileSize: 2048, mimeType: 'image/jpeg' });
    const count = async () =>
      Number((await db.query('SELECT count(*)::int AS n FROM technician_verifications WHERE technician_id = $1', [tech.user.id]))[0].n);

    // A path in the technician's own folder that nothing was ever uploaded to.
    const front = await issue(tech);
    const face = await issue(tech);
    kycBucket.add(face);
    const ghost = await send([doc('citizen_id_front', `kyc/${tech.user.id}/${randomUUID()}.jpg`), doc('face_photo', face)]).expect(400);
    expect(JSON.stringify(ghost.body)).toContain('Không tìm thấy giấy tờ đã tải lên');
    // An upload URL was issued but the upload never happened.
    await send([doc('citizen_id_front', front), doc('face_photo', face)]).expect(400);
    // Another technician's file, even one that was uploaded.
    const theirs = await issue(other);
    kycBucket.add(theirs);
    await send([doc('citizen_id_front', theirs), doc('face_photo', face)]).expect(400);
    expect(await count()).toBe(0);
    expect(Number((await db.query('SELECT count(*)::int AS n FROM verification_documents d JOIN technician_verifications v ON v.id = d.verification_id WHERE v.technician_id = $1', [tech.user.id]))[0].n)).toBe(0);

    // The real upload of the front, then the same request goes through.
    kycBucket.add(front);
    const created = (await send([doc('citizen_id_front', front), doc('face_photo', face)]).expect(201)).body.data;
    expect(created.status).toBe('pending');
    expect(await count()).toBe(1);
  });

  it('attaches skill evidence and issues certificates only from files really uploaded to the private bucket', async () => {
    const tech = await provisionTechnician();
    const other = await provisionTechnician();
    const service = await createService((await createCategory()).id);
    const [profile] = await db.query('SELECT id FROM technician_profiles WHERE user_id = $1', [tech.user.id]);
    const [skill] = await db.query(
      "INSERT INTO technician_skills (technician_id, service_id, listed_labor_price, verification_status) VALUES ($1, $2, 150, 'pending') RETURNING id",
      [profile.id, service.id],
    );
    const [pending] = await db.query(
      "INSERT INTO technician_skill_verifications (technician_skill_id, status) VALUES ($1, 'pending') RETURNING id",
      [skill.id],
    );
    const base = `/api/v1/technicians/me/services/${service.id}/verification/documents`;
    const issue = async (session: Session) =>
      (await http().post(`${base}/upload-url`).set('Authorization', bearer(session))
        .send({ mimeType: 'image/png' }).expect(201)).body.data.storageObjectPath as string;
    const evidence = (storageObjectPath: string) =>
      ({ storageObjectPath, fileName: 'chung-chi.png', fileSize: 2048, mimeType: 'image/png' });
    const attach = (storageObjectPath: string) =>
      http().post(base).set('Authorization', bearer(tech)).send(evidence(storageObjectPath));
    const documents = async () =>
      Number((await db.query('SELECT count(*)::int AS n FROM verification_documents WHERE skill_verification_id = $1', [pending.id]))[0].n);

    // Invented path in the own folder.
    const ghost = await attach(`kyc/${tech.user.id}/${randomUUID()}.png`).expect(400);
    expect(JSON.stringify(ghost.body)).toContain('Không tìm thấy tệp chứng chỉ đã tải lên');
    // Another technician's uploaded file.
    const theirs = await issue(other);
    kycBucket.add(theirs);
    await attach(theirs).expect(400);
    // Upload URL issued, nothing uploaded.
    const mine = await issue(tech);
    await attach(mine).expect(400);
    expect(await documents()).toBe(0);

    // After the real upload the evidence is attached.
    kycBucket.add(mine);
    const attached = (await attach(mine).expect(201)).body.data;
    expect(attached.status).toBe('pending');
    expect(await documents()).toBe(1);

    // The certificate FixHome issues on approval follows the same rule.
    const certificate = (
      await http().post(`/api/v1/admin/technician-skill-verifications/${pending.id}/certificate-upload-url`)
        .set('Authorization', bearer(admin)).send({ mimeType: 'image/png' }).expect(201)
    ).body.data.storageObjectPath as string;
    const approve = () =>
      http().patch(`/api/v1/admin/technician-skill-verifications/${pending.id}/approve`)
        .set('Authorization', bearer(admin)).send(evidence(certificate));
    await approve().expect(400);
    const [stillPending] = await db.query('SELECT status FROM technician_skill_verifications WHERE id = $1', [pending.id]);
    expect(stillPending.status).toBe('pending');
    kycBucket.add(certificate);
    expect((await approve().expect(200)).body.data.status).toBe('verified');
    expect(await documents()).toBe(2);
  });

  it('allows one review only, stores reviewer/time, and exposes approval to Member 3', async () => {
    const tech = await provisionTechnician();
    const id = (await submit(tech).expect(201)).body.data.id;
    const results = await Promise.all([
      review(id, 'approve'),
      review(id, 'reject'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [stored] = await db.query(
      'SELECT * FROM technician_verifications WHERE id = $1',
      [id],
    );
    expect(stored.reviewed_by).toBe(admin.user.id);
    expect(stored.reviewed_at).toBeTruthy();
    await review(id, 'approve').expect(409);
    await review(id, 'reject').expect(409);
    const { TechnicianVerificationsService } = runtimeRequire(
      './dist/modules/technician-verifications/technician-verifications.service.js',
    );
    expect(
      await app
        .get<{ isVerified(id: string): Promise<boolean> }>(
          TechnicianVerificationsService,
        )
        .isVerified(tech.user.id),
    ).toBe(stored.status === 'verified');
  });
  it('requires reject reason and permits corrected resubmission after rejection', async () => {
    const tech = await provisionTechnician();
    const id = (await submit(tech).expect(201)).body.data.id;
    for (const body of [{}, { rejectionReason: '     ' }])
      await http()
        .patch(`/api/v1/admin/technician-verifications/${id}/reject`)
        .set('Authorization', bearer(admin))
        .send(body)
        .expect(400);
    await review(id, 'reject').expect(200);
    const next = await submit(tech).expect(201);
    await review(next.body.data.id, 'approve').expect(200);
    await submit(tech).expect(409);
  });
  it('rejects suspended technician submission and review', async () => {
    const tech = await provisionTechnician();
    const id = (await submit(tech).expect(201)).body.data.id;
    await http()
      .patch(`/api/v1/admin/users/${tech.user.id}/status`)
      .set('Authorization', bearer(admin))
      .send({ status: 'suspended' })
      .expect(200);
    await submit(tech).expect(401);
    await review(id, 'approve').expect(403);
  });
  it.each([
    { fileUrl: 'javascript:alert(1)' },
    {
      storageObjectPath:
        'https://project.supabase.co/storage/v1/object/public/kyc-private/id.jpg',
    },
    { storageObjectPath: 'kyc/other-technician/id.jpg' },
    { storageObjectPath: 'kyc/technician/../id.jpg' },
    { fileSize: 10485761 },
    { fileSize: 1.5 },
    { mimeType: 'text/html' },
    { fileName: '../../id.jpg' },
    { fileName: 'id.pdf' },
  ])('rejects invalid verification metadata %j', async (invalid) => {
    await http()
      .post('/api/v1/technicians/me/verification')
      .set('Authorization', bearer(technician))
      .send({
        documents: [{ ...documentFor(technician.user.id), ...invalid }],
      })
      .expect(400);
  });
  it('bounds document counts', async () => {
    for (const documents of [
      [],
      Array.from({ length: 11 }, () => documentFor(technician.user.id)),
    ])
      await http()
        .post('/api/v1/technicians/me/verification')
        .set('Authorization', bearer(technician))
        .send({ documents })
        .expect(400);
  });
  it('rate limits login while health remains available', async () => {
    for (let i = 0; i < 10; i++)
      await http()
        .post('/api/v1/auth/login')
        .send({ identifier: 'unknown@example.test', password })
        .expect(401);
    const limited = await http()
      .post('/api/v1/auth/login')
      .send({ identifier: 'unknown@example.test', password })
      .expect(429);
    expect(limited.body.error.code).toBe('TOO_MANY_REQUESTS');
    await http().get('/health').expect(200);
  });
  it('database enforces prices and verification uniqueness independently of DTOs', async () => {
    const category = await createCategory();
    await expect(
      db.query(
        'INSERT INTO services (category_id,name,code,min_price,max_price) VALUES ($1,$2,$3,200,100)',
        [category.id, 'Invalid', randomUUID()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  it('rolls back the verification header if saving a document fails', async () => {
    const tech = await provisionTechnician();
    await db.query(
      'ALTER TABLE verification_documents ADD CONSTRAINT audit_reject_document CHECK (file_size <> 1024) NOT VALID',
    );
    try {
      await submit(tech).expect(400);
      expect(
        await db.query(
          'SELECT id FROM technician_verifications WHERE technician_id = $1',
          [tech.user.id],
        ),
      ).toHaveLength(0);
    } finally {
      await db.query(
        'ALTER TABLE verification_documents DROP CONSTRAINT audit_reject_document',
      );
    }
  });

  it('allows Admin catalog operations with soft deletion only and denies Service Manager mutation', async () => {
    const manager = await register();
    await db.query('UPDATE users SET role = $1 WHERE id = $2', ['service_manager', manager.user.id]);
    await http().post('/api/v1/admin/categories').set('Authorization', bearer(manager)).send({ name: 'Manager Category', code: randomUUID() }).expect(403);
    const category = (await http().post('/api/v1/admin/categories').set('Authorization', bearer(admin)).send({ name: 'Admin Category', code: randomUUID() }).expect(201)).body.data;
    const service = await createService(category.id);
    await http().delete(`/api/v1/admin/services/${service.id}`).set('Authorization', bearer(manager)).expect(403);
    await http().delete(`/api/v1/admin/services/${service.id}`).set('Authorization', bearer(admin)).expect(200);
    await http().delete(`/api/v1/admin/categories/${category.id}`).set('Authorization', bearer(admin)).expect(200);
    expect(await db.query('SELECT id FROM services WHERE id = $1 AND is_active = false', [service.id])).toHaveLength(1);
    expect(await db.query('SELECT id FROM service_categories WHERE id = $1 AND is_active = false', [category.id])).toHaveLength(1);
    await http().delete(`/api/v1/admin/services/${service.id}`).set('Authorization', bearer(customer)).expect(403);
  });

  it('serializes account locking against concurrent login token issuance', async () => {
    const session = await register();
    const results = await Promise.all([
      http()
        .post('/api/v1/auth/login')
        .send({ identifier: session.user.email, password }),
      http()
        .patch(`/api/v1/admin/users/${session.user.id}/status`)
        .set('Authorization', bearer(admin))
        .send({ status: 'locked' }),
    ]);
    expect([200, 403]).toContain(results[0].status);
    expect(results[1].status).toBe(200);
    expect(
      await db.query(
        'SELECT id FROM refresh_tokens WHERE user_id = $1 AND is_revoked = false',
        [session.user.id],
      ),
    ).toHaveLength(0);
  });

  describe('W3 B2b authenticated owner preview (isolated HTTP/JWT/PostgreSQL)', () => {
    let owner: Session;
    let technicianOwner: Session;
    let outsider: Session;
    let technicianOutsider: Session;
    let manager: Session;
    let requestId: string;
    let assignmentId: string;
    let serviceOrderId: string;

    const previewPath = (id = requestId) =>
      `/api/v1/part-requests/${id}/delivery-consent/preview`;

    beforeAll(async () => {
      // Disposable CI schema only. No real customer, warehouse, courier, or approved W3 fee.
      // Seed ONLY the disposable CI schema, avoiding unrelated public
      // registration/login throttling. Each HTTP call still authenticates via
      // real Passport JWT signature, strategy DB reload and role/owner guards.
      const syntheticSession = async (
        role: 'customer' | 'technician' | 'service_manager',
      ): Promise<Session> => {
        const user = await db.getRepository('User').save({
          email: `${randomUUID()}@example.test`,
          passwordHash: 'CI_ONLY_NON_LOGIN_CREDENTIAL',
          fullName: 'W3 B2b isolated HTTP actor',
          role,
          status: 'active',
          isActive: true,
        });
        return {
          user: { id: user.id, email: user.email },
          accessToken: jwt.sign(
            { sub: user.id, role },
            { secret: accessSecret, expiresIn: '15m' },
          ),
          refreshToken: '',
        };
      };
      owner = await syntheticSession('customer');
      outsider = await syntheticSession('customer');
      technicianOwner = await syntheticSession('technician');
      technicianOutsider = await syntheticSession('technician');
      manager = await syntheticSession('service_manager');

      const category = await createCategory();
      const service = await createService(category.id);
      const booking = await db.getRepository('Booking').save({
        customerId: owner.user.id,
        serviceId: service.id,
        description: 'W3 read-only synthetic preview fixture',
        status: 'matched',
      });
      const order = await db.getRepository('ServiceOrder').save({
        bookingId: booking.id,
        code: `W3-B2B-${randomUUID()}`,
        status: 'under_repair',
      });
      serviceOrderId = order.id;
      const assignment = await db.getRepository('TechnicianAssignment').save({
        serviceOrderId,
        technicianId: technicianOwner.user.id,
        isActive: true,
      });
      assignmentId = assignment.id;
      const source = await db.getRepository('AdditionalCostRequest').save({
        serviceOrderId,
        technicianId: technicianOwner.user.id,
        status: 'approved',
        reason: 'Synthetic approved parts/labor, NOT approved courier fee',
        decidedAt: new Date(),
        decidedByCustomerId: owner.user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        fulfillmentMethod: 'delivery',
        shippingFee: 20_000,
      });
      const partRequest = await db.getRepository('PartRequest').save({
        serviceOrderId,
        technicianId: technicianOwner.user.id,
        requestType: 'additional',
        fulfillmentMethod: 'delivery',
        additionalCostId: source.id,
      });
      requestId = partRequest.id;
    });

    it('allows only the matching owner and active technician, but never financial actions', async () => {
      for (const session of [owner, technicianOwner]) {
        const result = await http()
          .get(previewPath())
          .set('Authorization', bearer(session))
          .expect(200);
        expect(result.headers['cache-control']).toContain('no-store');
        expect(result.body).toMatchObject({
          success: true,
          data: {
            mode: 'NON_EXECUTABLE_PREVIEW',
            consistency: 'NON_ATOMIC',
            actor: { id: session.user.id },
            requestId,
            serviceOrderId,
            observed: {
              requestType: 'additional',
              fulfillmentMethod: 'delivery',
              requestStatus: 'requested',
              orderStatus: 'under_repair',
            },
            source: {
              kind: 'ADDITIONAL_COST',
              partsLaborApproval: 'VERIFIED_APPROVED',
              shippingApproval: 'UNVERIFIED',
              version: null,
            },
            actions: {
              newConsent: 'BLOCKED',
              proposal: 'BLOCKED',
              dispatch: 'BLOCKED',
              payout: 'BLOCKED',
            },
          },
        });
        expect(result.body.data.blockers).toEqual(
          expect.arrayContaining([
            'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
            'WAREHOUSE_DELIVERY_ALLOCATION_MISSING',
            'COURIER_PROOF_UNVERIFIED',
            'FINANCE_CUTOVER_CLOSED',
            'TOTAL_ORDER_LABOR_BUDGET_UNVERIFIED',
          ]),
        );
        // No private courier URL, raw source record, or financial authorization.
        expect(JSON.stringify(result.body)).not.toContain('cloudinary://');
        expect(result.body.data).not.toHaveProperty('shippingFee');
        expect(result.body.data).not.toHaveProperty('approvedShippingFee');
      }
    });

    it('keeps W3 physical HTTP preview owner-only and every physical mutation unavailable', async () => {
      const physical = (id = requestId) => `/api/v1/part-requests/${id}/delivery-physical/preview`;
      const before = await db.getRepository('WarehouseDeliveryEvent').count();
      for (const session of [owner, technicianOwner]) {
        const result = await http().get(physical()).set('Authorization', bearer(session)).expect(200);
        expect(result.headers['cache-control']).toContain('no-store');
        expect(result.body.data).toMatchObject({
          mode: 'NON_EXECUTABLE_PREVIEW', consistency: 'NON_ATOMIC', eligibility: 'INELIGIBLE',
          reason: 'LEGACY_OR_NOT_ENROLLED', physicalExecution: 'BLOCKED', financialExecution: 'BLOCKED',
          evidence: 'NOT_RECORDED', actualCourierCost: null, courierPayment: 'NOT_RECORDED',
          actions: { reserve: 'BLOCKED', issueToCourier: 'BLOCKED', dispatch: 'BLOCKED', technicianReceipt: 'BLOCKED' },
        });
        expect(result.body.data.blockers).toContain('PHYSICAL_ACTIVATION_CLOSED');
      }
      await http().get(physical()).expect(401);
      for (const session of [admin, manager]) await http().get(physical()).set('Authorization', bearer(session)).expect(403);
      await http().get(physical('not-a-uuid')).set('Authorization', bearer(owner)).expect(400);
      const denied = await http().get(physical()).set('Authorization', bearer(outsider)).expect(404);
      const missing = await http().get(physical(randomUUID())).set('Authorization', bearer(owner)).expect(404);
      expect(denied.body.error).toEqual(missing.body.error);
      for (const action of ['reserve','issue','dispatch','receipt']) {
        await http().post(`/api/v1/part-requests/${requestId}/delivery-physical/${action}`).set('Authorization', bearer(technicianOwner)).send({ shippingApproved: true }).expect(404);
      }
      expect(await db.getRepository('WarehouseDeliveryEvent').count()).toBe(before);
      expect(await db.query('SELECT * FROM warehouse_delivery_cohorts WHERE part_request_id=$1', [requestId])).toHaveLength(0);
    });

    it('enforces JWT, role, malformed ID and indistinguishable non-owner/not-found denial', async () => {
      await http().get(previewPath()).expect(401);
      await http()
        .get(previewPath())
        .set('Authorization', bearer(admin))
        .expect(403);
      await http()
        .get(previewPath())
        .set('Authorization', bearer(manager))
        .expect(403);
      await http()
        .get(previewPath('not-a-uuid'))
        .set('Authorization', bearer(owner))
        .expect(400);
      const deniedCustomer = await http()
        .get(previewPath())
        .query({ actorId: owner.user.id, role: 'customer', approved: 'true' })
        .set('Authorization', bearer(outsider))
        .expect(404);
      const deniedTechnician = await http()
        .get(previewPath())
        .set('Authorization', bearer(technicianOutsider))
        .expect(404);
      const missing = await http()
        .get(previewPath(randomUUID()))
        .set('Authorization', bearer(owner))
        .expect(404);
      expect(deniedCustomer.body.error).toEqual(missing.body.error);
      expect(deniedTechnician.body.error).toEqual(missing.body.error);
    });

    it('rechecks live assignment and DB actor status rather than trusting a stale JWT', async () => {
      await db.getRepository('TechnicianAssignment').update(assignmentId, {
        isActive: false,
      });
      try {
        for (const session of [owner, technicianOwner]) {
          await http()
            .get(previewPath())
            .set('Authorization', bearer(session))
            .expect(404);
        }
      } finally {
        await db.getRepository('TechnicianAssignment').update(assignmentId, {
          isActive: true,
        });
      }

      await db.query('UPDATE users SET status = $1 WHERE id = $2', [
        'locked',
        owner.user.id,
      ]);
      try {
        await http()
          .get(previewPath())
          .set('Authorization', bearer(owner))
          .expect(401);
      } finally {
        await db.query('UPDATE users SET status = $1 WHERE id = $2', [
          'active',
          owner.user.id,
        ]);
      }

      await http()
        .get(previewPath())
        .set('Authorization', bearer(owner))
        .expect(200);
    });

    it('does not create any consent journal, invoice, evidence, courier, or ledger record', async () => {
      const count = async (table: string, field: string, id: string) => {
        const names = new Set([
          'delivery_consent_sessions',
          'delivery_consent_commands',
          'delivery_evidence_records',
          'invoices',
        ]);
        if (!names.has(table) || !['part_request_id', 'service_order_id'].includes(field))
          throw new Error('Unsafe table query in CI fixture');
        const rows = await db.query(`SELECT count(*)::integer AS total FROM ${table} WHERE ${field} = $1`, [id]);
        return rows[0].total as number;
      };
      const before = await Promise.all([
        count('delivery_consent_sessions', 'part_request_id', requestId),
        count('delivery_consent_commands', 'part_request_id', requestId),
        count('delivery_evidence_records', 'part_request_id', requestId),
        count('invoices', 'service_order_id', serviceOrderId),
      ]);
      expect(before).toEqual([0, 0, 0, 0]);
      await http()
        .get(previewPath())
        .set('Authorization', bearer(owner))
        .expect(200);
      const after = await Promise.all([
        count('delivery_consent_sessions', 'part_request_id', requestId),
        count('delivery_consent_commands', 'part_request_id', requestId),
        count('delivery_evidence_records', 'part_request_id', requestId),
        count('invoices', 'service_order_id', serviceOrderId),
      ]);
      expect(after).toEqual(before);
      await http()
        .post(`/api/v1/part-requests/${requestId}/delivery-consent/consents`)
        .set('Authorization', bearer(owner))
        .send({ accepted: true, sourceApproved: true })
        .expect(404);
    });
  });

  it('reverts all migrations, adopts legacy users and preserves account state and timestamps', async () => {
    const db = replayDb;
    // Empty W3 append-only tables still prohibit TRUNCATE CASCADE. Revert
    // these protected EMPTY schemas first, before resetting the legacy fixture.
    // No production immutability trigger is disabled by this disposable-schema replay.
    // Unwind newer migrations (e.g. warranty 0020) before W3 0013.
    const laterAppliedMigrations: Array<{ name: string }> = await db.query(
      'SELECT name FROM migrations WHERE timestamp > $1 ORDER BY timestamp DESC',
      [1793466000013],
    );
    const protectedMigrations = [
      ...laterAppliedMigrations.map((row) => row.name),
      'W3ShippingSafetyCap1793466000013',
      'W3DeductionPreparation1793466000012',
      'W3PrequoteCommission1793466000011',
      'DeliveryConditionalFeeTerms1793466000010',
      'W3DeliveryPolicyLifecycle1793466000009',
      'DeliveryZeroFeeOperations1793466000008',
      'WarehouseDeliveryPhysical1793466000007',
      'W3DeliveryOperatingPolicy1793466000006',
      'DeliveryConsentState1793466000005',
    ];
    for (const expected of protectedMigrations) {
      const latest = await db.query(
        'SELECT name FROM migrations ORDER BY timestamp DESC LIMIT 1',
      );
      expect(latest[0]?.name).toBe(expected);
      await db.undoLastMigration();
    }
    await db.query(`
      TRUNCATE TABLE
        booking_drafts,
        booking_draft_submit_receipts,
        verification_documents,
        technician_verifications,
        technician_profiles,
        booking_invitations,
        bookings
      CASCADE;
    `);
    for (let i = protectedMigrations.length; i < db.migrations.length; i++) await db.undoLastMigration();
    await db.query(
      `CREATE TYPE users_role_enum AS ENUM ('customer','technician','service_manager','admin')`,
    );
    await db.query(
      `CREATE TABLE users (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), email varchar NOT NULL UNIQUE, password_hash varchar NOT NULL, full_name varchar NOT NULL, phone_number varchar, role users_role_enum NOT NULL DEFAULT 'customer', is_active boolean NOT NULL DEFAULT true, created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now())`,
    );
    const legacyId = randomUUID();
    await db.query(
      `INSERT INTO users (id,email,password_hash,full_name,phone_number,is_active,created_at) VALUES ($1,'LEGACY@EXAMPLE.TEST','preserved-hash','Legacy User','+84987654321',false,'2025-01-02 03:04:05')`,
      [legacyId],
    );
    expect(await db.runMigrations()).toHaveLength(db.migrations.length);
    const [legacy] = await db.query('SELECT * FROM users WHERE id = $1', [
      legacyId,
    ]);
    expect(legacy).toMatchObject({
      email: 'legacy@example.test',
      password_hash: 'preserved-hash',
      phone_number: '0987654321',
      status: 'locked',
      is_active: false,
    });
    expect(legacy.created_at.toISOString()).toBe('2025-01-02T03:04:05.000Z');
    await db.undoLastMigration();
    expect(
      await db.query('SELECT id FROM users WHERE id = $1', [legacyId]),
    ).toHaveLength(1);
    expect(await db.runMigrations()).toHaveLength(1);
    for (let i = 0; i < db.migrations.length - 1; i++) await db.undoLastMigration();
    await expect(db.undoLastMigration()).rejects.toThrow('Refusing to drop an adopted users table');
    expect(await db.query('SELECT id FROM users WHERE id = $1', [legacyId])).toHaveLength(1);
    expect(await db.runMigrations()).toHaveLength(db.migrations.length - 1);
  }, 30_000);

  describe('W3 B3a Admin draft API (real JWT, PostgreSQL; no execution)', () => {
    const base = '/api/v1/admin/w3-delivery-policy';
    const params = {
      feeCeilingVnd: 50000,
      proposalReviewAfterMinutes: 30,
      courierEvidenceReviewAfterMinutes: 60,
    };
    let initial: { id: string; state: { revision: number } };
    let head: { id: string; state: { revision: number } };
    const count = (table: 'w3_delivery_policy_versions' | 'audit_logs') =>
      db.query(
        table === 'w3_delivery_policy_versions'
          ? 'SELECT count(*)::integer AS n FROM w3_delivery_policy_versions'
          : `SELECT count(*)::integer AS n FROM audit_logs WHERE resource_type = 'w3_delivery_policy'`,
      ).then((rows) => Number(rows[0].n));

    beforeAll(async () => {
      // Migration replay has its own DB; HTTP history stays intact.
      // Re-seed RBAC idempotently and issue a new signed test JWT.
      const { seedRbac } = runtimeRequire('./dist/database/seeds/seed-rbac.js');
      await seedRbac(db);
      const synthetic = async (role: 'admin' | 'customer' | 'technician'): Promise<Session> => {
        const user = await db.getRepository('User').save({
          email: `${randomUUID()}@example.test`,
          passwordHash: 'CI_ONLY_NON_LOGIN_CREDENTIAL',
          fullName: 'W3 Admin CI HTTP actor after migration replay',
          role,
          status: 'active',
          isActive: true,
        });
        return {
          user: { id: user.id, email: user.email },
          accessToken: jwt.sign(
            { sub: user.id, role },
            { secret: accessSecret, expiresIn: '15m' },
          ),
          refreshToken: '',
        };
      };
      admin = await synthetic('admin');
      customer = await synthetic('customer');
      technician = await synthetic('technician');
    }, 60_000);

    it('rejects missing, non-Admin, role-spoofed and locked JWT identities', async () => {
      await http().get(`${base}/current`).expect(401);
      for (const actor of [customer, technician]) {
        await http()
          .get(`${base}/current`)
          .set('Authorization', bearer(actor))
          .expect(403);
        await http()
          .post(`${base}/drafts`)
          .set('Authorization', bearer(actor))
          .send({ expectedRevision: 0, parameters: params })
          .expect(403);
      }
      const spoofed = jwt.sign(
        { sub: customer.user.id, role: 'admin' },
        { secret: accessSecret, expiresIn: '15m' },
      );
      await http()
        .get(`${base}/history`)
        .set('Authorization', `Bearer ${spoofed}`)
        .expect(403);
      const locked = await db.getRepository('User').save({
        email: `${randomUUID()}@example.test`,
        passwordHash: 'CI_ONLY_NON_LOGIN_CREDENTIAL',
        fullName: 'W3 locked CI Admin',
        role: 'admin',
        status: 'locked',
        isActive: true,
      });
      const lockedJwt = jwt.sign(
        { sub: locked.id, role: 'admin' },
        { secret: accessSecret, expiresIn: '15m' },
      );
      await http()
        .get(`${base}/current`)
        .set('Authorization', `Bearer ${lockedJwt}`)
        .expect(401);
    });

    it('starts without an effective policy and forbids activation endpoints', async () => {
      const current = await http()
        .get(`${base}/current`)
        .set('Authorization', bearer(admin))
        .expect(200);
      expect(current.headers['cache-control']).toContain('no-store');
      expect(current.body.data).toMatchObject({
        mode: 'NON_EXECUTABLE_PREVIEW',
        financialExecution: 'BLOCKED',
        effectivePolicy: null,
        draft: null,
      });
      expect(current.body.data.blockers).toEqual(expect.arrayContaining([
        'LEGAL_UNVERIFIED',
        'ACCOUNTING_UNVERIFIED',
        'WAREHOUSE_UNVERIFIED',
        'COURIER_UNVERIFIED',
        'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
        'FINANCE_CUTOVER_CLOSED',
      ]));
      const history = await http()
        .get(`${base}/history`)
        .set('Authorization', bearer(admin))
        .expect(200);
      expect(history.body.data.drafts).toEqual([]);
      await http()
        .post(`${base}/activate`)
        .set('Authorization', bearer(admin))
        .send({ force: true })
        .expect(404);
      await http()
        .post(`${base}/retire`)
        .set('Authorization', bearer(admin))
        .send({ force: true })
        .expect(404);
    });

    it('rejects unknown, dangerous and invalid Draft input before any write', async () => {
      const before = await count('w3_delivery_policy_versions');
      const valid = { expectedRevision: 0, parameters: params };
      const invalid = [
        { ...valid, status: 'ACTIVE' },
        { ...valid, parameters: { ...params, feeCeilingVnd: -1 } },
        { ...valid, parameters: { ...params, feeCeilingVnd: 0.5 } },
        { ...valid, parameters: { ...params, feeCeilingVnd: 9007199254740992 } },
        { ...valid, parameters: { ...params, sellerOfRecord: 'APPROVED' } },
      ];
      for (const body of invalid) {
        await http()
          .post(`${base}/drafts`)
          .set('Authorization', bearer(admin))
          .send(body)
          .expect(400);
      }
      // Raw preflight rejects prototype-key pollution before global DTO stripping.
      await http()
        .post(`${base}/drafts`)
        .set('Authorization', bearer(admin))
        .set('Content-Type', 'application/json')
        .send('{"expectedRevision":0,"parameters":{"feeCeilingVnd":50000,"proposalReviewAfterMinutes":30,"courierEvidenceReviewAfterMinutes":60},"__proto__":{"status":"ACTIVE"}}')
        .expect(400);
      expect(await count('w3_delivery_policy_versions')).toBe(before);
    });

    it('creates only one versioned DRAFT with mandatory transactional audit', async () => {
      const result = await http()
        .post(`${base}/drafts`)
        .set('Authorization', bearer(admin))
        .send({ expectedRevision: 0, parameters: params })
        .expect(201);
      expect(result.headers['cache-control']).toContain('no-store');
      expect(result.body.data).toMatchObject({
        financialExecution: 'BLOCKED',
        effectivePolicy: null,
        draft: { state: {
          status: 'DRAFT',
          revision: 1,
          mode: 'NON_EXECUTABLE_PREVIEW',
          policy: {
            kind: 'W3_DELIVERY_OPERATING_POLICY_V1',
            parameters: params,
          },
        } },
      });
      initial = result.body.data.draft;
      head = initial;
      expect(await count('w3_delivery_policy_versions')).toBe(1);
      expect(await count('audit_logs')).toBe(1);
      await http()
        .post(`${base}/drafts`)
        .set('Authorization', bearer(admin))
        .send({ expectedRevision: 0, parameters: params })
        .expect(409);
      expect(await count('w3_delivery_policy_versions')).toBe(1);
    });

    it('serializes concurrent PATCH CAS; returns history and never overwrites a version', async () => {
      const updates = await Promise.all([
        http()
          .patch(`${base}/drafts/${initial.id}`)
          .set('Authorization', bearer(admin))
          .send({ expectedRevision: 1, parameters: { ...params, feeCeilingVnd: 60000 } }),
        http()
          .patch(`${base}/drafts/${initial.id}`)
          .set('Authorization', bearer(admin))
          .send({ expectedRevision: 1, parameters: { ...params, feeCeilingVnd: 70000 } }),
      ]);
      expect(updates.map((x) => x.status).sort()).toEqual([200, 409]);
      head = updates.find((x) => x.status === 200)!.body.data.draft;
      expect(head.state.revision).toBe(2);
      await http()
        .patch(`${base}/drafts/${initial.id}`)
        .set('Authorization', bearer(admin))
        .send({ expectedRevision: 1, parameters: params })
        .expect(409);
      const history = await http()
        .get(`${base}/history?limit=2`)
        .set('Authorization', bearer(admin))
        .expect(200);
      expect(history.body.data.drafts.map((d: { state: { revision: number } }) => d.state.revision))
        .toEqual([2, 1]);
      expect(history.body.data.drafts[1].id).toBe(initial.id);
      expect(await count('w3_delivery_policy_versions')).toBe(2);
      expect(await count('audit_logs')).toBe(2);
    });

    it('produces only hypothetical impact for a historical Draft and keeps finances blocked', async () => {
      const before = [await count('w3_delivery_policy_versions'), await count('audit_logs')];
      const result = await http()
        .post(`${base}/preview`)
        .set('Authorization', bearer(admin))
        .send({
          draftId: initial.id,
          expectedRevision: 1,
          samples: [{
            proposalId: 'ci-proposal-1',
            proposalVersion: 1,
            shippingFeeVnd: 20000,
            proposalAgeMinutes: 35,
            courierEvidenceAgeMinutes: null,
          }],
        })
        .expect(200);
      expect(result.body.data).toMatchObject({
        mode: 'NON_EXECUTABLE_PREVIEW',
        hypotheticalOnly: true,
        financialExecution: 'BLOCKED',
        effectivePolicy: null,
        draftId: initial.id,
        proposals: [{
          proposalId: 'ci-proposal-1',
          customerShippingShare: 14000,
          technicianShippingShare: 6000,
        }],
      });
      expect(result.body.data.blockers).toContain('FINANCE_CUTOVER_CLOSED');
      expect([await count('w3_delivery_policy_versions'), await count('audit_logs')])
        .toEqual(before);
      await http()
        .post(`${base}/preview`)
        .set('Authorization', bearer(admin))
        .send({ draftId: initial.id, expectedRevision: 2, samples: [] })
        .expect(409);
    });

    it('checks the underlying Admin config:update grant inside a real transaction', async () => {
      const [removed]: [{ role_id: string; permission_id: string }[], number] = await db.query(
        `DELETE FROM role_permissions rp USING roles r, permissions p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
        AND r.code = 'admin' AND p.code = 'config:update'
        RETURNING rp.role_id, rp.permission_id`,
      );
      expect(removed).toHaveLength(1);
      const before = await count('w3_delivery_policy_versions');
      try {
        await http()
          .patch(`${base}/drafts/${head.id}`)
          .set('Authorization', bearer(admin))
          .send({ expectedRevision: 2, parameters: params })
          .expect(403);
        expect(await count('w3_delivery_policy_versions')).toBe(before);
      } finally {
        for (const row of removed)
          await db.query(
            'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)',
            [row.role_id, row.permission_id],
          );
      }
      const current = await http()
        .get(`${base}/current`)
        .set('Authorization', bearer(admin))
        .expect(200);
      expect(current.body.data.draft.id).toBe(head.id);
      expect(current.body.data.financialExecution).toBe('BLOCKED');
    });

    it('requires JWT, current config:update and exact own server preview for operating activation', async () => {
      const path = `${base}/versions/${head.id}`;
      const body = { expectedRevision: 2, previewId: randomUUID(), acknowledged: true };
      for (const action of ['preview', 'activate', 'retire']) {
        await http().post(`${path}/${action}`).send(body).expect(401);
        await http().post(`${path}/${action}`).set('Authorization', bearer(customer)).send(body).expect(403);
      }
      await http().post(`${path}/activate`).set('Authorization', bearer(admin)).send(body).expect(409);
      await http().post(`${path}/activate`).set('Authorization', bearer(admin))
        .send({ ...body, legal: { status: 'VERIFIED', evidenceRef: 'fake' } }).expect(400);
      const preview = await http().post(`${path}/preview`).set('Authorization', bearer(admin))
        .send({ expectedRevision: 2, samples: [] }).expect(200);
      const receipt = preview.body.data.preview;
      expect(receipt.draftId).toBe(head.id);
      expect(receipt.impact).toMatchObject({ policyRevision: 2, policyStatus: 'DRAFT', financialExecution: 'BLOCKED' });
      const other = await db.getRepository('User').save({ email: `${randomUUID()}@example.test`, passwordHash: 'CI_ONLY_NON_LOGIN_CREDENTIAL', fullName: 'Other policy Admin', role: 'admin', status: 'active', isActive: true });
      const token = jwt.sign({ sub: other.id, role: 'admin' }, { secret: accessSecret, expiresIn: '15m' });
      await http().post(`${path}/activate`).set('Authorization', `Bearer ${token}`)
        .send({ ...body, previewId: receipt.id }).expect(409);
      await http().post(`${path}/activate`).set('Authorization', bearer(admin))
        .send({ ...body, expectedRevision: 1, previewId: receipt.id }).expect(409);
      const [removed]: [{ role_id: string; permission_id: string }[], number] = await db.query(`DELETE FROM role_permissions rp USING roles r, permissions p
        WHERE rp.role_id=r.id AND rp.permission_id=p.id AND r.code='admin' AND p.code='config:update' RETURNING rp.role_id,rp.permission_id`);
      try {
        await http().post(`${path}/activate`).set('Authorization', bearer(admin)).send({ ...body, previewId: receipt.id }).expect(403);
      } finally {
        for (const row of removed) await db.query('INSERT INTO role_permissions(role_id,permission_id) VALUES($1,$2)',[row.role_id,row.permission_id]);
      }
      const attempts = await Promise.all([1,2].map(() => http().post(`${path}/activate`).set('Authorization', bearer(admin)).send({ ...body, previewId: receipt.id })));
      expect(attempts.map(r => r.status).sort()).toEqual([200,409]);
      const active = attempts.find(r => r.status === 200)!.body.data.version;
      const [old] = await db.query('SELECT snapshot FROM w3_delivery_policy_versions WHERE id=$1',[head.id]);
      expect(active.state).toEqual({ ...old.snapshot, status: 'ACTIVE', revision: 3 });
      expect(active.activationPreviewId).toBe(receipt.id);
      expect(attempts.find(r => r.status === 200)!.body.data.blockers).toContain('FINANCE_CUTOVER_CLOSED');
      const current = await http().get(`${base}/current`).set('Authorization', bearer(admin)).expect(200);
      expect(current.body.data.draft).toBeNull();
      const history = await http().get(`${base}/history`).set('Authorization', bearer(admin)).expect(200);
      expect(history.body.data.drafts.map((d: any) => d.state.revision)).toEqual([2,1]);
      head = active;
    });

    it('keeps policy, preview and audit append-only without preventing unrelated audit writes', async () => {
      const before = await count('w3_delivery_policy_versions');
      for (const sql of [
        'UPDATE w3_delivery_policy_versions SET revision=revision',
        'DELETE FROM w3_delivery_policy_versions',
        'TRUNCATE w3_delivery_policy_versions',
        'UPDATE w3_delivery_policy_previews SET impact=impact',
        'DELETE FROM w3_delivery_policy_previews',
        'TRUNCATE w3_delivery_policy_previews',
        "UPDATE audit_logs SET action=action WHERE resource_type='w3_delivery_policy'",
        "DELETE FROM audit_logs WHERE resource_type='w3_delivery_policy_preview'",
        'TRUNCATE audit_logs',
      ]) await expect(db.query(sql)).rejects.toThrow();
      await expect(db.query(`INSERT INTO audit_logs(actor_role,action,resource_type,resource_id) VALUES('admin','FAKE','w3_delivery_policy',$1)`,[randomUUID()])).rejects.toThrow();
      const unrelated = await db.getRepository('AuditLog').save({ actorRole: 'admin', action: 'CI_UNRELATED', resourceType: 'ci_unrelated' });
      await db.query('UPDATE audit_logs SET action=$1 WHERE id=$2',['CI_UNRELATED_UPDATED',unrelated.id]);
      await db.query('DELETE FROM audit_logs WHERE id=$1',[unrelated.id]);
      expect(await count('w3_delivery_policy_versions')).toBe(before);
      const rows = await db.query(`SELECT relname,relrowsecurity FROM pg_class WHERE oid IN ('w3_delivery_policy_versions'::regclass,'w3_delivery_policy_previews'::regclass)`);
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.relrowsecurity)).toBe(true);
    });

    it('retires ACTIVE without a content bump, then permits only the additive API to write the next draft', async () => {
      const previous = head;
      const retired = await http().post(`${base}/versions/${head.id}/retire`).set('Authorization', bearer(admin)).send({ expectedRevision: 3 }).expect(200);
      expect(retired.body.data.version.state).toMatchObject({ status: 'RETIRED', revision: 4 });
      const [old] = await db.query('SELECT snapshot FROM w3_delivery_policy_versions WHERE id=$1',[previous.id]);
      expect(retired.body.data.version.state.policy).toEqual(old.snapshot.policy);
      const next = await http().post(`${base}/versions/drafts`).set('Authorization', bearer(admin)).send({ expectedRevision: 4, parameters: params }).expect(201);
      head = next.body.data.version;
      expect(head.state).toMatchObject({ status: 'DRAFT', revision: 5, policy: { version: 3 } });
      const current = await http().get(`${base}/current`).set('Authorization', bearer(admin)).expect(200);
      expect(current.body.data.draft).toBeNull();
      await http().patch(`${base}/drafts/${head.id}`).set('Authorization', bearer(admin)).send({ expectedRevision: 5, parameters: params }).expect(409);
      const live = await http().get(`${base}/versions/current`).set('Authorization', bearer(admin)).expect(200);
      expect(live.body.data.version.id).toBe(head.id);
      const history = await http().get(`${base}/versions/history`).set('Authorization', bearer(admin)).expect(200);
      expect(history.body.data.versions.map((v: any) => v.state.status)).toEqual(['DRAFT','RETIRED','ACTIVE','DRAFT','DRAFT']);
      const [gate] = await db.query('SELECT enabled FROM warehouse_delivery_gate');
      expect(gate.enabled).toBe(false);
      const [shares] = await db.query(`SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='invoices'::regclass AND conname='ck_invoice_shipping_shares'`);
      expect(shares.convalidated).toBe(true);
      expect(shares.definition).toContain('w3_invoice_shipping_totals');
      const category = await createCategory();
      const service = await createService(category.id);
      const booking = await db.getRepository('Booking').save({ customerId: customer.user.id, serviceId: service.id,
        description: 'Policy lifecycle is not delivery provenance', status: 'matched' });
      const order = await db.getRepository('ServiceOrder').save({ bookingId: booking.id, code: `W3-GUARD-${randomUUID()}`, status: 'under_repair' });
      await expect(db.query(`INSERT INTO invoices(service_order_id,labor_total,commission_amount,shipping_fee,grand_total,
        shipping_policy_version,customer_shipping_share,technician_shipping_share)
        VALUES($1,100000,10000,20000,114000,'W3_70_30_V1',14000,6000)`, [order.id]))
        .rejects.toMatchObject({ message: 'W3_SOURCE_REQUIRED', driverError: { code: 'P0001' } });
      expect(await db.getRepository('Invoice').countBy({ serviceOrderId: order.id })).toBe(0);
    });
  });


});
