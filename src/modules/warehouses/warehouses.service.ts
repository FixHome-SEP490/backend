import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsWhere, Repository } from 'typeorm';
import { AccountStatus, Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { FixHomePart } from '../parts-catalog/entities/fixhome-part.entity';
import { AdjustStockDto, CreateWarehouseDto, ListWarehouseRowsDto, StockMovementResponseDto, UpdateWarehouseDto, WarehouseResponseDto } from './dto';
import { StockMovement, StockMovementKind, Warehouse, WarehouseStatus, WarehouseStock } from './entities';
import { calculateStockBalance } from './stock-balance.rules';

@Injectable()
export class WarehousesService {
  constructor(
    @InjectRepository(Warehouse) private readonly warehouses: Repository<Warehouse>,
    @InjectRepository(WarehouseStock) private readonly stock: Repository<WarehouseStock>,
    @InjectRepository(StockMovement) private readonly movements: Repository<StockMovement>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(FixHomePart) private readonly parts: Repository<FixHomePart>,
    private readonly dataSource: DataSource,
  ) {}

  async createWarehouse(dto: CreateWarehouseDto): Promise<WarehouseResponseDto> {
    await this.requireActiveManager(dto.responsibleUserId);
    const name = dto.name.trim();
    if (!name) throw new UnprocessableEntityException('Warehouse name is required');
    return this.toWarehouseResponse(await this.warehouses.save(this.warehouses.create({
      ...dto,
      name,
      address: dto.address?.trim() || null,
      status: WarehouseStatus.ACTIVE,
    })));
  }

  async listWarehouses(actor: User): Promise<WarehouseResponseDto[]> {
    if (actor.role !== Role.ADMIN && actor.role !== Role.SERVICE_MANAGER) {
      throw new ForbiddenException('Warehouse access denied');
    }
    const where: FindOptionsWhere<Warehouse> = actor.role === Role.ADMIN
      ? {}
      : { responsibleUserId: actor.id };
    return (await this.warehouses.find({ where, order: { createdAt: 'DESC', id: 'ASC' } })).map((row) => this.toWarehouseResponse(row));
  }

  async getWarehouse(id: string, actor: User): Promise<WarehouseResponseDto> {
    const warehouse = await this.findWarehouse(id);
    this.assertWarehouseAccess(warehouse, actor);
    return this.toWarehouseResponse(warehouse);
  }

  async updateWarehouse(id: string, dto: UpdateWarehouseDto): Promise<WarehouseResponseDto> {
    const warehouse = await this.findWarehouse(id);
    if (dto.responsibleUserId) await this.requireActiveManager(dto.responsibleUserId);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new UnprocessableEntityException('Warehouse name is required');
      warehouse.name = name;
    }
    if (dto.address !== undefined) warehouse.address = dto.address.trim() || null;
    if (dto.responsibleUserId !== undefined) warehouse.responsibleUserId = dto.responsibleUserId;
    if (dto.status !== undefined) warehouse.status = dto.status;
    return this.toWarehouseResponse(await this.warehouses.save(warehouse));
  }

  async deleteWarehouse(id: string): Promise<void> {
    await this.findWarehouse(id);
    if (
      await this.movements.exist({ where: { warehouseId: id } }) ||
      await this.stock.exist({ where: { warehouseId: id } })
    ) {
      throw new ConflictException('Warehouse with stock history cannot be deleted');
    }
    await this.warehouses.delete(id);
  }

  async listStock(id: string, actor: User, page: ListWarehouseRowsDto) {
    const warehouse = await this.getWarehouse(id, actor);
    const [rows, total] = await this.stock.findAndCount({
      where: { warehouseId: warehouse.id },
      relations: { part: true },
      order: { createdAt: 'DESC', id: 'ASC' },
      take: page.limit,
      skip: page.offset,
    });
    return {
      data: rows.map((row) => ({
        warehouseId: row.warehouseId,
        partId: row.partId,
        partName: row.part.name,
        sku: row.part.sku,
        onHand: row.onHand,
        reserved: row.reserved,
        available: row.onHand - row.reserved,
        version: row.version,
      })),
      meta: { total, limit: page.limit, offset: page.offset },
    };
  }

  async listMovements(id: string, actor: User, page: ListWarehouseRowsDto) {
    const warehouse = await this.getWarehouse(id, actor);
    const [data, total] = await this.movements.findAndCount({
      where: { warehouseId: warehouse.id },
      order: { createdAt: 'DESC', id: 'ASC' },
      take: page.limit,
      skip: page.offset,
    });
    return { data: data.map((row) => this.toMovementResponse(row)), meta: { total, limit: page.limit, offset: page.offset } };
  }

  async adjustStock(id: string, dto: AdjustStockDto, actor: User): Promise<StockMovementResponseDto> {
    const warehouse = await this.findWarehouse(id);
    this.assertWarehouseAccess(warehouse, actor);
    if (warehouse.status !== WarehouseStatus.ACTIVE) {
      throw new ConflictException('Inactive warehouse cannot change stock');
    }
    if (
      (dto.kind === StockMovementKind.STOCK_IN && dto.delta <= 0) ||
      (dto.kind === StockMovementKind.CORRECTION && dto.delta === 0)
    ) {
      throw new UnprocessableEntityException('Stock-in must be positive and correction must be non-zero');
    }
    if (!dto.reason.trim()) throw new UnprocessableEntityException('Stock adjustment reason is required');

    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ warehouseId: id, partId: dto.partId, actorId: actor.id, ...dto }))
      .digest('hex');

    return this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [dto.idempotencyKey]);
      const lockedWarehouse = await manager.getRepository(Warehouse).findOne({
        where: { id },
        lock: { mode: 'pessimistic_read' },
      });
      if (!lockedWarehouse) throw new NotFoundException('Warehouse not found');
      this.assertWarehouseAccess(lockedWarehouse, actor);
      if (lockedWarehouse.status !== WarehouseStatus.ACTIVE) {
        throw new ConflictException('Inactive warehouse cannot change stock');
      }
      const movementRepo = manager.getRepository(StockMovement);
      const replay = await movementRepo.findOne({ where: { idempotencyKey: dto.idempotencyKey } });
      if (replay) {
        if (replay.requestFingerprint !== fingerprint) {
          throw new ConflictException('Idempotency key was already used for a different stock command');
        }
        return this.toMovementResponse(replay);
      }

      const part = await manager.getRepository(FixHomePart).findOne({
        where: { id: dto.partId, isActive: true },
      });
      if (!part) throw new NotFoundException('Active FixHome part not found');

      await manager.query(
        `INSERT INTO warehouse_stock (warehouse_id, part_id, on_hand, reserved, version)
         VALUES ($1, $2, 0, 0, 0) ON CONFLICT (warehouse_id, part_id) DO NOTHING`,
        [id, dto.partId],
      );
      const stockRepo = manager.getRepository(WarehouseStock);
      const row = await stockRepo.findOne({
        where: { warehouseId: id, partId: dto.partId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw new NotFoundException('Warehouse stock row not found');

      let balance: ReturnType<typeof calculateStockBalance>;
      try {
        balance = calculateStockBalance({ onHand: row.onHand, reserved: row.reserved, delta: dto.delta });
      } catch (error) {
        throw new UnprocessableEntityException(error instanceof Error ? error.message : 'Invalid stock balance');
      }
      row.onHand = balance.onHand;
      row.version += 1;
      await stockRepo.save(row);

      const saved = await movementRepo.save(movementRepo.create({
        warehouseId: id,
        partId: dto.partId,
        actorUserId: actor.id,
        kind: dto.kind,
        delta: dto.delta,
        reason: dto.reason.trim(),
        idempotencyKey: dto.idempotencyKey,
        requestFingerprint: fingerprint,
        onHandAfter: balance.onHand,
        reservedAfter: balance.reserved,
      }));
      return this.toMovementResponse(saved);
    });
  }

  private async findWarehouse(id: string): Promise<Warehouse> {
    const warehouse = await this.warehouses.findOneBy({ id });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return warehouse;
  }

  private assertWarehouseAccess(warehouse: Warehouse, actor: User): void {
    if (
      actor.role !== Role.ADMIN &&
      (actor.role !== Role.SERVICE_MANAGER || warehouse.responsibleUserId !== actor.id)
    ) {
      throw new ForbiddenException('Warehouse access denied');
    }
  }

  private toWarehouseResponse(warehouse: Warehouse): WarehouseResponseDto {
    return {
      id: warehouse.id,
      name: warehouse.name,
      address: warehouse.address,
      status: warehouse.status,
      responsibleUserId: warehouse.responsibleUserId,
      createdAt: warehouse.createdAt,
      updatedAt: warehouse.updatedAt,
    };
  }

  private toMovementResponse(movement: StockMovement): StockMovementResponseDto {
    return {
      id: movement.id,
      warehouseId: movement.warehouseId,
      partId: movement.partId,
      actorUserId: movement.actorUserId,
      kind: movement.kind,
      delta: movement.delta,
      reason: movement.reason,
      idempotencyKey: movement.idempotencyKey,
      onHandAfter: movement.onHandAfter,
      reservedAfter: movement.reservedAfter,
      createdAt: movement.createdAt,
    };
  }

  private async requireActiveManager(id: string): Promise<void> {
    const user = await this.users.findOne({
      where: { id, role: Role.SERVICE_MANAGER, status: AccountStatus.ACTIVE, isActive: true },
      select: { id: true, role: true, status: true, isActive: true },
    });
    if (!user) throw new UnprocessableEntityException('Responsible user must be an active Service Manager');
  }
}
