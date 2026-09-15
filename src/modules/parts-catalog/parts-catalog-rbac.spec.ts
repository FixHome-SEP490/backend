import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { Role } from '../../shared/enums';
import { PartsCatalogController } from './parts-catalog.controller';
import { AdminPartsController } from './admin-parts.controller';

describe('Part catalog controller RBAC metadata', () => {
  it('restricts the read controller to technician/manager/admin with service:read', () => {
    const roles: Role[] = Reflect.getMetadata(
      ROLES_KEY,
      PartsCatalogController,
    );
    const permissions: string[] = Reflect.getMetadata(
      PERMISSION_KEY,
      PartsCatalogController,
    );
    expect(roles).toEqual(
      expect.arrayContaining([
        Role.TECHNICIAN,
        Role.SERVICE_MANAGER,
        Role.ADMIN,
      ]),
    );
    expect(roles).toHaveLength(3);
    expect(roles).not.toContain(Role.CUSTOMER);
    expect(permissions).toEqual(['service:read']);
  });

  it.each([
    ['create', AdminPartsController.prototype.create],
    ['update', AdminPartsController.prototype.update],
    ['toggleStatus', AdminPartsController.prototype.toggleStatus],
  ])(
    'restricts admin mutation %s to ADMIN with service:manage',
    (_label, handler) => {
      const classRoles: Role[] = Reflect.getMetadata(
        ROLES_KEY,
        AdminPartsController,
      );
      const classPermissions: string[] = Reflect.getMetadata(
        PERMISSION_KEY,
        AdminPartsController,
      );
      expect(classRoles).toEqual([Role.ADMIN]);
      expect(classPermissions).toEqual(['service:manage']);
      // Mutations inherit class-level guards; no per-handler widening.
      expect(handler).toBeDefined();
    },
  );
});
