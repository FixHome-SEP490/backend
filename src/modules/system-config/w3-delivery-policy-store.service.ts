import { randomUUID } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager, LessThan } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Role } from '../../shared/enums';
import {
  assessW3DeliveryPolicyGates,
  W3DeliveryPolicyState,
} from './w3-delivery-policy';
import { W3DeliveryPolicyVersion } from './entities/w3-delivery-policy-version.entity';
import { W3_MAX_REVISION } from './w3-delivery-policy-admin.dto';

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

  async current(manager: EntityManager) {
    const row = await manager.findOne(W3DeliveryPolicyVersion, {
      where: { policyId: W3_OPERATING_POLICY_ID },
      order: { revision: 'DESC' },
    });
    return row ? this.view(row) : null;
  }

  async history(
    manager: EntityManager,
    beforeRevision: number | undefined,
    limit: number,
  ) {
    const rows = await manager.find(W3DeliveryPolicyVersion, {
      where: {
        policyId: W3_OPERATING_POLICY_ID,
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
  ) {
    if (!manager.queryRunner?.isTransactionActive || state.status !== 'DRAFT')
      throw new ServiceUnavailableException();
    const id = randomUUID();
    await manager.insert(W3DeliveryPolicyVersion, {
      id,
      policyId: W3_OPERATING_POLICY_ID,
      contentVersion: state.policy.version,
      revision: state.revision,
      status: 'DRAFT',
      snapshot: state,
      createdByUserId: actorId,
    });
    // Never use fail-open log/logWithManager. An audit failure aborts the caller transaction.
    await this.audit.logWithManagerStrict(manager, {
      actorUserId: actorId,
      actorRole: Role.ADMIN,
      action: before
        ? 'W3_DELIVERY_POLICY_DRAFT_REVISED'
        : 'W3_DELIVERY_POLICY_DRAFT_CREATED',
      resourceType: 'w3_delivery_policy',
      resourceId: id,
      before: before as unknown as Record<string, unknown> | null,
      after: state as unknown as Record<string, unknown>,
    });
    return this.find(manager, id);
  }

  private view(row: W3DeliveryPolicyVersion) {
    try {
      const state = structuredClone(row.snapshot);
      assessW3DeliveryPolicyGates(state); // validates exact shape and canonical fingerprint
      if (
        row.policyId !== W3_OPERATING_POLICY_ID ||
        row.status !== 'DRAFT' ||
        state.status !== 'DRAFT' ||
        state.policy.policyId !== row.policyId ||
        state.revision !== row.revision ||
        state.policy.version !== row.contentVersion ||
        row.revision !== row.contentVersion ||
        row.revision > W3_MAX_REVISION
      )
        throw new Error('Invalid draft history');
      Object.freeze(state.policy.parameters);
      Object.freeze(state.policy);
      Object.freeze(state);
      return Object.freeze({
        id: row.id,
        state,
        createdAt: new Date(row.createdAt).toISOString(),
      });
    } catch {
      throw new ServiceUnavailableException();
    }
  }
}
