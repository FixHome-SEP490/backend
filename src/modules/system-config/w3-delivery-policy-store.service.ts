import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager, LessThan, Raw } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Role } from '../../shared/enums';
import {
  assessW3DeliveryPolicyGates,
  W3DeliveryPolicyState,
} from './w3-delivery-policy';
import { W3DeliveryPolicyVersion } from './entities/w3-delivery-policy-version.entity';
import { W3_MAX_REVISION } from './w3-delivery-policy-admin.dto';
import { W3DeliveryPolicyPreview } from './entities/w3-delivery-policy-preview.entity';
import {
  previewW3DeliveryPolicyImpact,
  W3DeliveryImpactSample,
} from './w3-delivery-policy-preview';

export const W3_OPERATING_POLICY_ID = 'w3-delivery-operating-policy';
// Fixed transaction-scoped lock, shared with the migration INSERT guard. No clock/TTL.
export const W3_POLICY_LOCK = [1793466000, 6] as const;

@Injectable()
export class W3DeliveryPolicyStore {
  constructor(private readonly audit: AuditLogService) {}

  async lock(manager: EntityManager): Promise<void> {
    if (!manager.queryRunner?.isTransactionActive)
      throw new ServiceUnavailableException();
    await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
      ...W3_POLICY_LOCK,
    ]);
  }

  async current(manager: EntityManager, forUpdate = false) {
    const row = await manager.findOne(W3DeliveryPolicyVersion, {
      where: { policyId: W3_OPERATING_POLICY_ID },
      order: { revision: 'DESC' },
      ...(forUpdate ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    return row ? this.view(row) : null;
  }

  async history(
    manager: EntityManager,
    beforeRevision: number | undefined,
    limit: number,
    legacyDraftsOnly = false,
  ) {
    const rows = await manager.find(W3DeliveryPolicyVersion, {
      where: {
        policyId: W3_OPERATING_POLICY_ID,
        ...(legacyDraftsOnly
          ? {
              status: 'DRAFT' as const,
              contentVersion: Raw((alias) => `${alias} = "revision"`),
            }
          : {}),
        ...(beforeRevision === undefined
          ? {}
          : { revision: LessThan(beforeRevision) }),
      },
      order: { revision: 'DESC' },
      take: limit,
    });
    return rows.map((row) => this.view(row));
  }

  async find(manager: EntityManager, id: string) {
    const row = await manager.findOne(W3DeliveryPolicyVersion, {
      where: { id, policyId: W3_OPERATING_POLICY_ID },
    });
    return row ? this.view(row) : null;
  }

  async append(
    manager: EntityManager,
    state: W3DeliveryPolicyState,
    actorId: string,
    before: W3DeliveryPolicyState | null,
    activationPreviewId: string | null = null,
  ) {
    if (!manager.queryRunner?.isTransactionActive)
      throw new ServiceUnavailableException();
    const id = randomUUID();
    await manager.insert(W3DeliveryPolicyVersion, {
      id,
      policyId: W3_OPERATING_POLICY_ID,
      contentVersion: state.policy.version,
      revision: state.revision,
      status: state.status,
      activationPreviewId,
      snapshot: state,
      createdByUserId: actorId,
    });
    // Never use fail-open log/logWithManager. An audit failure aborts the caller transaction.
    await this.audit.logWithManagerStrict(manager, {
      actorUserId: actorId,
      actorRole: Role.ADMIN,
      action:
        state.status === 'ACTIVE'
          ? 'W3_DELIVERY_POLICY_ACTIVATED'
          : state.status === 'RETIRED'
            ? 'W3_DELIVERY_POLICY_RETIRED'
            : !before || before.status === 'RETIRED'
              ? 'W3_DELIVERY_POLICY_DRAFT_CREATED'
              : 'W3_DELIVERY_POLICY_DRAFT_REVISED',
      resourceType: 'w3_delivery_policy',
      resourceId: id,
      before: before as unknown as Record<string, unknown> | null,
      after: {
        ...state,
        ...(activationPreviewId ? { activationPreviewId } : {}),
      },
    });
    return this.find(manager, id);
  }

  async savePreview(
    manager: EntityManager,
    draftId: string,
    state: W3DeliveryPolicyState,
    samples: readonly W3DeliveryImpactSample[],
    actorId: string,
  ) {
    if (!manager.queryRunner?.isTransactionActive)
      throw new ServiceUnavailableException();
    const id = randomUUID();
    const impact = previewW3DeliveryPolicyImpact(state, samples);
    await manager.insert(W3DeliveryPolicyPreview, {
      id,
      draftId,
      actorUserId: actorId,
      impact,
    });
    await this.audit.logWithManagerStrict(manager, {
      actorUserId: actorId,
      actorRole: Role.ADMIN,
      action: 'W3_DELIVERY_POLICY_PREVIEW_CREATED',
      resourceType: 'w3_delivery_policy_preview',
      resourceId: id,
      before: null,
      after: { draftId, impact },
    });
    return Object.freeze({ id, draftId, impact });
  }

  async approvedPreview(
    manager: EntityManager,
    previewId: string,
    draftId: string,
    state: W3DeliveryPolicyState,
    actorId: string,
  ) {
    const receipt = await manager.findOne(W3DeliveryPolicyPreview, {
      where: { id: previewId },
      lock: { mode: 'pessimistic_read' },
    });
    if (
      !receipt ||
      receipt.draftId !== draftId ||
      receipt.actorUserId !== actorId
    )
      return false;
    try {
      const samples = receipt.impact.proposals.map((p) => ({
        proposalId: p.proposalId,
        proposalVersion: p.proposalVersion,
        shippingFeeVnd: p.shippingFeeVnd,
        proposalAgeMinutes: p.proposalAgeMinutes,
        courierEvidenceAgeMinutes: p.courierEvidenceAgeMinutes,
      }));
      return isDeepStrictEqual(
        receipt.impact,
        previewW3DeliveryPolicyImpact(state, samples),
      );
    } catch {
      return false;
    }
  }

  private view(row: W3DeliveryPolicyVersion) {
    try {
      const state = structuredClone(row.snapshot);
      assessW3DeliveryPolicyGates(state); // validates exact shape and canonical fingerprint
      if (
        row.policyId !== W3_OPERATING_POLICY_ID ||
        !['DRAFT', 'ACTIVE', 'RETIRED'].includes(row.status) ||
        state.status !== row.status ||
        (row.status === 'ACTIVE') !== Boolean(row.activationPreviewId) ||
        state.policy.policyId !== row.policyId ||
        state.revision !== row.revision ||
        state.policy.version !== row.contentVersion ||
        row.revision < row.contentVersion ||
        row.revision > W3_MAX_REVISION
      )
        throw new Error('Invalid draft history');
      Object.freeze(state.policy.parameters);
      Object.freeze(state.policy);
      Object.freeze(state);
      return Object.freeze({
        id: row.id,
        state,
        ...(row.activationPreviewId
          ? { activationPreviewId: row.activationPreviewId }
          : {}),
        createdAt: new Date(row.createdAt).toISOString(),
      });
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
