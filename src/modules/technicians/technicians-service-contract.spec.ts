// src/modules/technicians/technicians-service-contract.spec.ts
import 'reflect-metadata';
import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { of } from 'rxjs';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { Role, ServicePricingMode } from '../../shared/enums';
import { TransformInterceptor } from '../../common/interceptors/transform.interceptor';
import { TechniciansController } from './technicians.controller';
import { TechniciansService } from './technicians.service';
import {
  TechnicianServiceOfferingResponseDto,
  UpdateSkillPricingDto,
} from './dto';

const assign = (values: Record<string, unknown>): UpdateSkillPricingDto =>
  Object.assign(new UpdateSkillPricingDto(), values);

const strictPipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
  transformOptions: { enableImplicitConversion: false },
});

const fixedPriceService = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Fixed service',
  pricingMode: ServicePricingMode.FIXED_PRICE,
  isActive: true,
  category: { id: 'cat-1', isActive: true },
};

const inspectionService = {
  ...fixedPriceService,
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Inspection service',
  pricingMode: ServicePricingMode.INSPECTION_REQUIRED,
};

const makeService = (serviceRecord: unknown, existingSkill: unknown = null) => {
  const profile = { id: 'profile-1' };
  const profileRepo = {
    findOne: vi.fn().mockResolvedValue(profile),
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (value: unknown) => value),
  };
  const persisted: Record<string, unknown> = {
    id: 'skill-1',
    technicianId: 'profile-1',
    serviceId: (serviceRecord as Record<string, unknown>).id,
    level: 'INTERMEDIATE',
    isActive: true,
    ...(existingSkill as Record<string, unknown>),
  };
  const skillRepo = {
    findOne: vi.fn().mockResolvedValue(existingSkill),
    find: vi.fn(),
    create: vi.fn((value: unknown) => ({ ...persisted, ...(value as object) })),
    save: vi.fn(async (value: unknown) => ({ ...persisted, ...(value as object) })),
  };
  const servicesService = {
    findById: vi.fn().mockResolvedValue(serviceRecord),
  };
  const service = new TechniciansService(
    profileRepo as any,
    skillRepo as any,
    servicesService as any,
  );
  return { service, profileRepo, skillRepo, servicesService };
};

describe('Technician service DTO validation boundaries', () => {
  it('accepts a fully valid update and nullable clears', async () => {
    expect(
      await validate(
        assign({ listedLaborPrice: 150000, typicalWarrantyDays: 30, level: 'SENIOR', isActive: true }),
      ),
    ).toEqual([]);
    expect(await validate(assign({ listedLaborPrice: null }))).toEqual([]);
    expect(await validate(assign({ typicalWarrantyDays: null }))).toEqual([]);
    expect(await validate(assign({}))).toEqual([]);
  });

  it('rejects negative, too-large, and too-many-decimals prices', async () => {
    for (const listedLaborPrice of [-1, 10000000000, 10.123, '100' as unknown as number, NaN, Infinity]) {
      const errors = await validate(assign({ listedLaborPrice }));
      expect(errors.map((error) => error.property)).toContain('listedLaborPrice');
    }
  });

  it('rejects non-integer or out-of-range warranty days', async () => {
    for (const typicalWarrantyDays of [-1, 3651, 1.5, '30' as unknown as number]) {
      const errors = await validate(assign({ typicalWarrantyDays }));
      expect(errors.map((error) => error.property)).toContain('typicalWarrantyDays');
    }
    expect(await validate(assign({ typicalWarrantyDays: 3650 }))).toEqual([]);
  });

  it('rejects empty, over-long, or non-string levels', async () => {
    for (const level of ['', 'x'.repeat(51), 123 as unknown as string, null as unknown as string]) {
      const errors = await validate(assign({ level }));
      expect(errors.map((error) => error.property)).toContain('level');
    }
  });

  it('rejects non-boolean isActive values', async () => {
    for (const isActive of ['true' as unknown as boolean, 1 as unknown as boolean, null as unknown as boolean]) {
      const errors = await validate(assign({ isActive }));
      expect(errors.map((error) => error.property)).toContain('isActive');
    }
  });

  it('trims levels and rejects undeclared fields through the global pipe contract', async () => {
    const transformed = (await strictPipe.transform(
      { listedLaborPrice: 150000, level: '  SENIOR  ', isActive: true },
      { type: 'body', metatype: UpdateSkillPricingDto },
    )) as UpdateSkillPricingDto;
    expect(transformed.level).toBe('SENIOR');

    await expect(
      strictPipe.transform(
        { listedLaborPrice: 100, hackerField: 'nope' },
        { type: 'body', metatype: UpdateSkillPricingDto },
      ),
    ).rejects.toThrow();
  });
});

