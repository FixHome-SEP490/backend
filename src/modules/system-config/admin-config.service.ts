// src/modules/system-config/admin-config.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BusinessConfigService } from './business-config.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SystemConfig } from './entities/system-config.entity';

/**
 * Effect status of a config key at runtime.
 *
 * ACTIVE          — code currently reads this value from DB at runtime.
 * TO_WIRE         — value is in DB but at least one consumer still hard-codes it;
 *                   lists exact file:line evidence in consumerEvidence.
 * NOT_IMPLEMENTED — feature/provider not yet implemented; value has no runtime effect.
 * STALE_REVIEW    — old value/semantics conflict with v1.4 baseline;
 *                   corrected in this session or flagged for team review.
 */
export type ConfigEffectStatus =
  | 'ACTIVE'
  | 'TO_WIRE'
  | 'NOT_IMPLEMENTED'
  | 'STALE_REVIEW';

export interface ConfigKeyMeta {
  key: string;
  value: string;
  valueType: SystemConfig['valueType'];
  description: string | null;
  updatedByUserId: string | null;
  updatedAt: Date;
  effectStatus: ConfigEffectStatus;
  /** Exact consumer/file evidence for TO_WIRE keys. Null for other statuses. */
  consumerEvidence: string | null;
}

/**
 * Per-key validation rules. Applied on PATCH /admin/config/:key.
 * Enumerates the allowed range so Admin cannot submit arbitrary JSON.
 */
interface KeyValidationRule {
  type: 'int' | 'bigint' | 'string' | 'enum' | 'boolean';
  /** Allowed enum values (for type=enum). */
  enumValues?: string[];
  /** Inclusive min (for int/bigint). */
  min?: number;
  /** Inclusive max (for int/bigint). */
  max?: number;
  /** Max string length (for string). */
  maxLength?: number;
}

const KEY_VALIDATION: Record<string, KeyValidationRule> = {
  'matching.max_shortlist':              { type: 'int', min: 1, max: 10 },
  // matching.mode was SIMULTANEOUS (stale). v1.4 canonical is SEQUENTIAL.
  // Corrected in seed. No runtime consumer currently reads this key; sequential
  // invitation behavior is implemented independently in the Dev1-owned flow.
  'matching.mode':                       { type: 'enum', enumValues: ['SEQUENTIAL'] },
  'matching.invitation_ttl_minutes':     { type: 'int', min: 5, max: 1440 },
  'geofence.radius_meters':             { type: 'int', min: 10, max: 5000 },
  'geofence.min_gps_accuracy_meters':   { type: 'int', min: 5, max: 500 },
  'evidence.before.min_count':          { type: 'int', min: 0, max: 10 },
  'evidence.after.min_count':           { type: 'int', min: 0, max: 10 },
  'evidence.max_file_mb':               { type: 'int', min: 1, max: 50 },
  'strike.window.days':                 { type: 'int', min: 1, max: 365 },
  'strike.customer.threshold':          { type: 'int', min: 1, max: 20 },
  'strike.technician.threshold':        { type: 'int', min: 1, max: 20 },
  'customer.suspension.hours':          { type: 'int', min: 1, max: 8760 },
  'technician.suspension.hours':        { type: 'int', min: 1, max: 8760 },
  'cancel.grace_minutes_after_accept':  { type: 'int', min: 0, max: 120 },
  // compensation.arrival.amount is STALE — v1.4 removed monetary-arrival compensation.
  // Key is preserved because code may still reference it; value corrected to 0.
  'compensation.arrival.amount':        { type: 'bigint', min: 0, max: 0 },
  'commission.base':                    { type: 'enum', enumValues: ['LABOR'] },
  'commission.rate_bps':                { type: 'int', min: 0, max: 5000 },
  'additional_cost.approval_ttl_minutes': { type: 'int', min: 5, max: 1440 },
  'warranty.default_days':              { type: 'int', min: 0, max: 3650 },
  'warranty.max_days':                  { type: 'int', min: 0, max: 3650 },
  'ai.provider':                        { type: 'enum', enumValues: ['stub', 'gemini', 'openai', 'fixhome'] },
  'ai.timeout_ms':                      { type: 'int', min: 1000, max: 60000 },
  'ai.rate_limit_per_user_per_hour':    { type: 'int', min: 1, max: 1000 },
  'payment.mode':                       { type: 'enum', enumValues: ['DEMO', 'LIVE'] },
};

