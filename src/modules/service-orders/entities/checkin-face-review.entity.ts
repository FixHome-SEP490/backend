import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

export type CheckinFaceReviewStatus = 'retake' | 'pending' | 'approved' | 'rejected';

/**
 * One outcome of the technician's check-in face: a retake request, an automatic pass, or a request
 * waiting for a service manager. Orders of one visit share `groupId` so one decision opens them all.
 */
@Entity('checkin_face_reviews')
@Index('idx_checkin_face_reviews_order_tech', ['serviceOrderId', 'technicianId', 'createdAt'])
export class CheckinFaceReview extends BaseEntity {
  @Column({ name: 'group_id', type: 'uuid' })
  groupId: string;

  @Column({ name: 'service_order_id', type: 'uuid' })
  serviceOrderId: string;

  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @Column({ name: 'evidence_id', type: 'uuid', nullable: true })
  evidenceId?: string | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true, transformer: { to: (v?: number | null) => v, from: (v?: string | null) => (v == null ? null : Number(v)) } })
  similarity?: number | null;

  @Column({ type: 'varchar', length: 16 })
  status: CheckinFaceReviewStatus;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy?: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt?: Date | null;

  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote?: string | null;

  @Column({ name: 'reminded_at', type: 'timestamptz', nullable: true })
  remindedAt?: Date | null;
}
