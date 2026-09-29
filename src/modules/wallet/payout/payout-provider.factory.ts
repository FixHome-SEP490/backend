// src/modules/wallet/payout/payout-provider.factory.ts
import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockPayoutProvider } from './mock-payout.provider';
import { PayosPayoutProvider } from './payos-payout.provider';
import { PAYOUT_PROVIDER, PayoutProvider } from './payout-provider';

const DEFAULT_MOCK_BALANCE = 50_000_000;

/**
 * Picks the payout provider once, at boot.
 *
 * PAYOUT_PROVIDER=payos needs the three payout-channel keys and fails the boot
 * without them, rather than failing on the first withdrawal hours later.
 * PAYOUT_PROVIDER=mock is refused in production: a simulator there would mark
 * withdrawals as paid while nobody was paid.
 */
export function createPayoutProvider(config: ConfigService): PayoutProvider {
  const logger = new Logger('PayoutProvider');
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  const choice = (
    config.get<string>('PAYOUT_PROVIDER') ?? (isProduction ? '' : 'mock')
  )
    .trim()
    .toLowerCase();

  if (choice === 'payos') {
    const clientId = config.get<string>('PAYOS_PAYOUT_CLIENT_ID')?.trim();
    const apiKey = config.get<string>('PAYOS_PAYOUT_API_KEY')?.trim();
    const checksumKey = config.get<string>('PAYOS_PAYOUT_CHECKSUM_KEY')?.trim();
    if (!clientId || !apiKey || !checksumKey) {
      throw new Error(
        'PAYOUT_PROVIDER=payos requires PAYOS_PAYOUT_CLIENT_ID, PAYOS_PAYOUT_API_KEY and PAYOS_PAYOUT_CHECKSUM_KEY',
      );
    }
    logger.log('Withdrawals are paid out through payOS');
    return new PayosPayoutProvider({ clientId, apiKey, checksumKey });
  }

  if (choice === 'mock') {
    if (isProduction) {
      throw new Error('PAYOUT_PROVIDER=mock is not allowed in production');
    }
    const balance = Number(
      config.get<string>('MOCK_PAYOUT_BALANCE') ?? DEFAULT_MOCK_BALANCE,
    );
    logger.warn(
      'Withdrawals use the payout SIMULATOR - no real money moves. Set PAYOUT_PROVIDER=payos for real payouts.',
    );
    return new MockPayoutProvider(
      Number.isFinite(balance) && balance >= 0 ? balance : DEFAULT_MOCK_BALANCE,
    );
  }

  throw new Error(
    `PAYOUT_PROVIDER must be "payos" or "mock" (got "${choice || 'nothing'}")`,
  );
}

export const payoutProviderFactory: Provider = {
  provide: PAYOUT_PROVIDER,
  inject: [ConfigService],
  useFactory: createPayoutProvider,
};
