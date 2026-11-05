import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('delivery_operation_evidence')
export class DeliveryOperationEvidence {
  @PrimaryColumn('uuid') id: string;
  @Column({ name: 'part_request_id', type: 'uuid' }) partRequestId: string;
  @Column({ name: 'service_order_id', type: 'uuid' }) serviceOrderId: string;
  @Column({ name: 'warehouse_id', type: 'uuid' }) warehouseId: string;
  @Column({ name: 'uploader_user_id', type: 'uuid' }) uploaderUserId: string;
  @Column({ type: 'varchar', length: 32 }) purpose: string;
  @Column({ name: 'quote_version', type: 'integer' }) quoteVersion: number;
  @Column({ name: 'private_object_ref', type: 'varchar', length: 512 })
  privateObjectRef: string;
  @Column({ name: 'content_digest', type: 'char', length: 64 })
  contentDigest: string;
  @Column({ name: 'mime_type', type: 'varchar', length: 32 }) mimeType: string;
  @Column({ name: 'file_size', type: 'integer' }) fileSize: number;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
