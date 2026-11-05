import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  GUARDS_METADATA,
  PATH_METADATA,
  METHOD_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../shared/enums';
import { DeliveryConsentPreviewController } from './delivery-consent-preview.controller';
import { DeliveryConsentPreviewService } from './delivery-consent-preview.service';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { JwtStrategy } from '../auth/strategies/jwt.strategy';

describe('DeliveryConsentPreviewController (unit, no HTTP/DB)', () => {
  it('resolves controller/service through Nest DI without a B1 provider', async () => {
    const module = await Test.createTestingModule({
      controllers: [DeliveryConsentPreviewController],
      providers: [
        DeliveryConsentPreviewService,
        { provide: DataSource, useValue: { manager: {} } },
      ],
    }).compile();
    expect(module.get(DeliveryConsentPreviewController)).toBeInstanceOf(
      DeliveryConsentPreviewController,
    );
    await module.close();
  });

  it('JWT validation uses current DB role rather than the token role (unit repository)', async () => {
    const user = {
      id: '00000000-0000-4000-8000-000000000001',
      role: Role.ADMIN,
      status: 'active',
      isActive: true,
    };
    const strategy = new JwtStrategy(
      { getOrThrow: () => 'unit-only-signing-key' } as any,
      { findOne: vi.fn().mockResolvedValue(user) } as any,
    );
    const authenticated = await strategy.validate({
      sub: user.id,
      role: Role.CUSTOMER,
    });
    expect(authenticated.role).toBe(Role.ADMIN);
    expect(authenticated.id).toBe(user.id);
  });

  it.each([
    null,
    { status: 'locked', isActive: true },
    { status: 'active', isActive: false },
  ])('JWT rejects missing/disabled accounts %j', async (user) => {
    const strategy = new JwtStrategy(
      { getOrThrow: () => 'unit-only-signing-key' } as any,
      { findOne: vi.fn().mockResolvedValue(user) } as any,
    );
    await expect(
      strategy.validate({
        sub: '00000000-0000-4000-8000-000000000001',
        role: Role.CUSTOMER,
      }),
    ).rejects.toThrow();
  });

  it('mounts only GET preview with JWT then roles and UUID validation', () => {
    const controller = DeliveryConsentPreviewController;
    expect(Reflect.getMetadata(PATH_METADATA, controller)).toBe(
      'part-requests',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(
      Reflect.getMetadata(PATH_METADATA, controller.prototype.preview),
    ).toBe(':id/delivery-consent/preview');
    expect(
      Reflect.getMetadata(METHOD_METADATA, controller.prototype.preview),
    ).toBe(RequestMethod.GET);
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      controller,
      'preview',
    );
    expect(
      Object.values(args).some(
        (arg: any) => arg.data === 'id' && arg.pipes.includes(ParseUUIDPipe),
      ),
    ).toBe(true);
  });

  it('forwards only authenticated id/role, ignoring client identity and approval', async () => {
    const preview = vi
      .fn()
      .mockResolvedValue({ mode: 'NON_EXECUTABLE_PREVIEW' });
    const controller = new DeliveryConsentPreviewController({ preview } as any);
    const req: any = {
      user: { id: 'trusted', role: Role.CUSTOMER, email: 'private' },
      query: { actorId: 'attacker', role: Role.ADMIN, approved: true },
      body: { actor: { id: 'attacker' }, sourceApproval: 'VERIFIED' },
    };
    expect(await controller.preview('request', req)).toEqual({
      data: { mode: 'NON_EXECUTABLE_PREVIEW' },
    });
    expect(preview).toHaveBeenCalledExactlyOnceWith('request', {
      id: 'trusted',
      role: Role.CUSTOMER,
    });
  });

  it.each([Role.ADMIN, Role.SERVICE_MANAGER, undefined])(
    'role guard denies %s before resource lookup',
    (role) => {
      const guard = new RolesGuard(new Reflector());
      const context: any = {
        getHandler: () => DeliveryConsentPreviewController.prototype.preview,
        getClass: () => DeliveryConsentPreviewController,
        switchToHttp: () => ({
          getRequest: () => ({ user: role ? { role } : undefined }),
        }),
      };
      expect(() => guard.canActivate(context)).toThrow(
        'You do not have permission',
      );
    },
  );

  it.each([Role.CUSTOMER, Role.TECHNICIAN])(
    'role guard admits %s to the owner check',
    (role) => {
      const context: any = {
        getHandler: () => DeliveryConsentPreviewController.prototype.preview,
        getClass: () => DeliveryConsentPreviewController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      };
      expect(new RolesGuard(new Reflector()).canActivate(context)).toBe(true);
    },
  );

  it('rejects malformed UUIDs', async () => {
    await expect(
      new ParseUUIDPipe().transform('../other', { type: 'param' }),
    ).rejects.toThrow();
  });
});
