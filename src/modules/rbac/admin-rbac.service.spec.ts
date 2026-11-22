import { describe, expect, it, vi } from 'vitest';
import { AdminRbacService } from './admin-rbac.service';
import { SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS } from './service-manager-permissions';

function build(grantedCodes: string[], account: unknown = { id: 'sm-1', fullName: 'SM', email: 'sm@x', isActive: true, role: 'service_manager', overrides: null }) {
  const qb: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'select', 'where', 'andWhere', 'insert', 'values', 'orIgnore']) qb[m] = vi.fn(() => qb);
  qb.getRawMany = vi.fn().mockResolvedValue(grantedCodes.map((code) => ({ code })));
  qb.execute = vi.fn().mockResolvedValue(undefined);
  const rolePermissionRepo = { createQueryBuilder: vi.fn(() => qb), delete: vi.fn().mockResolvedValue({ affected: 1 }) };
  const roleRepo = { findOne: vi.fn().mockResolvedValue({ id: 'role-sm' }) };
  const permissionRepo = { findOne: vi.fn().mockResolvedValue({ id: 'perm-1' }) };
  const rbac = { invalidateCache: vi.fn() };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const userQb: Record<string, unknown> = {};
  for (const m of ['leftJoin', 'select', 'addSelect', 'where', 'orderBy']) userQb[m] = vi.fn(() => userQb);
  userQb.getRawOne = vi.fn().mockResolvedValue(account);
  const userRepo = { createQueryBuilder: vi.fn(() => userQb) };
  const scopeRepo = { query: vi.fn().mockResolvedValue(undefined), update: vi.fn().mockResolvedValue({ affected: 1 }) };
  const service = new AdminRbacService(roleRepo as never, permissionRepo as never, rolePermissionRepo as never, rbac as never, audit as never, scopeRepo as never, userRepo as never);
  return { service, qb, rolePermissionRepo, rbac, audit, scopeRepo };
}

describe('BUG 177 service manager permissions', () => {
  it('lists every configurable permission with its current state', async () => {
    const { service } = build(['order:cancel']);
    const rows = await service.listServiceManagerPermissions();
    expect(rows).toHaveLength(SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS.length);
    expect(rows.find((r) => r.code === 'order:cancel')?.granted).toBe(true);
    expect(rows.find((r) => r.code === 'support:resolve')?.granted).toBe(false);
  });

  it('revokes, refreshes the permission cache and writes the audit log', async () => {
    const { service, rolePermissionRepo, rbac, audit } = build([]);
    await service.setServiceManagerPermission('order:cancel', false, { id: 'admin-1', role: 'admin' });
    expect(rolePermissionRepo.delete).toHaveBeenCalledWith({ roleId: 'role-sm', permissionId: 'perm-1' });
    expect(rbac.invalidateCache).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RBAC_PERMISSION_REVOKED' }));
  });

  it('grants idempotently', async () => {
    const { service, qb } = build([]);
    await service.setServiceManagerPermission('order:cancel', true, { id: 'admin-1', role: 'admin' });
    expect(qb.orIgnore).toHaveBeenCalled();
    expect(qb.values).toHaveBeenCalledWith({ roleId: 'role-sm', permissionId: 'perm-1' });
  });

  it.each(['config:update', 'user:lock', 'service:manage', 'order:read_related', '', '💥'])(
    'refuses a permission outside the service manager list: %s',
    async (code) => {
      const { service, rolePermissionRepo } = build([]);
      await expect(service.setServiceManagerPermission(code, true, { id: 'a', role: 'admin' })).rejects.toThrow();
      expect(rolePermissionRepo.delete).not.toHaveBeenCalled();
    },
  );
});

describe('BUG 261 permissions of one service manager account', () => {
  it('shows the role default and the account setting side by side', async () => {
    const { service } = build(['order:cancel', 'support:read_all'], { id: 'sm-1', fullName: 'SM', email: 'sm@x', isActive: true, role: 'service_manager', overrides: { 'order:cancel': false } });
    const { user, permissions } = await service.getAccountPermissions('sm-1');
    expect(user.customized).toBe(true);
    expect(permissions.find((p) => p.code === 'order:cancel')).toMatchObject({ granted: false, roleGranted: true, overridden: true });
    expect(permissions.find((p) => p.code === 'support:read_all')).toMatchObject({ granted: true, overridden: false });
  });

  it('merges one code into the account setting, refreshes the cache and audits', async () => {
    const { service, scopeRepo, rbac, audit, rolePermissionRepo } = build([]);
    await service.setAccountPermission('sm-1', 'order:cancel', false, { id: 'admin-1', role: 'admin' });
    expect(scopeRepo.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), ['sm-1', 'order:cancel', false]);
    expect(rolePermissionRepo.delete).not.toHaveBeenCalled();
    expect(rbac.invalidateCache).toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RBAC_ACCOUNT_PERMISSION_REVOKED', resourceId: 'sm-1' }));
  });

  it('resets the account back to the role', async () => {
    const { service, scopeRepo, audit } = build([]);
    await service.resetAccountPermissions('sm-1', { id: 'admin-1', role: 'admin' });
    expect(scopeRepo.update).toHaveBeenCalledWith({ userId: 'sm-1' }, { permissionOverrides: null });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RBAC_ACCOUNT_PERMISSION_RESET' }));
  });

  it.each([null, { id: 'c', fullName: 'C', email: 'c@x', isActive: true, role: 'customer', overrides: null }])(
    'refuses an account that is not a service manager',
    async (account) => {
      const { service, scopeRepo } = build([], account);
      await expect(service.setAccountPermission('x', 'order:cancel', false, { id: 'a', role: 'admin' })).rejects.toThrow();
      expect(scopeRepo.query).not.toHaveBeenCalled();
    },
  );

  it('refuses a code outside the service manager list for an account', async () => {
    const { service, scopeRepo } = build([]);
    await expect(service.setAccountPermission('sm-1', 'config:update', true, { id: 'a', role: 'admin' })).rejects.toThrow();
    expect(scopeRepo.query).not.toHaveBeenCalled();
  });
});