/**
 * Effect-status classification for each key.
 *
 * ACTIVE:          value is consumed at runtime from DB.
 * TO_WIRE:         at least one consumer still uses a hard-coded fallback;
 *                  consumerEvidence lists file:function.
 * NOT_IMPLEMENTED: feature code not yet present; value has no runtime effect.
 * STALE_REVIEW:    old semantics corrected in this pass.
 *
 * Dev1-owned flows (Booking/Matching/ServiceOrder) are marked TO_WIRE rather
 * than rewriting their logic in this branch.
 */
const KEY_EFFECT: Record<
  string,
  { status: ConfigEffectStatus; evidence: string | null }
> = {
  // ACTIVE: src/modules/bookings/invitations.service.ts reads via BusinessConfigService.getInt
  'matching.max_shortlist': {
    status: 'ACTIVE',
    evidence: null,
  },
  // STALE_REVIEW: seed corrected SIMULTANEOUS→SEQUENTIAL per v1.4 §10.
  // No runtime consumer reads this key; sequential logic is hard-coded in Dev1 flow.
  'matching.mode': {
    status: 'STALE_REVIEW',
    evidence:
      'Seed corrected SIMULTANEOUS→SEQUENTIAL per v1.4 §10. No runtime consumer reads this key from DB; Dev1 sequential invitation logic is hard-coded independently. Reclassify to ACTIVE once invitations.service.ts reads it.',
  },
  // ACTIVE: src/modules/bookings/invitations.service.ts reads this key in multiple places
  'matching.invitation_ttl_minutes': {
    status: 'ACTIVE',
    evidence: null,
  },
  // TO_WIRE: service-orders.service.ts reads value into local _geofenceRadius variable
  // but that variable is NOT subsequently used for distance validation logic.
  // The actual geofence check still uses a hard-coded or default threshold.
  'geofence.radius_meters': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/service-orders/service-orders.service.ts — value is loaded into _geofenceRadius but NOT used in the distance-validation branch; geofence check still uses a hard-coded threshold. Wire _geofenceRadius into the actual comparison to make this ACTIVE.',
  },
  // ACTIVE: read and applied in check-in result determination
  'geofence.min_gps_accuracy_meters': {
    status: 'ACTIVE',
    evidence: null,
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'evidence.before.min_count': {
    status: 'ACTIVE',
    evidence: null,
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'evidence.after.min_count': {
    status: 'ACTIVE',
    evidence: null,
  },
  // TO_WIRE: KYC DTO still hard-codes 10 MB limit; no BusinessConfigService read found
  'evidence.max_file_mb': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/technician-verifications/ DTO (and likely media upload DTOs) hard-code a 10 MB size limit rather than reading this key from BusinessConfigService. Wire into file-validation middleware/DTO to make ACTIVE.',
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'strike.window.days': {
    status: 'ACTIVE',
    evidence: null,
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'strike.customer.threshold': {
    status: 'ACTIVE',
    evidence: null,
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'strike.technician.threshold': {
    status: 'ACTIVE',
    evidence: null,
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'customer.suspension.hours': {
    status: 'ACTIVE',
    evidence: null,
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'technician.suspension.hours': {
    status: 'ACTIVE',
    evidence: null,
  },
  // ACTIVE: read and enforced via BusinessConfigService
  'cancel.grace_minutes_after_accept': {
    status: 'ACTIVE',
    evidence: null,
  },
  // STALE_REVIEW: v1.4 §4 removed monetary Customer-arrival-cancellation compensation.
  // Value corrected to 0; key preserved for any reader.
  'compensation.arrival.amount': {
    status: 'STALE_REVIEW',
    evidence:
      'v1.4 §4 removed monetary Customer arrival-cancellation compensation. Value corrected to 0. Key preserved to avoid breaking any reader. Do not build new compensation logic against this value.',
  },
  // TO_WIRE: service-orders.service.ts hard-codes `const commissionBase = \'LABOR\'`
  // rather than reading from BusinessConfigService.
  'commission.base': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/service-orders/service-orders.service.ts — commission base is hard-coded as \'LABOR\' (const commissionBase = \'LABOR\'); this key is NOT consumed from the DB. Wire BusinessConfigService.getString(\'commission.base\', \'LABOR\') to make ACTIVE.',
  },
  // TO_WIRE: service-orders.service.ts hard-codes the 10% rate (0.1 multiplier)
  // rather than reading commission.rate_bps from BusinessConfigService.
  'commission.rate_bps': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/service-orders/service-orders.service.ts — commission rate hard-coded as 0.1 (10%); this key is NOT consumed from DB. Wire BusinessConfigService.getInt(\'commission.rate_bps\', 1000) / 10000 at invoice-finalization.',
  },
  // STALE_REVIEW (key mismatch): seed uses key \'additional_cost.approval_ttl_minutes\'
  // but quotations.service.ts reads \'additional_cost.ttl_minutes\' (different key) with fallback 120.
  // The seed key is never consumed; the code key is not seeded. Both must be unified.
  'additional_cost.approval_ttl_minutes': {
    status: 'STALE_REVIEW',
    evidence:
      'KEY MISMATCH: seed registers key \'additional_cost.approval_ttl_minutes\' but src/modules/quotations/quotations.service.ts reads \'additional_cost.ttl_minutes\' (with fallback 120). The seeded key is never consumed by any code path. To fix: rename seed key to \'additional_cost.ttl_minutes\' OR update quotations.service.ts to read the seeded key; coordinate with Dev1 before changing.',
  },
  // TO_WIRE: no BusinessConfigService consumer found for warranty defaults
  'warranty.default_days': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/quotations/ — warranty default days not read from BusinessConfigService; existing code uses hard-coded or entity-default warranty values. Wire at WarrantyCoverage creation to make ACTIVE.',
  },
  // TO_WIRE: no BusinessConfigService consumer found for warranty max
  'warranty.max_days': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/quotations/ — warranty max days not read from BusinessConfigService; existing code does not validate against this key. Wire into warranty-term validation to make ACTIVE.',
  },
  // TO_WIRE: ai-diagnosis module exists but reads provider/timeout from .env/ConfigService,
  // not from BusinessConfigService. These DB config values have no runtime consumer yet.
  'ai.provider': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/ai-diagnosis/ — AI provider is configured via environment variable (AI_PROVIDER or similar), not read from BusinessConfigService. Wire BusinessConfigService.getString(\'ai.provider\', \'stub\') to make ACTIVE.',
  },
  'ai.timeout_ms': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/ai-diagnosis/ — AI timeout is configured via environment/static constant, not read from BusinessConfigService. Wire BusinessConfigService.getInt(\'ai.timeout_ms\', 15000) to make ACTIVE.',
  },
  'ai.rate_limit_per_user_per_hour': {
    status: 'TO_WIRE',
    evidence:
      'src/modules/ai-diagnosis/ — AI rate limit is not read from BusinessConfigService; no rate-limiting consumer found in current source. Wire into AI diagnosis rate-limiting logic to make ACTIVE.',
  },
  // NOT_IMPLEMENTED: PaymentTransaction provider-verification foundation not yet built (Wave 3)
  'payment.mode': {
    status: 'NOT_IMPLEMENTED',
    evidence:
      'PaymentTransaction provider-verification foundation not yet implemented (Wave 3). Value has no runtime effect.',
  },
};

@Injectable()
export class AdminConfigService {
  constructor(
    private readonly configService: BusinessConfigService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Return all config keys with effect metadata. */
  async findAll(search?: string): Promise<ConfigKeyMeta[]> {
    const configs = await this.configService.getAll();
    const filtered = search
      ? configs.filter((c) =>
          c.key.toLowerCase().includes(search.toLowerCase()),
        )
      : configs;

    return filtered.map((c) => this.toMeta(c));
  }

  /** Return a single config key with effect metadata. */
  async findOne(key: string): Promise<ConfigKeyMeta> {
    const all = await this.configService.getAll();
    const config = all.find((c) => c.key === key);
    if (!config) {
      throw new NotFoundException(`Config key "${key}" not found`);
    }
    return this.toMeta(config);
  }

  /**
   * Update a config key after typed/per-key validation.
   * Writes audit before/after.
   */
  async update(
    key: string,
    value: string,
    actorUserId: string,
    actorRole: string,
  ): Promise<ConfigKeyMeta> {
    // Ensure key exists
    const all = await this.configService.getAll();
    const current = all.find((c) => c.key === key);
    if (!current) {
      throw new NotFoundException(`Config key "${key}" not found`);
    }

    // Per-key typed validation
    this.validateValue(key, value, current.valueType);

    const before = { key, value: current.value };

    const saved = await this.configService.set(key, value, actorUserId);

    await this.auditLogService.log({
      actorUserId,
      actorRole,
      action: 'CONFIG_UPDATE',
      resourceType: 'system_config',
      resourceId: key,
      before,
      after: { key, value },
    });

    return this.toMeta(saved);
  }

  private toMeta(config: SystemConfig): ConfigKeyMeta {
    const effectInfo = KEY_EFFECT[config.key] ?? {
      status: 'NOT_IMPLEMENTED' as ConfigEffectStatus,
      evidence: 'Key not registered in effect registry.',
    };
    return {
      key: config.key,
      value: config.value,
      valueType: config.valueType,
      description: config.description,
      updatedByUserId: config.updatedByUserId,
      updatedAt: config.updatedAt,
      effectStatus: effectInfo.status,
      consumerEvidence: effectInfo.evidence,
    };
  }

  /**
   * Per-key typed validation.
   * Rejects values that violate the key's declared type/range.
   */
  private validateValue(
    key: string,
    value: string,
    declaredType: SystemConfig['valueType'],
  ): void {
    const rule = KEY_VALIDATION[key];

    if (!rule) {
      // Unknown key: validate only against declared type
      this.validateByType(key, value, declaredType, undefined);
      return;
    }

    this.validateByType(key, value, rule.type, rule);
  }

  private validateByType(
    key: string,
    value: string,
    type: string,
    rule: KeyValidationRule | undefined,
  ): void {
    switch (type) {
      case 'int': {
        const n = parseInt(value, 10);
        if (!Number.isInteger(n) || String(n) !== value.trim()) {
          throw new BadRequestException(
            `Config "${key}": value must be an integer, got "${value}"`,
          );
        }
        if (rule?.min !== undefined && n < rule.min) {
          throw new BadRequestException(
            `Config "${key}": value ${n} is below minimum ${rule.min}`,
          );
        }
        if (rule?.max !== undefined && n > rule.max) {
          throw new BadRequestException(
            `Config "${key}": value ${n} exceeds maximum ${rule.max}`,
          );
        }
        break;
      }
      case 'bigint': {
        try {
          const bn = BigInt(value);
          if (rule?.min !== undefined && bn < BigInt(rule.min)) {
            throw new BadRequestException(
              `Config "${key}": value ${bn} is below minimum ${rule.min}`,
            );
          }
          if (rule?.max !== undefined && bn > BigInt(rule.max)) {
            throw new BadRequestException(
              `Config "${key}": value ${bn} exceeds maximum ${rule.max}`,
            );
          }
        } catch {
          throw new BadRequestException(
            `Config "${key}": value must be a valid integer (bigint), got "${value}"`,
          );
        }
        break;
      }
      case 'boolean': {
        if (value !== 'true' && value !== 'false') {
          throw new BadRequestException(
            `Config "${key}": value must be "true" or "false", got "${value}"`,
          );
        }
        break;
      }
      case 'enum': {
        if (!rule?.enumValues?.includes(value)) {
          throw new BadRequestException(
            `Config "${key}": value must be one of [${rule?.enumValues?.join(', ') ?? ''}], got "${value}"`,
          );
        }
        break;
      }
      case 'string': {
        const maxLen = rule?.maxLength ?? 512;
        if (value.length > maxLen) {
          throw new BadRequestException(
            `Config "${key}": value exceeds max length ${maxLen}`,
          );
        }
        break;
      }
      default:
        // Unknown type — allow (don't silently break unknown keys)
        break;
    }
  }
}
