import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import type { W3DeliveryPolicyState } from '../w3-delivery-policy';

/** Every row is historical and append-only. There is no effective/ACTIVE policy. */
@Entity('w3_delivery_policy_versions')
@Index('uq_w3_delivery_policy_revision', ['policyId', 'revision'], {
  unique: true,
})
@Index('uq_w3_delivery_policy_content', ['policyId', 'contentVersion'], {
  unique: true,
})
export class W3DeliveryPolicyVersion {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'policy_id', type: 'varchar', length: 64 })
  policyId: string;

  @Column({ name: 'content_version', type: 'integer' })
  contentVersion: number;

  @Column({ type: 'integer' })
  revision: number;

  @Column({ type: 'varchar', length: 16 })
  status: 'DRAFT';

  @Column({ type: 'jsonb' })
  snapshot: W3DeliveryPolicyState;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
