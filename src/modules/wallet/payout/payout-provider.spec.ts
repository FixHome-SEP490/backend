import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestError,
  ConnectionError,
  ConnectionTimeoutError,
  ForbiddenError,
  InternalServerError,
  UnauthorizedError,
} from '@payos/node';
import { MockPayoutProvider } from './mock-payout.provider';
import { PayosPayoutProvider } from './payos-payout.provider';
import { createPayoutProvider } from './payout-provider.factory';
import {
  PayoutInstruction,
  PayoutRejectedError,
  PayoutUnknownError,
} from './payout-provider';

const instruction = (toAccountNumber: string, amount = 100_000): PayoutInstruction => ({
  referenceId: `ref-${toAccountNumber}`,
  amount,
  description: 'FixHome rut tien',
  toBin: '970436',
  toAccountNumber,
});

function config(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] } as never;
}

describe('MockPayoutProvider', () => {
  it('pays an ordinary account immediately and takes it from the source', async () => {
    const provider = new MockPayoutProvider(1_000_000);

    const result = await provider.createPayout(instruction('0123456789'), 'k');

    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.bankReference).toMatch(/^MOCK/);
    expect(await provider.getSourceBalance()).toBe(900_000);
  });

  it('refuses an account ending in 0000, so the refund path can be tried', async () => {
    const provider = new MockPayoutProvider(1_000_000);

    await expect(
      provider.createPayout(instruction('1234560000'), 'k'),
    ).rejects.toBeInstanceOf(PayoutRejectedError);
    expect(await provider.getSourceBalance()).toBe(1_000_000);
  });

  it('leaves an account ending in 9999 pending until someone asks', async () => {
    const provider = new MockPayoutProvider(1_000_000);

    const first = await provider.createPayout(instruction('1234569999'), 'k');
    const later = await provider.findPayoutByReference('ref-1234569999');

    expect(first.outcome).toBe('PROCESSING');
    expect(later?.outcome).toBe('SUCCEEDED');
  });

  it('refuses when the simulated source is short', async () => {
    const provider = new MockPayoutProvider(50_000);

    await expect(
      provider.createPayout(instruction('0123456789', 60_000), 'k'),
    ).rejects.toBeInstanceOf(PayoutRejectedError);
  });

  it('answers the same reference twice with the same payout, never paying twice', async () => {
    const provider = new MockPayoutProvider(1_000_000);

    const first = await provider.createPayout(instruction('0123456789'), 'k');
    const again = await provider.createPayout(instruction('0123456789'), 'k');

    expect(again.payoutId).toBe(first.payoutId);
    expect(await provider.getSourceBalance()).toBe(900_000);
  });

  it('has never heard of a reference it was not given', async () => {
    const provider = new MockPayoutProvider(1_000_000);
    expect(await provider.findPayoutByReference('nope')).toBeNull();
  });
});

describe('createPayoutProvider', () => {
  it('uses the simulator by default outside production', () => {
    expect(createPayoutProvider(config({ NODE_ENV: 'development' })).name).toBe('mock');
  });

  it('refuses the simulator in production, where it would fake payments', () => {
    expect(() =>
      createPayoutProvider(config({ NODE_ENV: 'production', PAYOUT_PROVIDER: 'mock' })),
    ).toThrow('not allowed in production');
  });

  it('refuses to guess in production when nothing is configured', () => {
    expect(() => createPayoutProvider(config({ NODE_ENV: 'production' }))).toThrow();
  });

  it('fails at boot when payOS is chosen without its keys', () => {
    expect(() =>
      createPayoutProvider(
        config({ PAYOUT_PROVIDER: 'payos', PAYOS_PAYOUT_CLIENT_ID: 'id' }),
      ),
    ).toThrow('PAYOS_PAYOUT_API_KEY');
  });

  it('builds the payOS provider when all three keys are present', () => {
    const provider = createPayoutProvider(
      config({
        PAYOUT_PROVIDER: 'payos',
        PAYOS_PAYOUT_CLIENT_ID: 'id',
        PAYOS_PAYOUT_API_KEY: 'key',
        PAYOS_PAYOUT_CHECKSUM_KEY: 'sum',
      }),
    );
    expect(provider.name).toBe('payos');
  });

  it('rejects an unknown provider name', () => {
    expect(() => createPayoutProvider(config({ PAYOUT_PROVIDER: 'momo' }))).toThrow(
      'must be "payos" or "mock"',
    );
  });
});

