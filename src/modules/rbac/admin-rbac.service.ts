import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Permission, RoleEntity, RolePermission, UserScope } from './entities';
import { User } from '../users/entities/user.entity';
import { RbacService } from './rbac.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import {
  SERVICE_MANAGER_ROLE,
  SERVICE_MANAGER_TOGGLEABLE_CODES,
  SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS,
} from './service-manager-permissions';

export interface ServiceManagerAccountRow {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
  customized: boolean;
}

export interface AccountPermissionRow extends ServiceManagerPermissionRow {
  /** What the role gives; granted differs from it only when the account has its own setting. */
  roleGranted: boolean;
  overridden: boolean;
}

export interface AccountPermissions {
  user: ServiceManagerAccountRow;
  permissions: AccountPermissionRow[];
}

export interface ServiceManagerPermissionRow {
  code: string;
  group: string;
  label: string;
  granted: boolean;
}

@Injectable()
export class AdminRbacService {
  constructor(
    @InjectRepository(RoleEntity) private readonly roleRepo: Repository<RoleEntity>,
    @InjectRepository(Permission) private readonly permissionRepo: Repository<Permission>,
    @InjectRepository(RolePermission) private readonly rolePermissionRepo: Repository<RolePermission>,
    private readonly rbacService: RbacService,
    private readonly auditLogService: AuditLogService,
    @InjectRepository(UserScope) private readonly scopeRepo: Repository<UserScope>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {}

  /** One query: the service manager's current grants among the toggleable codes. */
  async listServiceManagerPermissions(): Promise<ServiceManagerPermissionRow[]> {
    const rows = await this.rolePermissionRepo
      .createQueryBuilder('rp')
      .innerJoin('rp.role', 'r')
      .innerJoin('rp.permission', 'p')
      .select('p.code', 'code')
      .where('r.code = :role', { role: SERVICE_MANAGER_ROLE })
      .andWhere('p.code IN (:...codes)', { codes: [...SERVICE_MANAGER_TOGGLEABLE_CODES] })
      .getRawMany<{ code: string }>();
    const granted = new Set(rows.map((row) => row.code));
    return SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS.map((p) => ({ ...p, granted: granted.has(p.code) }));
  }

  async setServiceManagerPermission(
    code: string,
    granted: boolean,
    actor: { id: string; role: string },
  ): Promise<ServiceManagerPermissionRow[]> {
    if (!SERVICE_MANAGER_TOGGLEABLE_CODES.has(code)) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Quyền này không cấu hình được cho quản lý dịch vụ.',
      );
    }
    const [role, permission] = await Promise.all([
      this.roleRepo.findOne({ where: { code: SERVICE_MANAGER_ROLE }, select: { id: true } }),
      this.permissionRepo.findOne({ where: { code }, select: { id: true } }),
    ]);
    if (!role || !permission) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Chưa có dữ liệu phân quyền cho quản lý dịch vụ.');
    }
    if (granted) {
      await this.rolePermissionRepo
        .createQueryBuilder()
        .insert()
        .values({ roleId: role.id, permissionId: permission.id })
        .orIgnore()
        .execute();
    } else {
      await this.rolePermissionRepo.delete({ roleId: role.id, permissionId: permission.id });
    }
    this.rbacService.invalidateCache();
    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: granted ? 'RBAC_PERMISSION_GRANTED' : 'RBAC_PERMISSION_REVOKED',
      resourceType: 'ROLE_PERMISSION',
      resourceId: permission.id,
      after: { role: SERVICE_MANAGER_ROLE, permission: code, granted },
    });
    return this.listServiceManagerPermissions();
  }

  /** BUG DETECTOR 261: every service manager account and whether it has its own setting (one query). */
  async listServiceManagerAccounts(): Promise<ServiceManagerAccountRow[]> {
    const rows = await this.userRepo
      .createQueryBuilder('u')
      .leftJoin(UserScope, 's', 's.user_id = u.id')
      .select('u.id', 'id')
      .addSelect('u.full_name', 'fullName')
      .addSelect('u.email', 'email')
      .addSelect('u.is_active', 'isActive')
      .addSelect("COALESCE(s.permission_overrides, '{}'::jsonb) <> '{}'::jsonb", 'customized')
      .where('u.role = :role', { role: SERVICE_MANAGER_ROLE })
      .orderBy('u.full_name', 'ASC')
      .getRawMany<ServiceManagerAccountRow>();
    return rows.map((r) => ({ ...r, isActive: Boolean(r.isActive), customized: Boolean(r.customized) }));
  }

  /** The permissions of one service manager account: role default plus its own setting (two queries). */
  async getAccountPermissions(userId: string): Promise<AccountPermissions> {
    const [roleRows, account] = await Promise.all([
      this.listServiceManagerPermissions(),
      this.findServiceManagerAccount(userId),
    ]);
    const permissions = roleRows.map((row) => {
      const own = account.overrides[row.code];
      const overridden = typeof own === 'boolean';
      return { ...row, roleGranted: row.granted, granted: overridden ? own : row.granted, overridden };
    });
    return { user: account.user, permissions };
  }

  async setAccountPermission(
    userId: string,
    code: string,
    granted: boolean,
    actor: { id: string; role: string },
  ): Promise<AccountPermissions> {
    this.assertToggleable(code);
    const account = await this.findServiceManagerAccount(userId);
    // One statement: create the scope row if missing (GLOBAL, as the seed does) and merge the code.
    await this.scopeRepo.query(
      `INSERT INTO "user_scopes" ("user_id", "permission_overrides") VALUES ($1, jsonb_build_object($2::text, $3::boolean))
       ON CONFLICT ("user_id") DO UPDATE
       SET "permission_overrides" = COALESCE("user_scopes"."permission_overrides", '{}'::jsonb) || EXCLUDED."permission_overrides"`,
      [userId, code, granted],
    );
    this.rbacService.invalidateCache();
    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: granted ? 'RBAC_ACCOUNT_PERMISSION_GRANTED' : 'RBAC_ACCOUNT_PERMISSION_REVOKED',
      resourceType: 'USER_PERMISSION',
      resourceId: userId,
      before: { permission: code, granted: account.overrides[code] ?? null },
      after: { permission: code, granted },
    });
    return this.getAccountPermissions(userId);
  }

  /** Back to the role default: drop the account's own setting. */
  async resetAccountPermissions(userId: string, actor: { id: string; role: string }): Promise<AccountPermissions> {
    const account = await this.findServiceManagerAccount(userId);
    await this.scopeRepo.update({ userId }, { permissionOverrides: null });
    this.rbacService.invalidateCache();
    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'RBAC_ACCOUNT_PERMISSION_RESET',
      resourceType: 'USER_PERMISSION',
      resourceId: userId,
      before: { overrides: account.overrides },
      after: { overrides: null },
    });
    return this.getAccountPermissions(userId);
  }

  private assertToggleable(code: string): void {
    if (!SERVICE_MANAGER_TOGGLEABLE_CODES.has(code)) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Quyền này không cấu hình được cho quản lý dịch vụ.',
      );
    }
  }

  private async findServiceManagerAccount(
    userId: string,
  ): Promise<{ user: ServiceManagerAccountRow; overrides: Record<string, boolean> }> {
    const row = await this.userRepo
      .createQueryBuilder('u')
      .leftJoin(UserScope, 's', 's.user_id = u.id')
      .select('u.id', 'id')
      .addSelect('u.full_name', 'fullName')
      .addSelect('u.email', 'email')
      .addSelect('u.is_active', 'isActive')
      .addSelect('u.role', 'role')
      .addSelect('s.permission_overrides', 'overrides')
      .where('u.id = :userId', { userId })
      .getRawOne<{ id: string; fullName: string; email: string; isActive: boolean; role: string; overrides: Record<string, boolean> | null }>();
    if (!row || row.role !== SERVICE_MANAGER_ROLE) {
      throw new BusinessException(ErrorCodes.NOT_FOUND, 'Không tìm thấy tài khoản quản lý dịch vụ.');
    }
    const overrides = row.overrides ?? {};
    return {
      user: {
        id: row.id,
        fullName: row.fullName,
        email: row.email,
        isActive: Boolean(row.isActive),
        customized: Object.keys(overrides).length > 0,
      },
      overrides,
    };
  }
}
