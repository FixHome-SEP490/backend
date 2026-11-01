import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TechnicianVerification } from '../technician-verifications/entities/technician-verification.entity';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { TechnicianVerificationsService } from '../technician-verifications/technician-verifications.service';
import { Wallet } from '../wallet/entities/wallet.entity';
import { DocumentType, Role } from '../../shared/enums';

// Opt-in owns its disposable Docker database. Never accepts a DB URL or reads .env.
// Run: $env:FIXHOME_B30_PG='1'; npx vitest run src/modules/users/admin-technician-creation.pg.spec.ts
// @ts-ignore Vitest transforms this glob; application compilation uses CommonJS.
const entityModules = import.meta.glob('../**/*.entity.ts', { eager: true });

describe.skipIf(process.env.FIXHOME_B30_PG !== '1')('admin technician creation / isolated PostgreSQL 16', () => {
  const container = `fixhome-b30-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true }).trim();
  const actor = { id: randomUUID(), role: 'admin' };
  let db: DataSource;
  let service: UsersService;
  let started = false;

  beforeAll(async () => {
    docker('run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=fixhome_b30', 'postgres:16-alpine');
    started = true;
    const port = Number(docker('port', container, '5432/tcp').split(':').pop());
    if (!Number.isInteger(port) || port < 1) throw new Error('Invalid isolated database port');
    db = new DataSource({
      type: 'postgres', host: '127.0.0.1', port, username: 'postgres', database: 'fixhome_b30',
      entities: Object.values(entityModules).flatMap(module => Object.values(module as Record<string, unknown>))
        .filter((value): value is new () => object => typeof value === 'function'),
      synchronize: false, logging: false,
    });
    for (let attempt = 0; ; attempt++) {
      try { await db.initialize(); break; } catch (error) {
        if (attempt >= 40) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    // Minimal disposable schema from canonical column defaults/indexes; no app migrations.
    for (const entity of [User, TechnicianProfile, AuditLog, TechnicianVerification, VerificationDocument, Wallet]) {
      const metadata = db.getMetadata(entity);
      const quote = (name: string) => db.driver.escape(name);
      const columns = metadata.columns.map(column => {
        const type = column.type === 'enum' ? 'varchar' : db.driver.normalizeType(column);
        const defaultSql = column.isGenerated && column.generationStrategy === 'uuid'
          ? 'gen_random_uuid()' : db.driver.normalizeDefault(column);
        return `${quote(column.databaseName)} ${type}${column.isNullable ? '' : ' NOT NULL'}${defaultSql === undefined ? '' : ` DEFAULT ${defaultSql}`}`;
      });
      columns.push(`PRIMARY KEY (${metadata.primaryColumns.map(column => quote(column.databaseName)).join(',')})`);
      await db.query(`CREATE TABLE ${quote(metadata.tableName)} (${columns.join(',')})`);
      for (const index of metadata.indices.filter(index => index.isUnique)) {
        await db.query(`CREATE UNIQUE INDEX ${quote(index.name)} ON ${quote(metadata.tableName)} (${index.columns.map(column => quote(column.databaseName)).join(',')})${index.where ? ` WHERE ${index.where}` : ''}`);
      }
    }
    await db.query('ALTER TABLE technician_profiles ADD FOREIGN KEY (user_id) REFERENCES users(id)');
    service = new UsersService(db.getRepository(User), new AuditLogService(db.getRepository(AuditLog)), {} as never);
  }, 120_000);

  beforeEach(async () => {
    await db.query('DROP TRIGGER IF EXISTS b30_fail ON technician_profiles');
    await db.query('DROP TRIGGER IF EXISTS b30_fail ON audit_logs');
    await db.query('TRUNCATE technician_profiles, audit_logs, technician_verifications, verification_documents, wallets, users');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    try { if (db?.isInitialized) await db.destroy(); }
    finally { if (started) docker('rm', '-f', container); }
  });

  const input = (email = 'tech@example.test', phoneNumber?: string) => ({ email, fullName: 'Test Technician', phoneNumber });
  const counts = async () => Promise.all([User, TechnicianProfile, AuditLog].map(entity => db.getRepository(entity).count()));

  it('persists exactly one linked profile with canonical safe defaults and no credentials in audit', async () => {
    const result = await service.createTechnician(input(), actor);
    expect(await counts()).toEqual([1, 1, 1]);
    const profile = await db.getRepository(TechnicianProfile).findOneByOrFail({ userId: result.user.id });
    expect(profile).toMatchObject({
      verificationStatus: 'pending', isAvailable: false, onboardingStatus: 'not_started', onboardingStep: 1,
      yearsExperience: 0, averageRating: '0', ratingCount: 0, reliabilityScore: 100,
      autoAcceptInvitations: false, serviceRadiusKm: '10',
    });
    const audit = await db.getRepository(AuditLog).findOneByOrFail({ resourceId: result.user.id });
    expect(audit).toMatchObject({ action: 'TECHNICIAN_ACCOUNT_CREATED', actorUserId: actor.id, actorRole: 'admin' });
    expect(JSON.stringify(audit)).not.toContain(result.tempPassword);
    expect(JSON.stringify(audit)).not.toContain(result.user.passwordHash);
    const persisted = await db.query('SELECT row_to_json(u)::text AS body FROM users u');
    expect(persisted[0].body.includes(result.tempPassword)).toBe(false);
  });

  it.each(['technician_profiles', 'audit_logs'])('rolls back user/profile/audit when %s insert fails', async table => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await db.query(`CREATE OR REPLACE FUNCTION b30_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'b30 injected failure'; END $$`);
    await db.query(`CREATE TRIGGER b30_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION b30_fail_insert()`);
    const outcome = await service.createTechnician(input(), actor).then(() => 'resolved', () => 'rejected');
    expect(outcome).toBe('rejected');
    expect(await counts()).toEqual([0, 0, 0]);
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/tempPassword|passwordHash|password_hash/);
  });

  it.each(['email', 'phone'])('handles concurrent duplicate %s with one complete account and safe 409', async kind => {
    // Both real DB pre-checks see absence before either call is allowed to insert.
    const repo = db.getRepository(User);
    const findOne = repo.findOne.bind(repo);
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(repo, 'findOne').mockImplementation(async options => {
      const row = await findOne(options);
      const where = options.where as Record<string, unknown>;
      if ((kind === 'email' && 'email' in where) || (kind === 'phone' && 'phoneNumber' in where)) {
        if (++arrivals === 2) release();
        await ready;
      }
      return row;
    });
    const results = await Promise.allSettled([
      service.createTechnician(input('tech@example.test', kind === 'phone' ? '0912345678' : undefined), actor),
      service.createTechnician(input(kind === 'email' ? 'TECH@example.test' : 'other@example.test', kind === 'phone' ? '+84912345678' : undefined), actor),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason instanceof ConflictException).toBe(true);
    expect(failed.reason.getStatus()).toBe(409);
    expect(JSON.stringify(failed.reason.getResponse())).not.toMatch(/password|INSERT|23505|parameters/i);
    expect(await counts()).toEqual([1, 1, 1]);
  }, 15_000);

  it('allows multiple technicians without a phone number', async () => {
    await service.createTechnician(input(), actor);
    await service.createTechnician(input('other@example.test'), actor);
    expect(await counts()).toEqual([2, 2, 2]);
  });

  it.each(['approve', 'reject'])('lets a newly created technician submit KYC and %s without a missing-profile 404', async decision => {
    const { user } = await service.createTechnician(input(), actor);
    await db.getRepository(User).insert({ id: actor.id, email: 'admin@example.test', fullName: 'Test Admin', role: Role.ADMIN });
    const kyc = new TechnicianVerificationsService(
      db.getRepository(TechnicianVerification), db.getRepository(VerificationDocument),
      new AuditLogService(db.getRepository(AuditLog)),
      { validateObjectPath: () => undefined } as never, // no external storage operation in this test
    );
    expect(await kyc.isVerified(user.id)).toBe(false);
    const submitted = await kyc.submitVerification(user.id, { documents: [DocumentType.CITIZEN_ID_FRONT, DocumentType.FACE_PHOTO].map(documentType => ({
      documentType, storageObjectPath: `kyc/${user.id}/${documentType}.jpg`,
      fileName: `${documentType}.jpg`, mimeType: 'image/jpeg', fileSize: 1024,
    })) });
    expect(submitted.status).toBe('pending');
    if (decision === 'approve') await kyc.approveVerification(submitted.id, actor.id);
    else await kyc.rejectVerification(submitted.id, actor.id, { rejectionReason: 'Test rejection reason' });
    const profile = await db.getRepository(TechnicianProfile).findOneByOrFail({ userId: user.id });
    expect(profile.verificationStatus).toBe(decision === 'approve' ? 'verified' : 'rejected');
    expect(profile.onboardingStatus).toBe(decision === 'approve' ? 'approved' : 'rejected');
    expect(await db.getRepository(Wallet).count()).toBe(decision === 'approve' ? 1 : 0);
  });
});