describe('PayosPayoutProvider', () => {
  function withClient(client: unknown) {
    const provider = new PayosPayoutProvider({
      clientId: 'id',
      apiKey: 'key',
      checksumKey: 'sum',
    });
    (provider as unknown as { client: unknown }).client = client;
    return provider;
  }

  const payout = (state: string, extra: Record<string, unknown> = {}) => ({
    id: 'po_1',
    referenceId: 'ref',
    approvalState: 'COMPLETED',
    category: null,
    createdAt: '2026-09-29T00:00:00Z',
    transactions: [
      {
        id: 'tx',
        referenceId: 'ref',
        amount: 100_000,
        description: 'd',
        toBin: '970436',
        toAccountNumber: '0123456789',
        toAccountName: 'NGUYEN VAN THO',
        reference: 'FT123',
        transactionDatetime: null,
        errorMessage: null,
        errorCode: null,
        state,
        ...extra,
      },
    ],
  });

  describe('reading payOS states', () => {
    it.each([
      ['SUCCEEDED', 'SUCCEEDED'],
      ['FAILED', 'FAILED'],
      ['CANCELLED', 'FAILED'],
      ['REVERSED', 'FAILED'],
      ['RECEIVED', 'PROCESSING'],
      ['PROCESSING', 'PROCESSING'],
      ['ON_HOLD', 'PROCESSING'],
    ])('%s means %s', async (state, outcome) => {
      const provider = withClient({
        payouts: { create: vi.fn(async () => payout(state)) },
      });

      const result = await provider.createPayout(instruction('0123456789'), 'k');

      expect(result.outcome).toBe(outcome);
      expect(result.providerState).toBe(state);
    });

    it('keeps the bank reference and the error message', async () => {
      const provider = withClient({
        payouts: {
          create: vi.fn(async () => payout('FAILED', { errorMessage: 'Tài khoản bị khoá' })),
        },
      });

      const result = await provider.createPayout(instruction('0123456789'), 'k');

      expect(result.bankReference).toBe('FT123');
      expect(result.failureReason).toBe('Tài khoản bị khoá');
    });

    it('passes the idempotency key through to payOS', async () => {
      const create = vi.fn(async () => payout('SUCCEEDED'));
      const provider = withClient({ payouts: { create } });

      await provider.createPayout(instruction('0123456789'), 'withdrawal-id');

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ toBin: '970436', amount: 100_000 }),
        'withdrawal-id',
      );
    });
  });

  describe('telling a refusal from an unknown outcome', () => {
    it.each([
      ['400 bad request', () => new BadRequestError(400, { code: '20' }, 'invalid account', undefined as never)],
      ['401 wrong keys', () => new UnauthorizedError(401, { code: '401' }, 'unauthorized', undefined as never)],
    ])('%s is a refusal: nothing was sent, refund is safe', async (_label, make) => {
      const provider = withClient({
        payouts: { create: vi.fn(async () => { throw make(); }) },
      });

      await expect(
        provider.createPayout(instruction('0123456789'), 'k'),
      ).rejects.toBeInstanceOf(PayoutRejectedError);
    });

    it('hides our own setup errors from the technician behind a plain sentence', async () => {
      const provider = withClient({
        payouts: {
          create: vi.fn(async () => {
            throw new ForbiddenError(403, { code: '403' }, 'Địa chỉ IP không được phép truy cập hệ thống', undefined as never);
          }),
        },
      });

      const error = await provider.createPayout(instruction('0123456789'), 'k').catch((e) => e);

      expect(error).toBeInstanceOf(PayoutRejectedError);
      expect(error.message).toBe('Kênh chi hộ đang tạm ngưng, vui lòng thử lại sau');
      expect(error.message).not.toContain('IP');
    });

    it.each([
      ['a dropped connection', () => new ConnectionError('socket hang up')],
      ['a timeout', () => new ConnectionTimeoutError('timed out')],
      ['a 5xx', () => new InternalServerError(502, {}, 'bad gateway', undefined as never)],
      ['something unexpected', () => new Error('boom')],
    ])('%s is unknown: the money may already have left', async (_label, make) => {
      const provider = withClient({
        payouts: { create: vi.fn(async () => { throw make(); }) },
      });

      await expect(
        provider.createPayout(instruction('0123456789'), 'k'),
      ).rejects.toBeInstanceOf(PayoutUnknownError);
    });

    it('treats a failed lookup as unknown, never as "not found"', async () => {
      const provider = withClient({
        payouts: { list: vi.fn(async () => { throw new ConnectionError('down'); }) },
      });

      await expect(provider.findPayoutByReference('ref')).rejects.toBeInstanceOf(
        PayoutUnknownError,
      );
    });

    it('reports "not found" only when payOS answers with nothing', async () => {
      const provider = withClient({
        payouts: { list: vi.fn(async () => ({ data: [] })) },
      });

      expect(await provider.findPayoutByReference('ref')).toBeNull();
    });
  });

  describe('source balance', () => {
    it('reads the Ví payOS balance as a number', async () => {
      const provider = withClient({
        payoutsAccount: { balance: vi.fn(async () => ({ balance: '1500000' })) },
      });
      expect(await provider.getSourceBalance()).toBe(1_500_000);
    });

    it('returns null rather than zero when the balance cannot be read', async () => {
      const provider = withClient({
        payoutsAccount: { balance: vi.fn(async () => { throw new ConnectionError('x'); }) },
      });
      expect(await provider.getSourceBalance()).toBeNull();
    });
  });
});
