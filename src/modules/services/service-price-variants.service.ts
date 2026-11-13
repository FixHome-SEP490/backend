import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditLogService } from '../audit-log/audit-log.service';

/**
 * ADMIN 47 (PO 13/11/2026): the admin edits the Catalog V3 price tiers of a service.
 * A tier's code is what the pricing resolver matches, so codes are not created or renamed
 * here; the admin changes the labour price, the scope texts and whether the tier is offered.
 * Bookings keep the price they were made with (pricing snapshot), so an edit only affects
 * new bookings.
 */
export class UpdatePriceVariantDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 1_000_000_000, description: 'Fixed labour price in VND' })
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000_000)
  fixedLaborPriceVnd?: number;

  @ApiPropertyOptional({ description: 'What the price includes' })
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MinLength(5) @MaxLength(2000)
  includedScope?: string;

  @ApiPropertyOptional({ description: 'What the price excludes; empty clears it' })
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(2000)
  excludedScope?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isActive?: boolean;
}

export interface PriceVariantView {
  id: string;
  serviceId: string;
  variantCode: string;
  deviceAttributes: Record<string, unknown>;
  fixedLaborPriceVnd: number;
  includedScope: string;
  excludedScope: string | null;
  isActive: boolean;
  updatedAt: string;
}

const SELECT = `SELECT id, service_id, variant_code, device_attributes, fixed_labor_price_vnd, included_scope,
  excluded_scope, is_active, updated_at FROM service_price_variants`;

function view(row: Record<string, unknown>): PriceVariantView {
  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    variantCode: String(row.variant_code),
    deviceAttributes: (row.device_attributes as Record<string, unknown>) ?? {},
    fixedLaborPriceVnd: Number(row.fixed_labor_price_vnd),
    includedScope: String(row.included_scope),
    excludedScope: (row.excluded_scope as string | null) ?? null,
    isActive: row.is_active === true,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

@Injectable()
export class ServicePriceVariantsService {
  constructor(private readonly dataSource: DataSource, private readonly auditLog: AuditLogService) {}

  async list(serviceId: string): Promise<PriceVariantView[]> {
    const rows = await this.dataSource.query(`${SELECT} WHERE service_id = $1 ORDER BY variant_code`, [serviceId]);
    return rows.map(view);
  }

  async update(serviceId: string, variantId: string, dto: UpdatePriceVariantDto, actor: { id: string; role: string }) {
    return this.dataSource.transaction(async (m) => {
      const [before] = await m.query(`${SELECT} WHERE id = $1 AND service_id = $2 FOR UPDATE`, [variantId, serviceId]);
      if (!before) throw new NotFoundException('Không tìm thấy mức giá của dịch vụ này.');
      const [after] = await m.query(
        `UPDATE service_price_variants SET
           fixed_labor_price_vnd = COALESCE($3, fixed_labor_price_vnd),
           included_scope = COALESCE($4, included_scope),
           excluded_scope = CASE WHEN $5::text IS NULL THEN excluded_scope ELSE NULLIF($5::text, '') END,
           is_active = COALESCE($6, is_active),
           updated_at = now()
         WHERE id = $1 AND service_id = $2
         RETURNING id, service_id, variant_code, device_attributes, fixed_labor_price_vnd, included_scope, excluded_scope, is_active, updated_at`,
        [variantId, serviceId, dto.fixedLaborPriceVnd ?? null, dto.includedScope ?? null, dto.excludedScope ?? null, dto.isActive ?? null],
      );
      await this.auditLog.logWithManager(m, {
        actorUserId: actor.id, actorRole: actor.role, action: 'SERVICE_PRICE_VARIANT_UPDATE',
        resourceType: 'service_price_variant', resourceId: variantId,
        before: view(before) as unknown as Record<string, unknown>, after: view(after) as unknown as Record<string, unknown>,
      });
      return view(after);
    });
  }
}
