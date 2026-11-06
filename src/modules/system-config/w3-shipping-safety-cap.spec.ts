import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentsHost, Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { BusinessException } from '../../common/exceptions/business.exception';
import { assertW3NewShippingFee } from './w3-shipping-safety-cap';

// Persistence double only; the helper, BusinessException, filter and Nest HTTP are real.
const manager = {
  findOne: async () => ({ value: '0', valueType: 'int' }),
} as unknown as EntityManager;
const message = 'Phí giao mới vượt giới hạn cho phép. Vui lòng liên hệ quản trị viên.';

@Controller('w3-cap-contract')
class CapContractController {
  @Post()
  quote() {
    return assertW3NewShippingFee(manager, 20);
  }
}

describe('W3 shipping cap public error contract', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['production', 'development'])('keeps the dedicated 409 code and strips all private details in %s', async (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    const error: BusinessException = await assertW3NewShippingFee(manager, 20).then(
      () => { throw new Error('Expected the shipping cap to reject'); },
      (rejected) => rejected,
    );
    const internal = error.getResponse() as { details: Record<string, unknown> };
    expect(internal.details).toEqual({ blocker: 'W3_SHIPPING_CAP_EXCEEDED', maxNewFeeVnd: 0 });
    // Synthetic private fields must stay private even if internal diagnostics grow later.
    Object.assign(internal.details, { sourceRef: 'private:synthetic-source', courierPayeeId: 'synthetic-private-payee' });
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const path = '/api/v1/part-requests/synthetic/delivery/terms/proposal';
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', path }),
        getResponse: () => ({ status }),
      }),
    } as unknown as ArgumentsHost;

    new HttpExceptionFilter().catch(error, host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledExactlyOnceWith({
      success: false,
      statusCode: 409,
      error: { code: 'W3_SHIPPING_CAP_EXCEEDED', message },
      timestamp: expect.any(String),
      path,
    });
  });

  it('serializes the same public error through real Nest HTTP with no cap/details fields', async () => {
    const module = await Test.createTestingModule({ controllers: [CapContractController] }).compile();
    const app = module.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    try {
      const response = await request(app.getHttpServer()).post('/w3-cap-contract').expect(409);
      expect(response.body).toEqual({
        success: false,
        statusCode: 409,
        error: { code: 'W3_SHIPPING_CAP_EXCEEDED', message },
        timestamp: expect.any(String),
        path: '/w3-cap-contract',
      });
    } finally {
      await app.close();
    }
  });
});
