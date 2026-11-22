import { describe, expect, it, vi } from 'vitest';
import { RbacService, effectivePermissions } from './rbac.service';

const smRole = new Set(['order:cancel', 'support:read_all', 'service:read']);

describe('BUG 261 per-account permissions over the role', () => {
  it('follows the role when the account has no setting', () => {
    expect([...effectivePermissions('service_manager', smRole, null)].sort()).toEqual([...smRole].sort());
  });

  it('turns a toggleable permission off or on for the account only', () => {
    const perms = effectivePermissions('service_manager', smRole, { 'order:cancel': false, 'strike:waive': true });
    expect(perms.has('order:cancel')).toBe(false);
    expect(perms.has('strike:waive')).toBe(true);
    expect(perms.has('support:read_all')).toBe(true);
    expect(smRole.has('order:cancel')).toBe(true);
  });

  it('never grants or removes a code outside the toggleable list', () => {
    const perms = effectivePermissions('service_manager', smRole, { 'config:update': true, 'service:read': false } as never);
    expect(perms.has('config:update')).toBe(false);
    expect(perms.has('service:read')).toBe(true);
  });

  it('ignores overrides for other roles and non-boolean values', () => {
    expect(effectivePermissions('admin', new Set(['x']), { 'order:cancel': true }).has('order:cancel')).toBe(false);
    expect(effectivePermissions('service_manager', smRole, { 'order:cancel': 'no' } as never).has('order:cancel')).toBe(true);
  });

  it('checks from the cache with two queries per refresh, not per request', async () => {
    const rpRepo = { find: vi.fn().mockResolvedValue([
      { role: { code: 'service_manager' }, permission: { code: 'order:cancel' } },
    ]) };
    const scopeRepo = { find: vi.fn().mockResolvedValue([{ userId: 'sm-a', permissionOverrides: { 'order:cancel': false } }]) };
    const service = new RbacService(rpRepo as never, scopeRepo as never);
    await service.onModuleInit();
    expect(await service.hasPermission('service_manager', 'order:cancel', 'sm-a')).toBe(false);
    expect(await service.hasPermission('service_manager', 'order:cancel', 'sm-b')).toBe(true);
    expect(await service.hasPermission('service_manager', 'order:cancel')).toBe(true);
    expect(await service.getPermissionsForUser('service_manager', 'sm-a')).toEqual([]);
    expect(rpRepo.find).toHaveBeenCalledTimes(1);
    expect(scopeRepo.find).toHaveBeenCalledTimes(1);
    service.invalidateCache();
    await service.hasPermission('service_manager', 'order:cancel', 'sm-a');
    expect(scopeRepo.find).toHaveBeenCalledTimes(2);
  });
});
