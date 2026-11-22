// src/modules/rbac/rbac.module.ts
import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  RoleEntity,
  Permission,
  RolePermission,
  UserScope,
} from './entities';
import { User } from '../users/entities/user.entity';
import { RbacService } from './rbac.service';
import { AdminRbacService } from './admin-rbac.service';
import { AdminRbacController } from './admin-rbac.controller';
import { AdminRbacAccountsController } from './admin-rbac-accounts.controller';

/**
 * D-18: Global RBAC module.
 * - Provides RbacService for permission checks (used by PermissionGuard).
 * - Entities: roles, permissions, role_permissions, user_scopes.
 * - Seeded at Phase 0 from P5.2 permission catalog.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([RoleEntity, Permission, RolePermission, UserScope, User]),
  ],
  controllers: [AdminRbacController, AdminRbacAccountsController],
  providers: [RbacService, AdminRbacService],
  exports: [RbacService],
})
export class RbacModule {}