describe('Technician service role/permission metadata', () => {
  it('restricts GET/PUT services to TECHNICIAN-only with fitting permissions', () => {
    expect(Reflect.getMetadata(ROLES_KEY, TechniciansController.prototype.getMyServices)).toEqual([
      Role.TECHNICIAN,
    ]);
    expect(
      Reflect.getMetadata(PERMISSION_KEY, TechniciansController.prototype.getMyServices),
    ).toEqual(['service:read']);
    expect(Reflect.getMetadata(ROLES_KEY, TechniciansController.prototype.setSkillPricing)).toEqual([
      Role.TECHNICIAN,
    ]);
    expect(
      Reflect.getMetadata(PERMISSION_KEY, TechniciansController.prototype.setSkillPricing),
    ).toEqual(['profile:update_own']);
  });

  it('leaves unrelated technician profile APIs untouched by this slice', () => {
    expect(Reflect.getMetadata(ROLES_KEY, TechniciansController.prototype.getMyProfile)).toBeUndefined();
    expect(Reflect.getMetadata(PERMISSION_KEY, TechniciansController.prototype.getMyProfile)).toBeUndefined();
  });

  it('documents typed success/error shapes and the UUID serviceId param', () => {
    const getResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      TechniciansController.prototype.getMyServices,
    );
    const putResponses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      TechniciansController.prototype.setSkillPricing,
    );
    expect(getResponses['200']).toMatchObject({
      type: TechnicianServiceOfferingResponseDto,
      isArray: true,
    });
    expect(putResponses['200']).toMatchObject({
      type: TechnicianServiceOfferingResponseDto,
      isArray: false,
    });
    for (const status of ['401', '403']) {
      expect(getResponses[status]).toBeDefined();
      expect(putResponses[status]).toBeDefined();
    }
    for (const status of ['400', '404']) {
      expect(putResponses[status]).toBeDefined();
    }

    const params = Reflect.getMetadata(
      DECORATORS.API_PARAMETERS,
      TechniciansController.prototype.setSkillPricing,
    ) as Array<Record<string, unknown>> | undefined;
    expect(params?.some((param) => param.name === 'serviceId')).toBe(true);
  });
});

