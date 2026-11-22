// src/modules/rbac/entities/user-scope.entity.ts
import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * OPEN-SM-01: Service Manager scope.
 * Default scopeType = GLOBAL. Column scopeProvinceCodes is ready
 * for regional scoping without requiring a new migration.
 */
@Entity('user_scopes')
export class UserScope {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({
    name: 'scope_type',
    type: 'varchar',
    length: 32,
    default: 'GLOBAL',
  })
  scopeType: string;

  @Column({
    name: 'scope_province_codes',
    type: 'text',
    array: true,
    nullable: true,
  })
  scopeProvinceCodes: string[] | null;

  /**
   * BUG DETECTOR 261: per-account service manager permissions that override the role.
   * { 'order:cancel': false } turns one toggleable permission off for this account only;
   * a code not listed follows the role. null means the account follows the role entirely.
   */
  @Column({ name: 'permission_overrides', type: 'jsonb', nullable: true })
  permissionOverrides: Record<string, boolean> | null;
}
