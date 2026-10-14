import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { CustomerVerification } from './customer-verification.entity';

export type CustomerKycDocumentType = 'citizen_id_front' | 'citizen_id_back';

/**
 * One side of the citizen ID card, stored in the private KYC bucket under
 * kyc/<customerId>/. Only the path is kept; access is a short signed URL.
 */
@Entity('customer_verification_documents')
export class CustomerVerificationDocument extends BaseEntity {
  @Column({ name: 'verification_id', type: 'uuid' })
  verificationId: string;

  @ManyToOne(() => CustomerVerification, (v) => v.documents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'verification_id' })
  verification?: CustomerVerification;

  @Column({ name: 'document_type', type: 'varchar', length: 32 })
  documentType: CustomerKycDocumentType;

  @Column({ name: 'storage_object_path', type: 'varchar', length: 512 })
  storageObjectPath: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ name: 'file_size', type: 'int' })
  fileSize: number;

  @Column({ name: 'mime_type', type: 'varchar', length: 32 })
  mimeType: string;
}
