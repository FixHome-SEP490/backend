import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('interruption_rebooks')
@Index('uq_interruption_rebooks_scope_key', ['customerId', 'scopeKind', 'scopeId', 'idempotencyKey'], { unique: true })
export class InterruptionRebook extends BaseEntity {
  @Column({ name: 'customer_id', type: 'uuid' }) customerId: string;
  @Column({ name: 'scope_kind', type: 'varchar', length: 16 }) scopeKind: 'booking' | 'visit_group';
  @Column({ name: 'scope_id', type: 'uuid' }) scopeId: string;
  @Column({ name: 'idempotency_key', type: 'varchar', length: 128 }) idempotencyKey: string;
  @Column({ name: 'request_fingerprint', type: 'char', length: 64 }) requestFingerprint: string;
  @Column({ name: 'source_count', type: 'smallint' }) sourceCount: number;
  @Column({ name: 'target_visit_group_id', type: 'uuid', nullable: true }) targetVisitGroupId: string | null;
}

@Entity('interruption_rebook_sources')
@Index('uq_interruption_rebook_source', ['sourceBookingId'], { unique: true })
@Index('uq_interruption_rebook_case', ['sourceCaseId'], { unique: true })
@Index('uq_interruption_rebook_target', ['targetBookingId'], { unique: true })
export class InterruptionRebookSource extends BaseEntity {
  @Column({ name: 'rebook_id', type: 'uuid' }) rebookId: string;
  @Column({ name: 'source_booking_id', type: 'uuid' }) sourceBookingId: string;
  @Column({ name: 'source_case_id', type: 'uuid' }) sourceCaseId: string;
  @Column({ name: 'target_booking_id', type: 'uuid' }) targetBookingId: string;
  @Column({ name: 'previous_technician_id', type: 'uuid' }) previousTechnicianId: string;
}
