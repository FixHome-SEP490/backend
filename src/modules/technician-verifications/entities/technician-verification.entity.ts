// src/modules/technician-verifications/entities/technician-verification.entity.ts
import {
  Entity,
  Column,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';
import { VerificationStatus } from '../../../shared/enums';
import { VerificationDocument } from './verification-document.entity';

@Entity('technician_verifications')
@Index(['technicianId'])
@Index(['status'])
@Index('idx_one_open_verification', ['technicianId'], {
  unique: true,
  where: "\"status\" IN ('pending', 'verified')",
})
export class TechnicianVerification extends BaseEntity {
  @Column({ name: 'technician_id', type: 'uuid' })
  technicianId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'technician_id' })
  technician: User;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  status: VerificationStatus;

  @CreateDateColumn({ name: 'submitted_at', type: 'timestamp with time zone' })
  submittedAt: Date;

  @Column({
    name: 'reviewed_at',
    type: 'timestamp with time zone',
    nullable: true,
  })
  reviewedAt: Date | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewedBy: User | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  /**
   * The technician's name exactly as it stood when this KYC was approved.
   * users.full_name stays editable afterwards, so anything that must match the
   * verified identity — the withdrawal bank account — checks this instead.
   */
  @Column({ name: 'verified_full_name', type: 'varchar', length: 255, nullable: true })
  verifiedFullName: string | null;

  /** Rekognition similarity (0-100) between the CCCD photo and the selfie at submit; null = not compared. */
  @Column({
    name: 'face_match_score',
    type: 'numeric',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: { to: (v: number | null) => v, from: (v: string | null) => (v === null ? null : Number(v)) },
  })
  faceMatchScore: number | null;

  @Column({ name: 'face_match_at', type: 'timestamp with time zone', nullable: true })
  faceMatchAt: Date | null;

  @OneToMany(() => VerificationDocument, (doc) => doc.verification, {
    cascade: true,
  })
  documents: VerificationDocument[];
}
