// src/modules/rbac/rbac.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { RolePermission } from './entities/role-permission.entity';
import { UserScope } from './entities/user-scope.entity';
import { SERVICE_MANAGER_ROLE, SERVICE_MANAGER_TOGGLEABLE_CODES } from './service-manager-permissions';

/**
 * BUG DETECTOR 261: the permissions one account really has. A service manager account
 * with its own setting follows that setting for the toggleable codes and the role for
 * everything else; any other role, or an account without a setting, follows the role.
 * An override can never grant a code outside the service manager toggleable list.
 */
export function effectivePermissions(
  roleCode: string,
  rolePerms: ReadonlySet<string> | undefined,
  overrides: Readonly<Record<string, boolean>> | null | undefined,
): Set<string> {
  const result = new Set(rolePerms ?? []);
  if (roleCode !== SERVICE_MANAGER_ROLE || !overrides) return result;
  for (const [code, granted] of Object.entries(overrides)) {
    if (!SERVICE_MANAGER_TOGGLEABLE_CODES.has(code)) continue;
    if (granted === true) result.add(code);
    else if (granted === false) result.delete(code);
  }
  return result;
}

/**
 * D-18: Loads role→permission mappings and per-account overrides from DB with a 60s
 * cache (two queries per refresh), so guards never hit the DB per request.
 */
@Injectable()
export class RbacService implements OnModuleInit {
  private readonly logger = new Logger(RbacService.name);
  /** Map<roleCode, Set<permissionCode>> */
  private permissionMap = new Map<string, Set<string>>();
  /** Map<userId, overrides> for accounts that have their own setting (BUG 261). */
  private overrideMap = new Map<string, Record<string, boolean>>();
  private cacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000; // 60s

  constructor(
    @InjectRepository(RolePermission)
    private readonly rpRepo: Repository<RolePermission>,
    @InjectRepository(UserScope)
    private readonly scopeRepo: Repository<UserScope>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refreshCache();
  }

  /** Get regional scope for a user (used by ScopeGuard). */
  async getUserScope(userId: string): Promise<UserScope | null> {
    return this.scopeRepo.findOne({ where: { userId } });
  }

  /**
   * Check if a role (and, when given, that account's own setting) has a permission.
   * Used by PermissionGuard.
   */
  async hasPermission(roleCode: string, permissionCode: string, userId?: string): Promise<boolean> {
    if (this.isCacheStale()) {
      await this.refreshCache();
    }
    const override = userId ? this.overrideMap.get(userId) : undefined;
    if (!override) return this.permissionMap.get(roleCode)?.has(permissionCode) ?? false;
    return effectivePermissions(roleCode, this.permissionMap.get(roleCode), override).has(permissionCode);
  }

  /** Get all permission codes for a role. */
  async getPermissionsForRole(roleCode: string): Promise<string[]> {
    if (this.isCacheStale()) {
      await this.refreshCache();
    }
    const perms = this.permissionMap.get(roleCode);
    return perms ? Array.from(perms) : [];
  }

  /** Permission codes one account really has. Used by GET /me and login responses. */
  async getPermissionsForUser(roleCode: string, userId?: string): Promise<string[]> {
    if (this.isCacheStale()) {
      await this.refreshCache();
    }
    const override = userId ? this.overrideMap.get(userId) : undefined;
    return Array.from(effectivePermissions(roleCode, this.permissionMap.get(roleCode), override));
  }

  /** Force-refresh the cache (e.g., after seed or admin change). */
  invalidateCache(): void {
    this.cacheLoadedAt = 0;
  }

  private isCacheStale(): boolean {
    return Date.now() - this.cacheLoadedAt > RbacService.CACHE_TTL_MS;
  }

  private async refreshCache(): Promise<void> {
    try {
      // Only the two codes the map needs (PO 14/10/2026: Supabase egress), not
      // every column of every role and permission on each refresh.
      const [rows, scopes] = await Promise.all([
        this.rpRepo.find({
          relations: ['role', 'permission'],
          select: { roleId: true, permissionId: true, role: { id: true, code: true }, permission: { id: true, code: true } },
        }),
        this.scopeRepo.find({
          where: { permissionOverrides: Not(IsNull()) },
          select: { userId: true, permissionOverrides: true },
        }),
      ]);

      const newMap = new Map<string, Set<string>>();
      for (const row of rows) {
        const roleCode = row.role.code;
        const permCode = row.permission.code;
        if (!newMap.has(roleCode)) {
          newMap.set(roleCode, new Set());
        }
        newMap.get(roleCode)!.add(permCode);
      }
      const newOverrides = new Map<string, Record<string, boolean>>();
      for (const scope of scopes) {
        if (scope.permissionOverrides && Object.keys(scope.permissionOverrides).length > 0) {
          newOverrides.set(scope.userId, scope.permissionOverrides);
        }
      }

      this.permissionMap = newMap;
      this.overrideMap = newOverrides;
      this.cacheLoadedAt = Date.now();

      this.logger.debug(
        `RBAC cache refreshed: ${newMap.size} roles, ${rows.length} role-permission mappings, ${newOverrides.size} account overrides`,
      );
    } catch (error) {
      this.logger.error('Failed to refresh RBAC cache', error);
    }
  }
}
