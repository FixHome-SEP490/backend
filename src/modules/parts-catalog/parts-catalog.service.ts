// src/modules/parts-catalog/parts-catalog.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FixHomePart } from './entities/fixhome-part.entity';
import {
  CreateFixHomePartDto,
  QueryFixHomeCatalogDto,
  QueryFixHomePartsDto,
  UpdateFixHomePartDto,
} from './dto';
import { PaginationMeta } from '../../shared/dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { User } from '../users/entities/user.entity';

const RESOURCE_TYPE = 'fixhome_part';
const POSTGRES_UNIQUE_VIOLATION = '23505';

@Injectable()
export class PartsCatalogService {
  constructor(
    @InjectRepository(FixHomePart)
    private readonly partRepository: Repository<FixHomePart>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** Normal catalog path: active parts only, ignores incoming isActive filter. */
  async findCatalog(
    query: QueryFixHomeCatalogDto,
  ): Promise<{ data: FixHomePart[]; meta: PaginationMeta }> {
    return this.findParts(query, true);
  }

  /** Admin path: all parts, optional isActive filter. */
  async findAdmin(
    query: QueryFixHomePartsDto,
  ): Promise<{ data: FixHomePart[]; meta: PaginationMeta }> {
    return this.findParts(query, false);
  }

  private async findParts(
    query: QueryFixHomeCatalogDto & { isActive?: boolean },
    onlyActive: boolean,
  ): Promise<{ data: FixHomePart[]; meta: PaginationMeta }> {
    const qb = this.partRepository.createQueryBuilder('part');

    if (onlyActive) {
      qb.andWhere('part.isActive = true');
    } else if (query.isActive !== undefined) {
      qb.andWhere('part.isActive = :isActive', {
        isActive: query.isActive,
      });
    }

    if (query.search) {
      const search = `%${query.search.trim()}%`;
      qb.andWhere(
        '(part.name ILIKE :search OR part.sku ILIKE :search OR part.description ILIKE :search)',
        { search },
      );
    }

    qb.orderBy('part.name', 'ASC');
    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();

    const meta: PaginationMeta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };

    return { data, meta };
  }

  async findById(id: string): Promise<FixHomePart> {
    return this.findByIdWithRepository(this.partRepository, id);
  }

  async findActiveById(id: string): Promise<FixHomePart> {
    const part = await this.partRepository.findOne({
      where: { id, isActive: true },
    });
    if (!part) {
      throw new NotFoundException('Active FixHome part not found');
    }
    return part;
  }

  async create(dto: CreateFixHomePartDto, actor: User): Promise<FixHomePart> {
    this.validateSellingPrice(dto.sellingPrice);
    this.validateWarrantyDays(dto.warrantyDays);
    const sku = this.normalizeSku(dto.sku);

    return this.partRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(FixHomePart);
      await this.assertSkuUnique(sku, undefined, repository);

      const part = repository.create({
        sku,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        sellingPrice: dto.sellingPrice,
        warrantyDays: dto.warrantyDays ?? null,
        warrantyPolicy: dto.warrantyPolicy?.trim() || null,
        isActive: dto.isActive !== undefined ? dto.isActive : true,
      });

      const saved = await this.saveWithSkuConflict(repository, part);
      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_CREATE',
        resourceType: RESOURCE_TYPE,
        resourceId: saved.id,
        after: saved as unknown as Record<string, unknown>,
      });

      return saved;
    });
  }

  async update(
    id: string,
    dto: UpdateFixHomePartDto,
    actor: User,
  ): Promise<FixHomePart> {
    return this.partRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(FixHomePart);
      const part = await this.findByIdWithRepository(repository, id);
      const before = { ...part };

      if (dto.sku !== undefined) {
        const sku = this.normalizeSku(dto.sku);
        if (sku !== part.sku) {
          await this.assertSkuUnique(sku, id, repository);
        }
        part.sku = sku;
      }
      if (dto.name !== undefined) part.name = dto.name.trim();
      if (dto.description !== undefined) {
        part.description = dto.description?.trim() || null;
      }
      if (dto.sellingPrice !== undefined) {
        this.validateSellingPrice(dto.sellingPrice);
        part.sellingPrice = dto.sellingPrice;
      }
      if (dto.warrantyDays !== undefined) {
        this.validateWarrantyDays(dto.warrantyDays);
        part.warrantyDays = dto.warrantyDays;
      }
      if (dto.warrantyPolicy !== undefined) {
        part.warrantyPolicy = dto.warrantyPolicy?.trim() || null;
      }
      if (dto.isActive !== undefined) part.isActive = dto.isActive;

      const saved = await this.saveWithSkuConflict(repository, part);
      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'PART_UPDATE',
        resourceType: RESOURCE_TYPE,
        resourceId: saved.id,
        before: before as unknown as Record<string, unknown>,
        after: saved as unknown as Record<string, unknown>,
      });

      return saved;
    });
  }

  async toggleStatus(
    id: string,
    isActive: boolean,
    actor: User,
  ): Promise<FixHomePart> {
    return this.partRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(FixHomePart);
      const part = await this.findByIdWithRepository(repository, id);
      const before = { ...part };

      part.isActive = isActive;
      const saved = await this.saveWithSkuConflict(repository, part);
      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: isActive ? 'PART_ACTIVATE' : 'PART_DEACTIVATE',
        resourceType: RESOURCE_TYPE,
        resourceId: saved.id,
        before: before as unknown as Record<string, unknown>,
        after: saved as unknown as Record<string, unknown>,
      });

      return saved;
    });
  }

  /** Empty/blank SKU becomes null; otherwise trimmed + uppercased. */
  normalizeSku(sku?: string | null): string | null {
    if (sku === undefined || sku === null) return null;
    const normalized = sku.trim().toUpperCase();
    return normalized.length === 0 ? null : normalized;
  }

  private async findByIdWithRepository(
    repository: Repository<FixHomePart>,
    id: string,
  ): Promise<FixHomePart> {
    const part = await repository.findOne({ where: { id } });
    if (!part) {
      throw new NotFoundException(`FixHome part with ID ${id} not found`);
    }
    return part;
  }

  private async assertSkuUnique(
    sku: string | null,
    excludeId?: string,
    repository: Repository<FixHomePart> = this.partRepository,
  ): Promise<void> {
    if (!sku) return;
    const existing = await repository.findOne({ where: { sku } });
    if (existing && existing.id !== excludeId) {
      throw new ConflictException(`FixHome part SKU ${sku} is already in use`);
    }
  }

  private async saveWithSkuConflict(
    repository: Repository<FixHomePart>,
    part: FixHomePart,
  ): Promise<FixHomePart> {
    try {
      return await repository.save(part);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException(
          part.sku
            ? `FixHome part SKU ${part.sku} is already in use`
            : 'FixHome part SKU is already in use',
        );
      }
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {
      code?: unknown;
      driverError?: { code?: unknown };
    };
    return (
      candidate.code === POSTGRES_UNIQUE_VIOLATION ||
      candidate.driverError?.code === POSTGRES_UNIQUE_VIOLATION
    );
  }

  private validateWarrantyDays(value: number | null | undefined): void {
    if (value === undefined || value === null) return;
    if (!Number.isInteger(value) || value < 0 || value > 3650) {
      throw new BadRequestException(
        'warrantyDays must be an integer between 0 and 3650',
      );
    }
  }

  private validateSellingPrice(value: number | undefined): void {
    if (
      value === undefined ||
      value === null ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 9999999999.99
    ) {
      throw new BadRequestException(
        'sellingPrice must be between 0 and 9999999999.99',
      );
    }
  }
}
