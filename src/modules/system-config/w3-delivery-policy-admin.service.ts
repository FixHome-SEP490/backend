import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AccountStatus, Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import {
  createW3DeliveryPolicyDraft,
  createNextW3DeliveryPolicyDraft,
  activateW3DeliveryOperatingPolicy,
  retireW3DeliveryPolicyDraft,
  reviseW3DeliveryPolicyDraft,
} from './w3-delivery-policy';
import { previewW3DeliveryPolicyImpact } from './w3-delivery-policy-preview';
import {
  CreateW3DeliveryPolicyDraftDto,
  CreateW3DeliveryPolicyVersionDto,
  TransitionW3DeliveryPolicyDto,
  ActivateW3DeliveryPolicyDto,
  PreviewW3DeliveryPolicyVersionDto,
  invalidW3PolicyInput,
  parseW3PolicyDto,
  PreviewW3DeliveryPolicyDto,
  ReviseW3DeliveryPolicyDraftDto,
  W3DeliveryPolicyHistoryDto,
  W3_MAX_REVISION,
} from './w3-delivery-policy-admin.dto';
import {
  W3DeliveryPolicyStore,
  W3_OPERATING_POLICY_ID,
} from './w3-delivery-policy-store.service';

export type W3AdminPolicyBlocker =
  | 'LEGAL_UNVERIFIED'
  | 'ACCOUNTING_UNVERIFIED'
  | 'WAREHOUSE_UNVERIFIED'
  | 'COURIER_UNVERIFIED'
  | 'SHIPPING_APPROVAL_SOURCE_UNVERIFIED'
  | 'FINANCE_CUTOVER_CLOSED';
