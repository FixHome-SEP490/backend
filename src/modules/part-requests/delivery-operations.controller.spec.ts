import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  DeliveryCommandDto,
  DeliveryOperationsController,
  ShippingConsentDto,
  ShippingProposalDto,
} from './delivery-operations.controller';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const validate = (metatype: any, value: any) =>
  pipe.transform(value, { type: 'body', metatype });
describe('delivery operations transport contract', () => {
  it('mounts commands behind real JWT and role guards', () => {
    expect(
      Reflect.getMetadata('__guards__', DeliveryOperationsController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
  });
  it.each([
    {},
    { accepted: false },
    { accepted: 'true' },
    { totalShippingFee: '0' },
    { actorId: randomUUID() },
    { shippingApproved: true },
  ])('rejects missing or forged consent fields %j', async (extra) => {
    const body = {
      commandId: randomUUID(),
      expectedVersion: 1,
      quoteVersion: 1,
      quoteFingerprint: 'a'.repeat(64),
      totalShippingFee: 0,
      shippingShare: 0,
      accepted: true,
      ...extra,
    };
    if (Object.keys(extra).length === 0) delete (body as any).accepted;
    await expect(validate(ShippingConsentDto, body)).rejects.toMatchObject({
      status: 400,
    });
  });
  it('accepts explicit numeric zero and true while rejecting omitted fees', async () => {
    const body = {
      commandId: randomUUID(),
      expectedVersion: 0,
      warehouseId: randomUUID(),
      evidenceId: randomUUID(),
      courierReference: 'manual-free-quote',
      totalShippingFee: 0,
    };
    expect((await validate(ShippingProposalDto, body)).totalShippingFee).toBe(
      0,
    );
    delete (body as any).totalShippingFee;
    await expect(validate(ShippingProposalDto, body)).rejects.toMatchObject({
      status: 400,
    });
  });
  it('rejects caller stock quantities and malformed CAS before service calls', async () => {
    await expect(
      validate(DeliveryCommandDto, {
        commandId: randomUUID(),
        expectedVersion: -1,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      validate(DeliveryCommandDto, {
        commandId: randomUUID(),
        expectedVersion: 0,
        quantities: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
