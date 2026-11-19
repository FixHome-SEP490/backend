// src/modules/rbac/rbac.module.ts
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  RoleEntity,
  Permission,
  RolePermission,
  UserScope,
} from './entities';
import { RbacService } from './rbac.service';
import { AdminRbacService } from './admin-rbac.service';
import { AdminRbacController } from './admin-rbac.controller';

/**
 * D-18: Global RBAC module.
 * - Provides RbacService for permission checks (used by PermissionGuard).
 * - Entities: roles, permissions, role_permissions, user_scopes.
 * - Seeded at Phase 0 from P5.2 permission catalog.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([RoleEntity, Permission, RolePermission, UserScope]),
  ],
  controllers: [AdminRbacController],
  providers: [RbacService, AdminRbacService],
  exports: [RbacService],
})
export class RbacModule {}
