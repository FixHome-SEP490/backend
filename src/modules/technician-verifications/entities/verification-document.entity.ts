// src/modules/technician-verifications/entities/verification-document.entity.ts
import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { DocumentType } from '../../../shared/enums';
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
}
