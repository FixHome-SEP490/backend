import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('repair_failure_rebooks')
@Index('uq_repair_failure_rebooks_scope_key', ['customerId', 'scopeKind', 'scopeId', 'idempotencyKey'], { unique: true })
export class RepairFailureRebook extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid' }) customerId: string;
  @Column({ name: 'scope_kind', type: 'varchar', length: 16 }) scopeKind: 'booking' | 'visit_group';
  @Column({ name: 'scope_id', type: 'uuid' }) scopeId: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 }) idempotencyKey: string;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 }) requestFingerprint: string;
  @Column({ name: 'source_count', type: 'smallint' }) sourceCount: number;
  @Column({ name: 'target_visit_group_id', type: 'uuid', nullable: true }) targetVisitGroupId: string | null;
}

@Entity('repair_failure_rebook_sources')
@Index('uq_repair_failure_rebook_source', ['sourceBookingId'], { unique: true })
@Index('uq_repair_failure_rebook_incident', ['sourceIncidentId'], { unique: true })
@Index('uq_repair_failure_rebook_target', ['targetBookingId'], { unique: true })
export class RepairFailureRebookSource extends BaseEntity {
  @Column({ name: 'rebook_id', type: 'uuid' }) rebookId: string;
  @Column({ name: 'source_booking_id', type: 'uuid' }) sourceBookingId: string;
  @Column({ name: 'source_incident_id', type: 'uuid' }) sourceIncidentId: string;
  @Column({ name: 'target_booking_id', type: 'uuid' }) targetBookingId: string;
}
