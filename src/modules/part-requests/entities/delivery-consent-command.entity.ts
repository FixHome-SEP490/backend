import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { Role } from '../../../shared/enums';
import type { DeliveryCommand } from '../delivery-consent.policy';
import type { DeliveryConsentProjection } from './delivery-consent-session.entity';

const vnd = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
const money = { type: 'bigint' as const, transformer: vnd };

@Entity('delivery_consent_commands')
export class DeliveryConsentCommandRecord {
  @PrimaryColumn({ name: 'part_request_id', type: 'uuid' })
  partRequestId: string;
  @PrimaryColumn({ name: 'command_id', type: 'uuid' }) commandId: string;
  @Column({ name: 'actor_user_id', type: 'uuid' }) actorUserId: string;
  @Column({ name: 'actor_role', type: 'varchar', length: 32 }) actorRole: Role;
  @Column({ type: 'varchar', length: 24 }) kind: DeliveryCommand['kind'];
  @Column({ name: 'expected_version', type: 'integer' })
  expectedVersion: number;
  @Column({ name: 'result_version', type: 'integer' }) resultVersion: number;
  @Column({ name: 'quote_version', type: 'integer' }) quoteVersion: number;
  @Column({ name: 'quote_command_id', type: 'uuid' }) quoteCommandId: string;
  @Column({ name: 'command_body', type: 'jsonb' }) commandBody: DeliveryCommand;
  @Column({ name: 'content_fingerprint', type: 'char', length: 64 })
  contentFingerprint: string;
  @Column({ name: 'source_snapshot', type: 'jsonb' }) sourceSnapshot: Record<
    string,
    unknown
  >;
  @Column({ name: 'source_digest', type: 'char', length: 64 })
  sourceDigest: string;
  @Column({ name: 'source_version', type: 'integer', nullable: true })
  sourceVersion: number | null;
  @Column({ name: 'evidence_id', type: 'uuid', nullable: true }) evidenceId:
    string | null;
  @Column({ type: 'jsonb' }) snapshot: DeliveryConsentProjection;
  @Column({ name: 'shipping_total', ...money }) shippingTotal: number;
  @Column({ name: 'customer_share', ...money }) customerShare: number;
  @Column({ name: 'technician_share', ...money }) technicianShare: number;
  @Column({ name: 'labor_total', ...money }) laborTotal: number;
  @Column({ name: 'commission_amount', ...money }) commissionAmount: number;
  @Column({ name: 'known_deductions', ...money }) knownDeductions: number;
  @Column({ name: 'net_labor', ...money }) netLabor: number;
  @Column({ name: 'actual_total', ...money, nullable: true }) actualTotal:
    number | null;
  @Column({ name: 'actual_customer_share', ...money, nullable: true })
  actualCustomerShare: number | null;
  @Column({ name: 'actual_technician_share', ...money, nullable: true })
  actualTechnicianShare: number | null;
  @Column({ name: 'consent_share', ...money, nullable: true }) consentShare:
    number | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
