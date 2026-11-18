import { describe, expect, it, vi } from 'vitest';
import { AdminRbacService } from './admin-rbac.service';
import { SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS } from './service-manager-permissions';

function build(grantedCodes: string[]) {
  const qb: Record<string, unknown> = {};
  for (const m of ['innerJoin', 'select', 'where', 'andWhere', 'insert', 'values', 'orIgnore']) qb[m] = vi.fn(() => qb);
  qb.getRawMany = vi.fn().mockResolvedValue(grantedCodes.map((code) => ({ code })));
  qb.execute = vi.fn().mockResolvedValue(undefined);
  const rolePermissionRepo = { createQueryBuilder: vi.fn(() => qb), delete: vi.fn().mockResolvedValue({ affected: 1 }) };
  const roleRepo = { findOne: vi.fn().mockResolvedValue({ id: 'role-sm' }) };
  const permissionRepo = { findOne: vi.fn().mockResolvedValue({ id: 'perm-1' }) };
  const rbac = { invalidateCache: vi.fn() };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new AdminRbacService(roleRepo as never, permissionRepo as never, rolePermissionRepo as never, rbac as never, audit as never);
  return { service, qb, rolePermissionRepo, rbac, audit };
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
