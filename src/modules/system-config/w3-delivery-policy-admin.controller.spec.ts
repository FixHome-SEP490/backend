import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import {
  GUARDS_METADATA,
  PATH_METADATA,
  METHOD_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AuditLogService } from '../audit-log/audit-log.service';
import { W3DeliveryPolicyService } from './w3-delivery-policy-admin.service';
import { W3DeliveryPolicyStore } from './w3-delivery-policy-store.service';
import {
  CreateW3DeliveryPolicyDraftDto,
  W3DeliveryPolicyInputGuard,
} from './w3-delivery-policy-admin.dto';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { W3DeliveryPolicyController } from './w3-delivery-policy-admin.controller';

const controller = W3DeliveryPolicyController;
const routes = [
  ['current', 'current', RequestMethod.GET, 'config:read'],
  ['history', 'history', RequestMethod.GET, 'config:read'],
  ['create', 'drafts', RequestMethod.POST, 'config:update'],
  ['revise', 'drafts/:id', RequestMethod.PATCH, 'config:update'],
  ['preview', 'preview', RequestMethod.POST, 'config:read'],
  ['activate', 'versions/:id/activate', RequestMethod.POST, 'config:update'],
  ['retire', 'versions/:id/retire', RequestMethod.POST, 'config:update'],
  ['versionCurrent', 'versions/current', RequestMethod.GET, 'config:read'],
  ['versionsHistory', 'versions/history', RequestMethod.GET, 'config:read'],
  ['createVersion', 'versions/drafts', RequestMethod.POST, 'config:update'],
  [
    'reviseVersion',
    'versions/drafts/:id',
    RequestMethod.PATCH,
    'config:update',
  ],
  [
    'previewVersion',
    'versions/:id/preview',
    RequestMethod.POST,
    'config:update',
  ],
] as const;

describe('W3 Admin controller security contract (metadata and real guards; no HTTP)', () => {
  it('resolves controller and services through Nest DI without new DB connections', async () => {
    const module = await Test.createTestingModule({
      controllers: [controller],
      providers: [
        W3DeliveryPolicyService,
        W3DeliveryPolicyStore,
        { provide: DataSource, useValue: {} },
        { provide: AuditLogService, useValue: {} },
      ],
    })
      .overrideGuard(PermissionGuard)
      .useValue({ canActivate: () => true })
      .compile();
    expect((module.get(controller) as any).service).toBe(
      module.get(W3DeliveryPolicyService),
    );
    expect((module.get(W3DeliveryPolicyService) as any).source).toEqual({});
    expect((module.get(W3DeliveryPolicyStore) as any).audit).toEqual({});
    await module.close();
  });

  it.each([
    '"__proto__":{"status":"ACTIVE"}',
    '"constructor":{"prototype":{"verified":true}}',
  ])(
    'rejects raw dangerous key %s BEFORE the global pipe strips it',
    async (extra) => {
      const raw = JSON.parse(
        `{"expectedRevision":0,"parameters":{"feeCeilingVnd":0,"proposalReviewAfterMinutes":0,"courierEvidenceReviewAfterMinutes":0},${extra}}`,
      );
      const context: any = {
        switchToHttp: () => ({ getRequest: () => ({ body: raw, query: {} }) }),
      };
      expect(() =>
        new W3DeliveryPolicyInputGuard().canActivate(context),
      ).toThrow();
      // Characterization of why raw preflight is required; the stock global pipe strips this key.
      const transformed = await new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }).transform(raw, {
        type: 'body',
        metatype: CreateW3DeliveryPolicyDraftDto,
      });
      expect(Object.keys(transformed).sort()).toEqual([
        'expectedRevision',
        'parameters',
      ]);
    },
  );
  it('uses a separate namespace and JWT/Roles/PermissionGuard in order', () => {
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe(
      'admin/w3-delivery-policy',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
      JwtAuthGuard,
      RolesGuard,
      PermissionGuard,
      W3DeliveryPolicyInputGuard,
    ]);
  });
  it.each(routes)(
    '%s requires explicit route/method/permission',
    (method, path, verb, permission) => {
      const fn = controller.prototype[method];
      expect(Reflect.getMetadata(PATH_METADATA, fn)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, fn)).toBe(verb);
      expect(
        new Reflector().getAllAndOverride('required_permission', [
          fn,
          controller,
        ]),
      ).toEqual([permission]);
    },
  );
  it.each([Role.CUSTOMER, Role.TECHNICIAN, Role.SERVICE_MANAGER, undefined])(
    'denies non-Admin %s on every route',
    (role) => {
      for (const [method] of routes) {
        const context: any = {
          getHandler: () => controller.prototype[method],
          getClass: () => controller,
          switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
        };
        expect(() =>
          new RolesGuard(new Reflector()).canActivate(context),
        ).toThrow();
      }
    },
  );
  it.each(routes)('rejects Admin without the %s permission', async (method) => {
    const context: any = {
      getHandler: () => controller.prototype[method],
      getClass: () => controller,
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: Role.ADMIN } }),
      }),
    };
    const guard = new PermissionGuard(new Reflector(), {
      hasPermission: async () => false,
    } as any);
    await expect(guard.canActivate(context)).rejects.toThrow();
  });
});
