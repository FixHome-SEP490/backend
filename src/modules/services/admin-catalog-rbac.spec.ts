import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../shared/enums';
import { AdminCategoriesController } from '../categories/admin-categories.controller';
import { AdminServicesController } from './admin-services.controller';

function createContext(
  controller: Function,
  handler: Function,
  role: Role,
): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => ({ user: { id: 'user-1', role } }),
    }),
  } as unknown as ExecutionContext;
}

describe('Admin service catalog RBAC', () => {
  const guard = new RolesGuard(new Reflector());

  it.each([
    ['service categories', AdminCategoriesController, AdminCategoriesController.prototype.create],
    ['services', AdminServicesController, AdminServicesController.prototype.create],
  ])('denies Service Manager mutation access to %s', (_label, controller, handler) => {
    const context = createContext(controller, handler, Role.SERVICE_MANAGER);
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it.each([
    ['service categories', AdminCategoriesController, AdminCategoriesController.prototype.create],
    ['services', AdminServicesController, AdminServicesController.prototype.create],
  ])('allows Admin mutation access to %s', (_label, controller, handler) => {
    const context = createContext(controller, handler, Role.ADMIN);
    expect(guard.canActivate(context)).toBe(true);
  });
});