const blockers: readonly W3AdminPolicyBlocker[] = Object.freeze([
  'LEGAL_UNVERIFIED',
  'ACCOUNTING_UNVERIFIED',
  'WAREHOUSE_UNVERIFIED',
  'COURIER_UNVERIFIED',
  'SHIPPING_APPROVAL_SOURCE_UNVERIFIED',
  'FINANCE_CUTOVER_CLOSED',
]);
const inert = Object.freeze({
  mode: 'NON_EXECUTABLE_PREVIEW' as const,
  financialExecution: 'BLOCKED' as const,
  effectivePolicy: null,
  blockers,
});
const activation = Object.freeze({
  scope: 'OPERATING_CONFIG_ONLY' as const,
  previewRequired: true,
  financialExecution: 'BLOCKED' as const,
});
export interface W3AdminPrincipal {
  id: string;
  role: Role;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class W3DeliveryPolicyService {
  constructor(
    private readonly source: DataSource,
    private readonly store: W3DeliveryPolicyStore,
  ) {}

  async current(actor: W3AdminPrincipal) {
    return this.run(actor, 'config:read', async (manager) => {
      const head = await this.store.current(manager);
      return {
        ...inert,
        draft: head && this.legacyDraft(head.state) ? head : null,
      };
    });
  }

  async history(input: W3DeliveryPolicyHistoryDto, actor: W3AdminPrincipal) {
    const dto = parseW3PolicyDto(W3DeliveryPolicyHistoryDto, input);
    return this.run(actor, 'config:read', async (manager) => ({
      ...inert,
      drafts: await this.store.history(
        manager,
        dto.beforeRevision,
        dto.limit ?? 20,
        true,
      ),
    }));
  }

  async create(input: CreateW3DeliveryPolicyDraftDto, actor: W3AdminPrincipal) {
    const dto = parseW3PolicyDto(CreateW3DeliveryPolicyDraftDto, input);
    return this.run(actor, 'config:update', async (manager) => {
      await this.store.lock(manager);
      if (await this.store.current(manager, true)) throw this.conflict();
      const state = createW3DeliveryPolicyDraft(W3_OPERATING_POLICY_ID, {
        ...dto.parameters,
      });
      return {
        ...inert,
        draft: await this.store.append(manager, state, actor.id, null),
      };
    });
  }

  async revise(
    id: string,
    input: ReviseW3DeliveryPolicyDraftDto,
    actor: W3AdminPrincipal,
  ) {
    if (!uuid.test(id)) throw invalidW3PolicyInput();
    const dto = parseW3PolicyDto(ReviseW3DeliveryPolicyDraftDto, input);
    return this.run(actor, 'config:update', async (manager) => {
      await this.store.lock(manager);
      const current = await this.store.current(manager, true);
      if (
        !current ||
        current.id !== id ||
        current.state.revision !== dto.expectedRevision ||
        !this.legacyDraft(current.state)
      )
        throw this.conflict();
      if (dto.expectedRevision === W3_MAX_REVISION) throw this.conflict();
      const state = reviseW3DeliveryPolicyDraft(
        current.state,
        { ...dto.parameters },
        dto.expectedRevision,
      );
      return {
        ...inert,
        draft: await this.store.append(manager, state, actor.id, current.state),
      };
    });
  }

  /** Additive lifecycle API; the deployed Web's DRAFT projections remain unchanged. */
  async versionCurrent(actor: W3AdminPrincipal) {
    return this.run(actor, 'config:read', async (manager) => ({
      ...inert,
      activation,
      version: await this.store.current(manager),
    }));
  }

  async versionsHistory(
    input: W3DeliveryPolicyHistoryDto,
    actor: W3AdminPrincipal,
  ) {
    const dto = parseW3PolicyDto(W3DeliveryPolicyHistoryDto, input);
    return this.run(actor, 'config:read', async (manager) => ({
      ...inert,
      activation,
      versions: await this.store.history(
        manager,
        dto.beforeRevision,
        dto.limit ?? 20,
      ),
    }));
  }

  async createVersion(
    input: CreateW3DeliveryPolicyVersionDto,
    actor: W3AdminPrincipal,
  ) {
    const dto = parseW3PolicyDto(CreateW3DeliveryPolicyVersionDto, input);
    return this.run(actor, 'config:update', async (manager) => {
      await this.store.lock(manager);
      const head = await this.store.current(manager, true);
      if (
        (head?.state.revision ?? 0) !== dto.expectedRevision ||
        (head &&
          (head.state.status !== 'RETIRED' ||
            head.state.revision === W3_MAX_REVISION))
      )
        throw this.conflict();
      const state = head
        ? createNextW3DeliveryPolicyDraft(
            head.state,
            { ...dto.parameters },
            dto.expectedRevision,
          )
        : createW3DeliveryPolicyDraft(W3_OPERATING_POLICY_ID, {
            ...dto.parameters,
          });
      return {
        ...inert,
        activation,
        version: await this.store.append(
          manager,
          state,
          actor.id,
          head?.state ?? null,
        ),
      };
    });
  }

  async reviseVersion(
    id: string,
    input: ReviseW3DeliveryPolicyDraftDto,
    actor: W3AdminPrincipal,
  ) {
    if (!uuid.test(id)) throw invalidW3PolicyInput();
    const dto = parseW3PolicyDto(ReviseW3DeliveryPolicyDraftDto, input);
    return this.run(actor, 'config:update', async (manager) => {
      await this.store.lock(manager);
      const head = await this.head(manager, id, dto.expectedRevision);
      const state = reviseW3DeliveryPolicyDraft(
        head.state,
        { ...dto.parameters },
        dto.expectedRevision,
      );
      return {
        ...inert,
        activation,
        version: await this.store.append(manager, state, actor.id, head.state),
      };
    });
  }

  async retire(
    id: string,
    input: TransitionW3DeliveryPolicyDto,
    actor: W3AdminPrincipal,
  ) {
    if (!uuid.test(id)) throw invalidW3PolicyInput();
    const dto = parseW3PolicyDto(TransitionW3DeliveryPolicyDto, input);
    return this.run(actor, 'config:update', async (manager) => {
      await this.store.lock(manager);
      const head = await this.head(manager, id, dto.expectedRevision, true);
      const state = retireW3DeliveryPolicyDraft(
        head.state,
        dto.expectedRevision,
      );
      return {
        ...inert,
        activation,
        version: await this.store.append(manager, state, actor.id, head.state),
      };
    });
  }

  async previewVersion(
    id: string,
    input: PreviewW3DeliveryPolicyVersionDto,
    actor: W3AdminPrincipal,
  ) {
    if (!uuid.test(id)) throw invalidW3PolicyInput();
    const dto = parseW3PolicyDto(PreviewW3DeliveryPolicyVersionDto, input);
    return this.run(actor, 'config:update', async (manager) => {
      await this.store.lock(manager);
      const head = await this.head(manager, id, dto.expectedRevision);
      // Validate the samples before persistence; they remain hypothetical, never financial evidence.
      try {
        previewW3DeliveryPolicyImpact(
          head.state,
          dto.samples.map((sample) => ({ ...sample })),
        );
      } catch {
        throw invalidW3PolicyInput();
      }
      return {
        ...inert,
        activation,
        hypotheticalOnly: true as const,
        preview: await this.store.savePreview(
          manager,
          head.id,
          head.state,
          dto.samples.map((sample) => ({ ...sample })),
          actor.id,
        ),
      };
    });
  }

  async activate(
    id: string,
    input: ActivateW3DeliveryPolicyDto,
    actor: W3AdminPrincipal,
  ) {
    if (!uuid.test(id)) throw invalidW3PolicyInput();
    const dto = parseW3PolicyDto(ActivateW3DeliveryPolicyDto, input);
    return this.run(actor, 'config:update', async (manager) => {
      await this.store.lock(manager);
      const head = await this.head(manager, id, dto.expectedRevision);
      if (
        !(await this.store.approvedPreview(
          manager,
          dto.previewId,
          head.id,
          head.state,
          actor.id,
        ))
      )
        throw new ConflictException({
          code: 'W3_DELIVERY_POLICY_PREVIEW_REQUIRED',
          message:
            'Vui lòng xem trước đúng bản nháp bằng tài khoản của bạn trước khi kích hoạt cấu hình vận hành.',
        });
      const state = activateW3DeliveryOperatingPolicy(
        head.state,
        dto.expectedRevision,
      );
      return {
        ...inert,
        activation,
        version: await this.store.append(
          manager,
          state,
          actor.id,
          head.state,
          dto.previewId,
        ),
      };
    });
  }

  private legacyDraft(state: {
    status: string;
    revision: number;
    policy: { version: number };
  }) {
    return state.status === 'DRAFT' && state.revision === state.policy.version;
  }

  private async head(
    manager: EntityManager,
    id: string,
    expectedRevision: number,
    allowActive = false,
  ) {
    const head = await this.store.current(manager, true);
    if (
      !head ||
      head.id !== id ||
      head.state.revision !== expectedRevision ||
      !(
        head.state.status === 'DRAFT' ||
        (allowActive && head.state.status === 'ACTIVE')
      ) ||
      expectedRevision === W3_MAX_REVISION
    )
      throw this.conflict();
    return head;
  }

  async preview(input: PreviewW3DeliveryPolicyDto, actor: W3AdminPrincipal) {
    const dto = parseW3PolicyDto(PreviewW3DeliveryPolicyDto, input);
    return this.run(actor, 'config:read', async (manager) => {
      const draft = await this.store.find(manager, dto.draftId);
      if (!draft)
        throw new NotFoundException(
          'Không tìm thấy bản nháp chính sách giao hàng.',
        );
      if (draft.state.revision !== dto.expectedRevision) throw this.conflict();
      // Samples are supplied hypotheticals. No Invoice/Order/Consent/warehouse lookup.
      let result: ReturnType<typeof previewW3DeliveryPolicyImpact>;
      try {
        result = previewW3DeliveryPolicyImpact(
          draft.state,
          dto.samples.map((sample) => ({ ...sample })),
        );
      } catch {
        throw invalidW3PolicyInput();
      }
      return {
        ...result,
        ...inert,
        hypotheticalOnly: true as const,
        draftId: draft.id,
      };
    });
  }

  private async run<T>(
    actor: W3AdminPrincipal,
    permission: 'config:read' | 'config:update',
    execute: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (
      !actor ||
      actor.role !== Role.ADMIN ||
      typeof actor.id !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(actor.id)
    )
      throw new ForbiddenException();
    try {
      return await this.source.transaction(
        'READ COMMITTED',
        async (manager) => {
          // Recheck active role and uncached permission inside the transaction, including reads.
          const user = await manager.findOne(User, {
            where: { id: actor.id },
            select: { id: true, role: true, status: true, isActive: true },
            lock: { mode: 'pessimistic_read' },
          });
          if (
            !user ||
            user.id !== actor.id ||
            user.role !== Role.ADMIN ||
            user.status !== AccountStatus.ACTIVE ||
            user.isActive !== true
          )
            throw new ForbiddenException();
          const grants = await manager.query(
            `SELECT rp.role_id, rp.permission_id FROM role_permissions rp
          INNER JOIN roles r ON r.id = rp.role_id INNER JOIN permissions p ON p.id = rp.permission_id
          WHERE r.code = $1 AND p.code = $2 FOR SHARE OF rp, r, p`,
            [Role.ADMIN, permission],
          );
          if (grants.length !== 1) throw new ForbiddenException();
          return execute(manager);
        },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Missing schema, failed strict audit and database failures never produce a draft/default.
      throw new ServiceUnavailableException();
    }
  }

  private conflict() {
    return new ConflictException({
      code: 'W3_DELIVERY_POLICY_REVISION_CONFLICT',
      message: 'Bản nháp đã thay đổi. Vui lòng tải lại trước khi lưu.',
    });
  }
}