describe('Technician service pricing-mode and existence rules', () => {
  it('rejects FIXED_PRICE listedLaborPrice overrides but allows clearing to null', async () => {
    const { service } = makeService(fixedPriceService);
    await expect(
      service.setSkillPricing('user-1', fixedPriceService.id, assign({ listedLaborPrice: 100 })),
    ).rejects.toBeInstanceOf(BadRequestException);

    const cleared = await service.setSkillPricing(
      'user-1',
      fixedPriceService.id,
      assign({ listedLaborPrice: null }),
    );
    expect(cleared.listedLaborPrice).toBeNull();
  });

  it('clears stale FIXED_PRICE listedLaborPrice on an update omitting the field', async () => {
    const { service, skillRepo } = makeService(fixedPriceService, {
      id: 'skill-1',
      technicianId: 'profile-1',
      serviceId: fixedPriceService.id,
      listedLaborPrice: '123000.00',
      level: 'INTERMEDIATE',
      isActive: true,
    });
    const result = await service.setSkillPricing(
      'user-1',
      fixedPriceService.id,
      assign({ level: 'SENIOR' }),
    );
    expect(result.listedLaborPrice).toBeNull();
    expect(skillRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ listedLaborPrice: null }),
    );
  });

  it('suppresses stale FIXED_PRICE listedLaborPrice on untouched projection', async () => {
    const { service } = makeService(fixedPriceService);
    const projected = (
      service as unknown as {
        toOfferingDto: (
          skill: unknown,
          svc: unknown,
        ) => TechnicianServiceOfferingResponseDto;
      }
    ).toOfferingDto(
      {
        id: 'skill-1',
        serviceId: fixedPriceService.id,
        listedLaborPrice: '123000.00',
        typicalWarrantyDays: 30,
        level: 'INTERMEDIATE',
        isActive: true,
        service: fixedPriceService,
      },
      undefined,
    );
    expect(projected.listedLaborPrice).toBeNull();
    expect(projected.service?.pricingMode).toBe(
      ServicePricingMode.FIXED_PRICE,
    );
  });

  it('persists a valid listedLaborPrice for INSPECTION_REQUIRED services', async () => {
    const { service } = makeService(inspectionService);
    const result = await service.setSkillPricing(
      'user-1',
      inspectionService.id,
      assign({ listedLaborPrice: 150000.5, typicalWarrantyDays: 90 }),
    );
    expect(result.listedLaborPrice).toBe(150000.5);
    expect(result.typicalWarrantyDays).toBe(90);
  });

  it('propagates missing services and blocks activating inactive services', async () => {
    const missing = makeService(fixedPriceService);
    missing.servicesService.findById.mockRejectedValueOnce(
      new NotFoundException('Service with ID missing not found'),
    );
    await expect(
      missing.service.setSkillPricing('user-1', 'missing', assign({})),
    ).rejects.toBeInstanceOf(NotFoundException);

    const inactiveService = { ...inspectionService, isActive: false };
    const { service: inactive } = makeService(inactiveService);
    await expect(
      inactive.setSkillPricing('user-1', inactiveService.id, assign({ isActive: true })),
    ).rejects.toBeInstanceOf(BadRequestException);
    const deactivated = await inactive.setSkillPricing(
      'user-1',
      inactiveService.id,
      assign({ isActive: false }),
    );
    expect(deactivated.isActive).toBe(false);

    const inactiveCategory = {
      ...inspectionService,
      category: { id: 'cat-1', isActive: false },
    };
    const { service: inactiveCat } = makeService(inactiveCategory);
    await expect(
      inactiveCat.setSkillPricing('user-1', inactiveCategory.id, assign({})),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('upserts only within the caller own profile scope', async () => {
    const { service, skillRepo } = makeService(inspectionService);
    await service.setSkillPricing('user-1', inspectionService.id, assign({ level: 'SENIOR' }));
    expect(skillRepo.findOne).toHaveBeenCalledWith({
      where: { technicianId: 'profile-1', serviceId: inspectionService.id },
    });
    expect(skillRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ technicianId: 'profile-1', serviceId: inspectionService.id }),
    );
  });

  it('projects numeric DB strings as numbers and hides internal relations', async () => {
    const { service } = makeService(inspectionService);
    const result = await service.setSkillPricing('user-1', inspectionService.id, assign({}));
    // Simulate a DB-returned numeric string flowing through the projection.
    const projected = (service as unknown as {
      toOfferingDto: (skill: unknown, svc: unknown) => TechnicianServiceOfferingResponseDto;
    }).toOfferingDto(
      {
        id: 'skill-1',
        serviceId: inspectionService.id,
        listedLaborPrice: '150000.00',
        typicalWarrantyDays: '30',
        level: 'INTERMEDIATE',
        isActive: true,
        service: {
          ...inspectionService,
          technician: { id: 'should-be-hidden' },
        },
      },
      undefined,
    );
    expect(projected.listedLaborPrice).toBe(150000);
    expect(projected.typicalWarrantyDays).toBe(30);
    expect(projected).not.toHaveProperty('technician');
    expect(projected.service).toEqual({
      id: inspectionService.id,
      name: inspectionService.name,
      pricingMode: ServicePricingMode.INSPECTION_REQUIRED,
      isActive: true,
    });
    expect(result.service?.id).toBe(inspectionService.id);
  });
});

describe('Technician service controller envelope', () => {
  it('returns raw projected data so the global interceptor wraps exactly once', async () => {
    const offerings = [
      {
        id: 'skill-1',
        serviceId: inspectionService.id,
        listedLaborPrice: 150000,
        typicalWarrantyDays: 30,
        level: 'INTERMEDIATE',
        isActive: true,
        service: {
          id: inspectionService.id,
          name: inspectionService.name,
          pricingMode: ServicePricingMode.INSPECTION_REQUIRED,
          isActive: true,
        },
      },
    ];
    const controller = new TechniciansController({
      getMySkills: vi.fn().mockResolvedValue(offerings),
      setSkillPricing: vi.fn().mockResolvedValue(offerings[0]),
    } as unknown as TechniciansService);

    const list = await controller.getMyServices({ user: { id: 'user-1' } });
    expect(Array.isArray(list)).toBe(true);
    expect(list).not.toHaveProperty('data');

    const single = await controller.setSkillPricing(
      { user: { id: 'user-1' } },
      inspectionService.id,
      assign({ listedLaborPrice: 150000 }),
    );
    expect(single).not.toHaveProperty('data');
    expect(single).toMatchObject({ id: 'skill-1' });

    const interceptor = new TransformInterceptor();
    const context = {
      switchToHttp: () => ({ getResponse: () => ({ statusCode: 200 }) }),
    } as any;
    const wrapped = await new Promise((resolve) =>
      interceptor.intercept(context, { handle: () => of(single) }).subscribe(resolve),
    );
    expect(wrapped).toMatchObject({ success: true, data: single });
  });
});
