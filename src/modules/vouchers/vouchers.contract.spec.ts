import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Role } from '../../shared/enums';
import { VouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';
import {
  ApplyVoucherDto,
  ClaimVoucherDto,
  CreateVoucherCampaignDto,
  VoucherCampaignStatusDto,
} from './dto/voucher.dto';
import { VoucherDiscount, VoucherKind } from './voucher.types';
import { DECORATORS } from '@nestjs/swagger/dist/constants';

describe('voucher transport contracts', () => {
  it('preserves Vietnamese Swagger text as Unicode', () => {
    expect(
      Reflect.getMetadata(
        DECORATORS.API_OPERATION,
        VouchersController.prototype.createCampaign,
      ).summary,
    ).toBe('Tạo chương trình ưu đãi với chính sách bất biến');
  });
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const validate = (value: unknown, metatype: any) =>
    pipe.transform(value, { type: 'body', metatype });
  const validCampaign = () => ({
    code: 'TEST100',
    name: 'Ưu đãi',
    kind: VoucherKind.GENERAL,
    discount: VoucherDiscount.FIXED,
    value: 20000,
    capVnd: null,
    minimumVnd: 50000,
    categoryIds: [randomUUID()],
    serviceIds: [],
    startsAt: '2026-10-26T03:00:00Z',
    endsAt: '2026-10-27T03:00:00Z',
    quota: 100,
  });

  it('accepts legacy demo customer UUID-v0 for Admin grants but rejects malformed IDs', async () => {
    const { GrantPersonalVoucherDto } = await import('./dto/voucher.dto');
    const grantId = randomUUID();
    expect(await validate({ customerId: '00000000-0000-0000-0000-000000000002', grantId }, GrantPersonalVoucherDto)).toBeInstanceOf(GrantPersonalVoucherDto);
    await expect(validate({ customerId: 'not-an-uuid', grantId }, GrantPersonalVoucherDto)).rejects.toThrow();
  });
  it('accepts typed fixed and percent campaign configuration', async () => {
    expect(
      await validate(validCampaign(), CreateVoucherCampaignDto),
    ).toBeInstanceOf(CreateVoucherCampaignDto);
    expect((await validate({ ...validCampaign(), kind: VoucherKind.PERSONAL, autoCompensation: true }, CreateVoucherCampaignDto)).autoCompensation).toBe(true);
    expect(
      await validate(
        { ...validCampaign(), discount: VoucherDiscount.PERCENT, value: 10 },
        CreateVoucherCampaignDto,
      ),
    ).toBeInstanceOf(CreateVoucherCampaignDto);
  });
  it.each([
    { quota: 0 },
    { value: -1 },
    { minimumVnd: -1 },
    { capVnd: 0 },
    { startsAt: 'bad' },
    { categoryIds: ['forged'] },
    { kind: 'OTHER' },
    { code: '../bad' },
    { value: '10' },
    { autoCompensation: 'true' },
  ])('rejects invalid campaign input %j', async (invalid) => {
    await expect(
      validate({ ...validCampaign(), ...invalid }, CreateVoucherCampaignDto),
    ).rejects.toThrow();
  });
  it('rejects client prices, ownership and settlement verdicts', async () => {
    const apply = {
      claimId: randomUUID(),
      scopeId: randomUUID(),
      attemptId: randomUUID(),
    };
    expect(await validate(apply, ApplyVoucherDto)).toBeInstanceOf(
      ApplyVoucherDto,
    );
    for (const extra of [
      { amount: 1 },
      { customerId: randomUUID() },
      { paid: true },
      { expiresAt: '2099-01-01' },
    ]) {
      await expect(
        validate({ ...apply, ...extra }, ApplyVoucherDto),
      ).rejects.toThrow();
    }
    await expect(
      validate({ code: 'TEST100', ownerId: randomUUID() }, ClaimVoucherDto),
    ).rejects.toThrow();
    await expect(
      validate({ active: null }, VoucherCampaignStatusDto),
    ).rejects.toThrow();
  });

  it('runs real RolesGuard, route UUID validation and claim rate limit in an isolated HTTP app', async () => {
    // Test-only authentication supplies synthetic principals; JWT verification and DB are NOT tested.
    let role: Role | undefined = Role.CUSTOMER;
    let actorId = randomUUID();
    const preview = vi.fn(async () => ({ previewOnly: true, paymentAvailable: false }));
    const builder = Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 5 }])],
      controllers: [VouchersController],
      providers: [
        Reflector,
        {
          provide: VouchersService,
          useValue: {
            wallet: async (actor: { id: string }) => [{ customerId: actor.id }],
            browseGeneral: async () => [{ code: 'GENERAL' }],
            grantPersonal: async () => ({ id: randomUUID() }),
            claim: async () => ({ id: randomUUID() }),
            apply: async () => ({ id: randomUUID(), state: 'RESERVED' }),
            checkoutPreview: preview,
            listCampaigns: async () => [],
            release: async () => ({}),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate(context: any) {
          if (!role) return false;
          context.switchToHttp().getRequest().user = { id: actorId, role };
          return true;
        },
      });
    const module = await builder.compile();
    const app = module.createNestApplication();
    try {
      app.useGlobalPipes(pipe);
      await app.init();
      const http = app.getHttpServer();
      const wallet = await request(http).get('/vouchers/wallet').expect(200);
      expect(wallet.body[0].customerId).toBe(actorId);
      actorId = randomUUID();
      expect(
        (await request(http).get('/vouchers/wallet')).body[0].customerId,
      ).toBe(actorId);
      await request(http).get('/vouchers/campaigns').expect(403);
      const previewClaim = randomUUID();
      const previewScope = randomUUID();
      await request(http).get(`/vouchers/checkout-preview/${previewClaim}/${previewScope}`).expect(200, { previewOnly: true, paymentAvailable: false });
      expect(preview).toHaveBeenCalledWith({ id: actorId, role: Role.CUSTOMER }, previewClaim, previewScope);
      expect(preview.mock.calls[0]).toHaveLength(3);
      await request(http).get(`/vouchers/checkout-preview/${previewClaim}/${previewScope}?amount=1&discount=999999`).expect(400);
      await request(http).post(`/vouchers/checkout-preview/${previewClaim}/${previewScope}`).send({ amount: 1, discount: 999999 }).expect(404);
      await request(http).get('/vouchers/checkout-preview/forged/forged').expect(400);
      expect((await request(http).get('/vouchers/general').expect(200)).body[0].code).toBe('GENERAL');
      await request(http).post(`/vouchers/campaigns/${randomUUID()}/grants`).send({ customerId: randomUUID(), grantId: randomUUID() }).expect(403);
      await request(http)
        .post('/vouchers/reservations/forged/release')
        .expect(400);
      await request(http).post('/vouchers/redeem').expect(404);
      for (let i = 0; i < 5; i++)
        await request(http)
          .post('/vouchers/claim')
          .send({ code: 'TEST100' })
          .expect(201);
      await request(http)
        .post('/vouchers/claim')
        .send({ code: 'TEST100' })
        .expect(429);
      const apply = {
        claimId: randomUUID(),
        scopeId: randomUUID(),
        attemptId: randomUUID(),
      };
      for (let i = 0; i < 5; i++)
        await request(http).post('/vouchers/apply').send(apply).expect(201);
      await request(http).post('/vouchers/apply').send(apply).expect(429);
      role = Role.ADMIN;
      await request(http).get('/vouchers/campaigns').expect(200);
      await request(http).get(`/vouchers/checkout-preview/${randomUUID()}/${randomUUID()}`).expect(403);
      await request(http).get('/vouchers/general').expect(403);
      await request(http).post(`/vouchers/campaigns/${randomUUID()}/grants`).send({ customerId: randomUUID(), grantId: randomUUID() }).expect(201);
      await request(http).post(`/vouchers/campaigns/${randomUUID()}/grants`).send({ customerId: 'bad', grantId: randomUUID() }).expect(400);
      await request(http).get('/vouchers/wallet').expect(403);
      await request(http).post('/vouchers/apply').send(apply).expect(403);
      role = Role.TECHNICIAN;
      await request(http).get('/vouchers/wallet').expect(403);
      role = undefined;
      await request(http).get('/vouchers/wallet').expect(403);
    } finally {
      await app.close();
    }
  });
});
