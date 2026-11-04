import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Metadata only. Existence/bytes and courier authenticity require a trusted B2/B3 adapter. */
@Entity('delivery_evidence_records')
export class DeliveryEvidenceRecord {
  @PrimaryColumn({ type: 'uuid' }) id: string;
  @Column({ name: 'part_request_id', type: 'uuid' }) partRequestId: string;
  @Column({ name: 'service_order_id', type: 'uuid' }) serviceOrderId: string;
  @Column({ name: 'uploader_user_id', type: 'uuid' }) uploaderUserId: string;
  @Column({ type: 'varchar', length: 8 }) purpose: 'QUOTE' | 'ACTUAL';
  @Column({ name: 'quote_version', type: 'integer' }) quoteVersion: number;
  @Column({ name: 'private_object_ref', type: 'varchar', length: 512 })
  privateObjectRef: string;
  @Column({ name: 'content_digest', type: 'char', length: 64 })
  contentDigest: string;
  @Column({ name: 'mime_type', type: 'varchar', length: 32 }) mimeType: string;
  @Column({ name: 'file_size', type: 'integer' }) fileSize: number;
  // NULL means no automatic deletion policy is authorized, not permission to purge.
  @Column({ name: 'retain_until', type: 'timestamptz', nullable: true })
  retainUntil: Date | null;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
