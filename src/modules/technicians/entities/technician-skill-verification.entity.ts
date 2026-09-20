// src/modules/technicians/entities/technician-skill-verification.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn, OneToMany, CreateDateColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { User } from '../../users/entities/user.entity';
import { VerificationStatus } from '../../../shared/enums';
import { TechnicianSkill } from './technician-skill.entity';
import { VerificationDocument } from '../../technician-verifications/entities/verification-document.entity';

@Entity('technician_skill_verifications')
@Index(['technicianSkillId'])
@Index(['status'])
@Index('idx_one_open_skill_verification', ['technicianSkillId'], {
  unique: true,
  where: "\"status\" IN ('pending', 'verified')",
})
export class TechnicianSkillVerification extends BaseEntity {
  @Column({ name: 'technician_skill_id', type: 'uuid' })
  technicianSkillId: string;

  @ManyToOne(() => TechnicianSkill, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'technician_skill_id' })
  technicianSkill: TechnicianSkill;

  @Column({
    type: 'enum',
    enum: VerificationStatus,
    default: VerificationStatus.PENDING,
  })
  status: VerificationStatus;

  @CreateDateColumn({ name: 'submitted_at', type: 'timestamp with time zone' })
  submittedAt: Date;

  @Column({ name: 'reviewed_at', type: 'timestamp with time zone', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewedBy: User | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason: string | null;

  @OneToMany(() => VerificationDocument, (doc) => doc.skillVerification, {
    cascade: true,
  })
  documents: VerificationDocument[];
}
