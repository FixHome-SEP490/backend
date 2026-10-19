import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { PartCustodySnapshot } from '../part-custody.types';

/** Controlled cutover. Migration creates an INACTIVE singleton; no public activation API. */
@Entity('part_custody_activation')
export class PartCustodyActivation {
  @PrimaryColumn({ type: 'int' }) id: number;
  @Column({ type: 'boolean', default: false }) enabled: boolean;
  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true }) activatedAt: Date | null;
}

@Entity('part_custodies')
@Index('uq_part_custody_item', ['partRequestItemId'], { unique: true })
@Index('ix_part_custody_order', ['serviceOrderId'])
@Index('ix_part_custody_technician', ['technicianId'])
export class PartCustody extends BaseEntity {
  @Column({ name: 'service_order_id', type: 'uuid' }) serviceOrderId: string;
  @Column({ name: 'part_request_id', type: 'uuid' }) partRequestId: string;
  @Column({ name: 'part_request_item_id', type: 'uuid' }) partRequestItemId: string;
  @Column({ name: 'technician_id', type: 'uuid' }) technicianId: string;
  @Column({ name: 'part_name_snapshot', type: 'varchar', length: 255 }) partNameSnapshot: string;
  @Column({ name: 'cohort_activated_at', type: 'timestamptz' }) cohortActivatedAt: Date;
  @Column({ name: 'handed_over_at', type: 'timestamptz' }) handedOverAt: Date;
  @Column({ type: 'jsonb' }) state: PartCustodySnapshot;
}

/** Append-only commands; accept_return entries are signed physical receipts. */
@Entity('part_custody_entries')
@Index('uq_part_custody_entry_key', ['custodyId', 'idempotencyKey'], { unique: true })
@Index('uq_part_custody_entry_version', ['custodyId', 'version'], { unique: true })
export class PartCustodyEntry extends BaseEntity {
  @Column({ name: 'custody_id', type: 'uuid' }) custodyId: string;
  @Column({ type: 'varchar', length: 24 }) kind: 'record_usage' | 'declare_return' | 'accept_return';
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 }) idempotencyKey: string;
  @Column({ name: 'request_fingerprint', type: 'varchar', length: 64 }) requestFingerprint: string;
  @Column({ name: 'actor_user_id', type: 'uuid' }) actorUserId: string;
  @Column({ name: 'actor_role', type: 'varchar', length: 32 }) actorRole: string;
  @Column({ name: 'occurred_at', type: 'timestamptz' }) occurredAt: Date;
  @Column({ type: 'int' }) quantity: number;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'jsonb' }) response: Record<string, unknown>;
}
