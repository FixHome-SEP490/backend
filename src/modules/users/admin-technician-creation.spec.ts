import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictException, Logger } from '@nestjs/common';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service';
import { User } from './entities/user.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AdminUsersController } from './admin-users.controller';

const dto = { email: ' Tech@Example.test ', phoneNumber: '+84912345678', fullName: ' Test Technician ' };
const actor = { id: 'admin-test', role: 'admin' };

// Storage double only: real UsersService, audit service, hashing and response mapper.
// PostgreSQL rollback/unique enforcement is covered separately in the opt-in spec.
function fixture(failure?: 'profile' | 'audit' | 'race' | 'user') {
  let rows: { users: any[]; profiles: any[]; audits: any[] } = { users: [], profiles: [], audits: [] };
  const repository = (kind: keyof typeof rows, state: typeof rows) => ({
    findOne: vi.fn(async ({ where }) => state[kind].find(row => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
    create: (value: object) => ({ ...value }),
    save: async (value: any) => {
      if (kind === 'profiles' && failure === 'profile') throw new Error('profile insert failed');
      if (kind === 'users' && failure === 'race') {
        throw new QueryFailedError('INSERT users', [value.passwordHash], Object.assign(new Error('duplicate'), { code: '23505' }));
      }
      if (kind === 'users' && failure === 'user') throw new Error('user insert failed');
      const saved = { id: `${kind}-1`, ...value };
      state[kind].push(saved);
      return saved;
    },
  });
  const outside = repository('users', rows);
  const insert = async (_entity: unknown, entry: object, state = rows) => {
    if (failure === 'audit') throw new Error('audit insert failed');
    state.audits.push(entry);
    return {};
  };
  const audit = new AuditLogService({ insert: (entry: object) => insert(AuditLog, entry) } as Repository<AuditLog>);
  const userRepo = Object.assign(outside, {
    manager: {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => {
        const pending = structuredClone(rows);
        const manager = {
          getRepository: (entity: unknown) => {
            if (entity === User) return repository('users', pending);
            if (entity === TechnicianProfile) return repository('profiles', pending);
            throw new Error('Unexpected repository');
          },
          insert: (entity: unknown, entry: object) => insert(entity, entry, pending),
        } as unknown as EntityManager;
        const result = await work(manager);
        rows = pending;
        return result;
      },
    },
  });
  const service = new UsersService(userRepo as unknown as Repository<User>, audit, {} as never);
  return { service, rows: () => rows, outside };
}

afterEach(() => vi.restoreAllMocks());

describe('admin technician creation atomicity', () => {
  it('creates a linked, unavailable and unverified profile with a credential-free audit', async () => {
    const f = fixture();
    const { user, tempPassword } = await f.service.createTechnician(dto, actor);
    expect(f.rows().users).toHaveLength(1);
    expect(f.rows().profiles).toEqual([expect.objectContaining({ userId: user.id, isAvailable: false, verificationStatus: 'pending' })]);
    expect(user).toMatchObject({ email: 'tech@example.test', fullName: 'Test Technician', phoneNumber: '0912345678', role: 'technician', status: 'active', isEmailVerified: true });
    expect(await bcrypt.compare(tempPassword, user.passwordHash!)).toBe(true);
    expect(f.rows().audits).toEqual([expect.objectContaining({
      actorUserId: actor.id, actorRole: 'admin', action: 'TECHNICIAN_ACCOUNT_CREATED',
      resourceType: 'user', resourceId: user.id, after: { email: 'tech@example.test', fullName: 'Test Technician' },
    })]);
    expect(JSON.stringify(f.rows())).not.toContain(tempPassword);
    expect(JSON.stringify(f.rows().audits)).not.toContain(user.passwordHash);
  });

  it.each(['profile', 'audit', 'user'] as const)('rolls back all creation rows on %s failure', async failure => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const f = fixture(failure);
    const outcome = await f.service.createTechnician(dto, actor).then(() => 'resolved', error => error.message);
    expect(outcome).toBe(`${failure} insert failed`);
    expect(f.rows()).toEqual({ users: [], profiles: [], audits: [] });
  });

  it.each(['email', 'phoneNumber'])('rejects an existing %s without writing', async key => {
    const f = fixture();
    f.outside.findOne.mockImplementation(async ({ where }) => key in where ? { id: 'existing' } : null);
    await expect(f.service.createTechnician(dto, actor)).rejects.toBeInstanceOf(ConflictException);
    expect(f.rows()).toEqual({ users: [], profiles: [], audits: [] });
  });

  it('maps a database unique race to a safe conflict and leaves no partial rows', async () => {
    const f = fixture('race');
    await expect(f.service.createTechnician(dto, actor)).rejects.toBeInstanceOf(ConflictException);
    expect(f.rows()).toEqual({ users: [], profiles: [], audits: [] });
  });

  it('returns the one-time credential only through the existing response, without the hash', async () => {
    const f = fixture();
    const response = await new AdminUsersController(f.service).createTechnician(dto, actor);
    expect(response.data.tempPassword).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(response.data.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(f.rows())).not.toContain(response.data.tempPassword);
  });
});
