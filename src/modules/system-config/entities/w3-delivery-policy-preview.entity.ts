import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { previewW3DeliveryPolicyImpact } from '../w3-delivery-policy-preview';

/** Server-computed what-if receipt, bound to one snapshot and authenticated Admin. */
@Entity('w3_delivery_policy_previews')
export class W3DeliveryPolicyPreview {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'draft_id', type: 'uuid' })
  draftId: string;

  @Column({ name: 'actor_user_id', type: 'uuid' })
  actorUserId: string;

  @Column({ type: 'jsonb' })
  impact: ReturnType<typeof previewW3DeliveryPolicyImpact>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
