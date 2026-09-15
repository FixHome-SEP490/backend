// src/modules/parts-catalog/parts-catalog.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PartsCatalogService } from './parts-catalog.service';
import { FixHomePart } from './entities/fixhome-part.entity';
import { Role } from '../../shared/enums';

describe('PartsCatalogService', () => {
  let service: PartsCatalogService;
  let partRepository: any;
  let auditLogService: any;
  let whereClauses: string[];
  let capturedQuery: Record<string, unknown>;

  const actor: any = { id: 'admin-1', role: Role.ADMIN };

  const createMockPart = (overrides: Partial<FixHomePart> = {}): FixHomePart =>
    ({
      id: 'part-uuid-1',
      sku: 'FH-BEARING-6204',
      name: 'Vòng bi 6204',
      description: 'Vòng bi máy giặt',
      sellingPrice: 185000,
      warrantyDays: 180,
      warrantyPolicy: 'Bảo hành 6 tháng',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as FixHomePart;

  const queryOf = (extra: Record<string, unknown> = {}): any => ({
    page: 1,
    limit: 10,
    skip: 0,
    ...extra,
  });

  beforeEach(() => {
    whereClauses = [];
    capturedQuery = {};
    partRepository = {
      findOne: vi.fn(),
      create: vi
        .fn()
        .mockImplementation((data) => ({ ...createMockPart(), ...data })),
      save: vi.fn().mockImplementation((data) => Promise.resolve({ ...data })),
    };
    const transactionManager = {
      getRepository: vi.fn().mockReturnValue(partRepository),
    };
    partRepository.manager = {
      transaction: vi
        .fn()
        .mockImplementation(async (callback: (manager: any) => unknown) =>
          callback(transactionManager),
        ),
    };
    // Chained query-builder mock capturing where clauses for active-filter proofs.
    const builder: any = {};
    builder.andWhere = vi.fn().mockImplementation((clause: string, params?: any) => {
      whereClauses.push(clause);
      Object.assign(capturedQuery, params ?? {});
      return builder;
    });
    builder.orderBy = vi.fn().mockReturnValue(builder);
    builder.skip = vi.fn().mockReturnValue(builder);
    builder.take = vi.fn().mockReturnValue(builder);
    builder.getManyAndCount = vi
      .fn()
      .mockResolvedValue([[createMockPart()], 1]);
    partRepository.createQueryBuilder = vi.fn().mockReturnValue(builder);

    auditLogService = {
      logWithManagerStrict: vi.fn().mockResolvedValue(undefined),
    };
    service = new PartsCatalogService(partRepository, auditLogService);
  });

  it('findCatalog forces active-only even when caller passes isActive=false', async () => {
    const result = await service.findCatalog(queryOf({ isActive: false }));
    expect(result.data).toHaveLength(1);
    expect(whereClauses.join(' ')).toContain('part.isActive = true');
    expect(whereClauses.join(' ')).not.toContain(':isActive');
  });

  it('findAdmin honors the isActive filter', async () => {
    await service.findAdmin(queryOf({ isActive: false }));
    expect(whereClauses.join(' ')).toContain(':isActive');
    expect(capturedQuery).toMatchObject({ isActive: false });
  });

  it('creates a valid part and audits PART_CREATE', async () => {
    partRepository.findOne.mockResolvedValue(null);
    const result = await service.create(
      { name: '  Vòng bi 6204 ', sellingPrice: 185000, sku: ' fh-bearing-6204 ' } as any,
      actor,
    );
    expect(result.sku).toBe('FH-BEARING-6204');
    expect(result.name).toBe('Vòng bi 6204');
    expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        action: 'PART_CREATE',
        resourceType: 'fixhome_part',
        resourceId: result.id,
      }),
    );
  });

  it('rejects duplicate normalized SKU with conflict', async () => {
    partRepository.findOne.mockResolvedValue(createMockPart());
    await expect(
      service.create(
        { name: 'Khác', sellingPrice: 1000, sku: ' fh-bearing-6204 ' } as any,
        actor,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('translates a DB unique-index race into ConflictException', async () => {
    partRepository.findOne.mockResolvedValue(null);
    partRepository.save.mockRejectedValueOnce({ code: '23505' });

    await expect(
      service.create(
        { name: 'Vòng bi 6204', sellingPrice: 185000, sku: 'FH-RACE' } as any,
        actor,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('fails closed when strict mutation audit fails', async () => {
    partRepository.findOne.mockResolvedValue(createMockPart());
    auditLogService.logWithManagerStrict.mockRejectedValueOnce(
      new Error('audit insert failed'),
    );

    await expect(
      service.update(
        'part-uuid-1',
        { sellingPrice: 195000 } as any,
        actor,
      ),
    ).rejects.toThrow('audit insert failed');
    expect(partRepository.manager.transaction).toHaveBeenCalledTimes(1);
  });

  it('updates selling price/warranty/name and audits PART_UPDATE', async () => {
    partRepository.findOne.mockResolvedValue(createMockPart());
    const result = await service.update(
      'part-uuid-1',
      {
        name: 'Vòng bi 6204 (2026)',
        sellingPrice: 195000,
        warrantyDays: 365,
      } as any,
      actor,
    );
    expect(result.name).toBe('Vòng bi 6204 (2026)');
    expect(Number(result.sellingPrice)).toBe(195000);
    expect(result.warrantyDays).toBe(365);
    expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        action: 'PART_UPDATE',
        resourceType: 'fixhome_part',
      }),
    );
  });

  it('toggles active status with PART_DEACTIVATE / PART_ACTIVATE audit', async () => {
    partRepository.findOne.mockResolvedValue(createMockPart());
    const deactivated = await service.toggleStatus('part-uuid-1', false, actor);
    expect(deactivated.isActive).toBe(false);
    expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'PART_DEACTIVATE' }),
    );

    partRepository.findOne.mockResolvedValue(
      createMockPart({ isActive: false }),
    );
    const activated = await service.toggleStatus('part-uuid-1', true, actor);
    expect(activated.isActive).toBe(true);
    expect(auditLogService.logWithManagerStrict).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'PART_ACTIVATE' }),
    );
  });

  it('findActiveById queries active-only and returns 404 when no active row exists', async () => {
    partRepository.findOne.mockResolvedValue(null);

    await expect(service.findActiveById('part-uuid-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(partRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'part-uuid-1', isActive: true },
    });
  });

  it('findById returns 404 when the part does not exist', async () => {
    partRepository.findOne.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('rejects invalid sellingPrice at service layer', async () => {
    partRepository.findOne.mockResolvedValue(null);
    await expect(
      service.create(
        { name: 'Vòng bi 6204', sellingPrice: -1 } as any,
        actor,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects negative warrantyDays at service layer', async () => {
    partRepository.findOne.mockResolvedValue(null);
    await expect(
      service.create(
        { name: 'Vòng bi 6204', sellingPrice: 185000, warrantyDays: -1 } as any,
        actor,
      ),
    ).rejects.toThrow(BadRequestException);

    partRepository.findOne.mockResolvedValue(createMockPart());
    await expect(
      service.update('part-uuid-1', { warrantyDays: -1 } as any, actor),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects fractional warrantyDays at service layer', async () => {
    partRepository.findOne.mockResolvedValue(null);
    await expect(
      service.create(
        {
          name: 'Vòng bi 6204',
          sellingPrice: 185000,
          warrantyDays: 1.5,
        } as any,
        actor,
      ),
    ).rejects.toThrow(BadRequestException);

    partRepository.findOne.mockResolvedValue(createMockPart());
    await expect(
      service.update('part-uuid-1', { warrantyDays: 1.5 } as any, actor),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects warrantyDays above 3650 at service layer', async () => {
    partRepository.findOne.mockResolvedValue(null);
    await expect(
      service.create(
        {
          name: 'Vòng bi 6204',
          sellingPrice: 185000,
          warrantyDays: 3651,
        } as any,
        actor,
      ),
    ).rejects.toThrow(BadRequestException);

    partRepository.findOne.mockResolvedValue(createMockPart());
    await expect(
      service.update('part-uuid-1', { warrantyDays: 3651 } as any, actor),
    ).rejects.toThrow(BadRequestException);
  });
});
