import { describe, expect, it, vi } from 'vitest';
import { StockMovement, StockMovementKind, Warehouse, WarehouseStatus, WarehouseStock } from './entities';
import { WarehousesService } from './warehouses.service';
import { AccountStatus, Role } from '../../shared/enums';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

function buildService(responsibleUserId = 'sm-1', replayMovement: Record<string, unknown> | null = null) {
  const warehouse = { id: 'warehouse-1', responsibleUserId, status: WarehouseStatus.ACTIVE };
  const persistedMovement = { id: 'movement-1' };
  const movementRepo = {
    exist: vi.fn().mockResolvedValue(false),
    findOne: vi.fn().mockResolvedValue(replayMovement),
    create: vi.fn((value) => value),
    save: vi.fn(async (value) => Object.assign(persistedMovement, value)),
  };
  const stockRepo = {
    findOne: vi.fn().mockResolvedValue({ warehouseId: warehouse.id, partId: 'part-1', onHand: 0, reserved: 0, version: 0 }),
    save: vi.fn(async (value) => value),
  };
  const warehouseRepo = { findOne: vi.fn().mockResolvedValue(warehouse) };
  const partRepo = { findOne: vi.fn().mockResolvedValue({ id: 'part-1', isActive: true }) };
  const userRepo = { findOne: vi.fn() };
  const manager = {
    query: vi.fn().mockResolvedValue(undefined),
    getRepository: (entity: unknown) => {
      if (entity === StockMovement) return movementRepo;
      if (entity === WarehouseStock) return stockRepo;
      if (entity === Warehouse) return warehouseRepo;
      return partRepo;
    },
  };
  const service = new WarehousesService(
    { findOneBy: vi.fn().mockResolvedValue(warehouse) } as never,
    {} as never,
    movementRepo as never,
    userRepo as never,
    {} as never,
    { transaction: (work) => work(manager as never) } as never,
  );
  return { service, warehouse, movementRepo, stockRepo, manager, userRepo, warehouseRepo };
}

const command = {
  partId: 'part-1',
  delta: 6,
  kind: StockMovementKind.STOCK_IN,
  reason: 'Opening delivery received',
  idempotencyKey: '44bf09ea-cba1-4ded-86f9-aaf1d1cd7793',
};

describe('warehouse stock write authorization', () => {
  it('allows the responsible Service Manager to stock-in against a zero balance', async () => {
    const { service, movementRepo, stockRepo, manager } = buildService();
    const result = await service.adjustStock('warehouse-1', command, { id: 'sm-1', role: Role.SERVICE_MANAGER } as never);
    expect(result).toMatchObject({ delta: 6, onHandAfter: 6, reservedAfter: 0 });
    expect(stockRepo.save).toHaveBeenCalledOnce();
    expect(movementRepo.save).toHaveBeenCalledOnce();
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['44bf09ea-cba1-4ded-86f9-aaf1d1cd7793'],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (warehouse_id, part_id) DO NOTHING'),
      ['warehouse-1', 'part-1'],
    );
    expect(manager.getRepository(Warehouse).findOne).toHaveBeenCalledWith(expect.objectContaining({
      lock: { mode: 'pessimistic_read' },
    }));
    expect(stockRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: { mode: 'pessimistic_write' } }));
  });

  it('forbids an unrelated Service Manager from writing stock', async () => {
    const { service, movementRepo } = buildService();
    await expect(service.adjustStock('warehouse-1', command, { id: 'sm-2', role: Role.SERVICE_MANAGER } as never))
      .rejects.toThrow('Warehouse access denied');
    expect(movementRepo.save).not.toHaveBeenCalled();
  });

  it('allows Admin stock adjustment regardless of warehouse assignment', async () => {
    const { service, movementRepo } = buildService('sm-1');
    await service.adjustStock('warehouse-1', command, { id: 'admin-1', role: Role.ADMIN } as never);
    expect(movementRepo.save).toHaveBeenCalledOnce();
  });

  it('returns the original movement for an exact retry without writing stock again', async () => {
    const actor = { id: 'sm-1', role: Role.SERVICE_MANAGER };
    const fingerprint = await import('node:crypto').then(({ createHash }) => createHash('sha256')
      .update(JSON.stringify({ warehouseId: 'warehouse-1', partId: 'part-1', actorId: actor.id, ...command }))
      .digest('hex'));
    const original = { id: 'movement-original', requestFingerprint: fingerprint, delta: 6, onHandAfter: 6, reservedAfter: 0 };
    const { service, movementRepo, stockRepo } = buildService('sm-1', original);
    const result = await service.adjustStock('warehouse-1', command, actor as never);
    expect(result.id).toBe('movement-original');
    expect(movementRepo.save).not.toHaveBeenCalled();
    expect(stockRepo.save).not.toHaveBeenCalled();
  });

  it('requires warehouse assignment to an active Service Manager', async () => {
    const { service, userRepo } = buildService();
    userRepo.findOne.mockResolvedValue(null);
    await expect(service.createWarehouse({ name: 'District 1', responsibleUserId: 'inactive-user' }))
      .rejects.toThrow('Responsible user must be an active Service Manager');
    expect(userRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ role: Role.SERVICE_MANAGER, status: AccountStatus.ACTIVE, isActive: true }),
    }));
  });
});

describe('warehouse route roles', () => {
  it('keeps warehouse CRUD Admin-only while allowing Admin and Service Manager stock adjustment', async () => {
    const { WarehousesController } = await import('./warehouses.controller');
    expect(Reflect.getMetadata(ROLES_KEY, WarehousesController.prototype.create)).toEqual([Role.ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, WarehousesController.prototype.update)).toEqual([Role.ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, WarehousesController.prototype.remove)).toEqual([Role.ADMIN]);
    expect(Reflect.getMetadata(ROLES_KEY, WarehousesController.prototype.adjustStock)).toEqual([
      Role.ADMIN,
      Role.SERVICE_MANAGER,
    ]);
  });
});

describe('warehouse stock list', () => {
  it('reads the chosen SKU row whatever page it is on (W-11)', async () => {
    const findAndCount = vi.fn().mockResolvedValue([[{ warehouseId: 'warehouse-1', partId: 'part-9', part: { name: 'Adapter', sku: 'AD-24' }, onHand: 5, reserved: 1, version: 0 }], 1]);
    const service = new WarehousesService(
      { findOneBy: vi.fn().mockResolvedValue({ id: 'warehouse-1', responsibleUserId: 'sm-1', status: WarehouseStatus.ACTIVE }) } as never,
      { findAndCount } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const actor = { id: 'sm-1', role: Role.SERVICE_MANAGER, status: AccountStatus.ACTIVE, isActive: true } as never;
    const result = await service.listStock('warehouse-1', actor, { limit: 1, offset: 0, partId: 'part-9' } as never);
    expect(findAndCount.mock.calls[0][0].where).toEqual({ warehouseId: 'warehouse-1', partId: 'part-9' });
    expect(result.data[0]).toMatchObject({ partId: 'part-9', available: 4 });
    await service.listStock('warehouse-1', actor, { limit: 20, offset: 0 } as never);
    expect(findAndCount.mock.calls[1][0].where).toEqual({ warehouseId: 'warehouse-1' });
  });
});
