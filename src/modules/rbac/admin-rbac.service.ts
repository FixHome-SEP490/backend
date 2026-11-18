import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Permission, RoleEntity, RolePermission } from './entities';
import { RbacService } from './rbac.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import {
  SERVICE_MANAGER_ROLE,
  SERVICE_MANAGER_TOGGLEABLE_CODES,
  SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS,
} from './service-manager-permissions';

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
}
