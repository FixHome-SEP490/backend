// src/modules/technician-verifications/entities/verification-document.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { DocumentType, SkillEvidenceGroup, SkillEvidenceReviewStatus, SkillEvidenceType } from '../../../shared/enums';
import { TechnicianVerification } from './technician-verification.entity';
import { User } from '../../users/entities/user.entity';
import { TechnicianSkillVerification } from '../../technicians/entities/technician-skill-verification.entity';

@Entity('verification_documents')
@Index(['verificationId'])
@Index(['skillVerificationId'])
export class VerificationDocument extends BaseEntity {
  // Exactly one of verificationId / skillVerificationId is set (identity KYC
  // vs. skill verification) — enforced by chk_verification_documents_one_owner.
  @Column({ name: 'verification_id', type: 'uuid', nullable: true })
  verificationId: string | null;

  @ManyToOne(() => TechnicianVerification, (v) => v.documents, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'verification_id' })
  verification: TechnicianVerification | null;

  @Column({ name: 'skill_verification_id', type: 'uuid', nullable: true })
  skillVerificationId: string | null;

  @ManyToOne(() => TechnicianSkillVerification, (v) => v.documents, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'skill_verification_id' })
  skillVerification: TechnicianSkillVerification | null;

  // Who supplied this file: NULL = the technician submitted it themselves
  // (e.g. an outside credential); set = a FixHome admin issued/attached it
  // (the certificate granted at approval).
  @Column({ name: 'issued_by', type: 'uuid', nullable: true })
  issuedById: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'issued_by' })
  issuedBy: User | null;

  @Column({
    name: 'document_type',
    type: 'enum',
    enum: DocumentType,
    default: DocumentType.OTHER,
  })
  documentType: DocumentType;

  @Column({
    name: 'storage_object_path',
    type: 'varchar',
    length: 512,
    nullable: true,
  })
  storageObjectPath: string | null;

  // Retained only for rows created before K2. It is never selected or used as
  // an access identifier by the application.
  @Column({ name: 'file_url', type: 'varchar', nullable: true, select: false })
  legacyFileUrl: string | null;

  @Column({ name: 'file_name', type: 'varchar' })
  fileName: string;

  @Column({ name: 'file_size', type: 'int' })
  fileSize: number;

  @Column({ name: 'mime_type', type: 'varchar' })
  mimeType: string;

  // Skill evidence metadata (PO 23/11/2026). NULL on identity KYC rows, on rows that predate it and on the
  // certificate FixHome issues at approval; the DB CHECKs only allow it on rows owned by a skill verification.
  @Column({ name: 'evidence_type', type: 'varchar', length: 40, nullable: true })
  evidenceType: SkillEvidenceType | null;

  @Column({ name: 'evidence_group', type: 'varchar', length: 20, nullable: true })
  evidenceGroup: SkillEvidenceGroup | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  issuer: string | null;

  @Column({ name: 'reference_number', type: 'varchar', length: 100, nullable: true })
  referenceNumber: string | null;

  /** Calendar dates (`YYYY-MM-DD`), not instants. */
  @Column({ name: 'issued_at', type: 'date', nullable: true })
  issuedAt: string | null;

  @Column({ name: 'expires_at', type: 'date', nullable: true })
  expiresAt: string | null;

  @Column({ name: 'claimed_years', type: 'int', nullable: true })
  claimedYears: number | null;

  @Column({ name: 'review_status', type: 'varchar', length: 20, nullable: true })
  reviewStatus: SkillEvidenceReviewStatus | null;

  @Column({ name: 'review_note', type: 'text', nullable: true })
  reviewNote: string | null;
}
