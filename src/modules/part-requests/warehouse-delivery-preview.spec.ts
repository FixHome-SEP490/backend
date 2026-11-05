import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  METHOD_METADATA,
  PATH_METADATA,
  GUARDS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { validate } from 'class-validator';
import { WarehouseDeliveryPreviewService } from './warehouse-delivery-preview.service';
import {
  WarehouseDeliveryPreviewController,
  WarehouseDeliveryPreviewParams,
} from './warehouse-delivery-preview.controller';
import { Role } from '../../shared/enums';

const owner = {
  requestId: randomUUID(),
  source: { partsLaborApproval: 'VERIFIED_APPROVED' },
  blockers: ['FINANCE_CUTOVER_CLOSED'],
  actions: { dispatch: 'BLOCKED' },
};
function fixture(fresh = true) {
  const auth = { preview: vi.fn(async () => owner) };
  const manager = {
    query: vi.fn(async () =>
      fresh ? [{ part_request_id: owner.requestId }] : [],
    ),
    findOne: vi.fn(async () => null),
  };
  return {
    auth,
    manager,
    service: new WarehouseDeliveryPreviewService(
      { manager } as any,
      auth as any,
    ),
  };
}
describe('W3 physical JWT preview only', () => {
  it('authorizes through existing owner facts before reading physical tables', async () => {
    const f = fixture();
    const actor = { id: randomUUID(), role: Role.TECHNICIAN };
    const result = await f.service.preview(owner.requestId, actor);
    expect(f.auth.preview).toHaveBeenCalledWith(owner.requestId, actor);
    expect(result).toMatchObject({
      mode: 'NON_EXECUTABLE_PREVIEW',
      eligibility: 'PENDING_ASSISTANCE',
      physicalExecution: 'BLOCKED',
      financialExecution: 'BLOCKED',
      evidence: 'NOT_RECORDED',
      actualCourierCost: null,
    });
    expect(result.blockers).toContain('SHIPPING_APPROVAL_SOURCE_UNVERIFIED');
    expect(result.blockers).toContain('DUAL_CONSENT_UNVERIFIED');
  });
  it('reports missing cohort as ineligible, never enrolls old DELIVERY', async () => {
    const f = fixture(false);
    expect(
      (
        await f.service.preview(owner.requestId, {
          id: randomUUID(),
          role: Role.CUSTOMER,
        })
      ).eligibility,
    ).toBe('INELIGIBLE');
    expect(f.manager.findOne).not.toHaveBeenCalled();
  });
  it('preserves owner denial before physical reads', async () => {
    const f = fixture();
    const denied = new Error('denied');
    f.auth.preview.mockRejectedValue(denied);
    await expect(f.service.preview(owner.requestId, {} as any)).rejects.toBe(
      denied,
    );
    expect(f.manager.query).not.toHaveBeenCalled();
  });
  it('fails unavailable schema closed with 503, no synthetic PASS', async () => {
    const f = fixture();
    f.manager.query.mockRejectedValue(new Error('missing schema'));
    await expect(
      f.service.preview(owner.requestId, {} as any),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('passes only req.user identity/role and registers GET only', async () => {
    const service = { preview: vi.fn(async () => ({})) };
    const controller = new WarehouseDeliveryPreviewController(service as any);
    const id = randomUUID();
    await controller.preview({ id }, {
      user: { id: 'trusted', role: Role.CUSTOMER, shippingApproved: true },
    } as any);
    expect(service.preview).toHaveBeenCalledWith(id, {
      id: 'trusted',
      role: Role.CUSTOMER,
    });
    expect(Reflect.getMetadata(METHOD_METADATA, controller.preview)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, controller.preview)).toBe(
      ':id/delivery-physical/preview',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, WarehouseDeliveryPreviewController),
    ).toHaveLength(2);
    expect(Reflect.getMetadata('roles', controller.preview)).toEqual([
      Role.CUSTOMER,
      Role.TECHNICIAN,
    ]);
    expect(
      Object.getOwnPropertyNames(WarehouseDeliveryPreviewController.prototype),
    ).toEqual(['constructor', 'preview']);
  });
  it('validates UUID params', async () => {
    expect(
      await validate(
        Object.assign(new WarehouseDeliveryPreviewParams(), {
          id: randomUUID(),
        }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        Object.assign(new WarehouseDeliveryPreviewParams(), { id: '../x' }),
      ),
    ).toHaveLength(1);
  });
  it('reports frozen scope as ineligible even with a cohort', async () => {
    const f = fixture();
    f.auth.preview.mockResolvedValue({ ...owner, blockers: ['ORDER_FROZEN'] });
    expect(
      (await f.service.preview(owner.requestId, {} as any)).eligibility,
    ).toBe('INELIGIBLE');
  });
  it('preserves a late owner revocation as denial', async () => {
    const f = fixture();
    const denied = new Error('late denied');
    f.auth.preview.mockResolvedValueOnce(owner).mockRejectedValueOnce(denied);
    await expect(f.service.preview(owner.requestId, {} as any)).rejects.toBe(
      denied,
    );
  });
});
