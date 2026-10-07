// src/modules/wallet/payout/payout-provider.factory.ts
import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DisabledPayoutProvider } from './disabled-payout.provider';
import { PayosPayoutProvider } from './payos-payout.provider';
import { PAYOUT_PROVIDER, PayoutProvider } from './payout-provider';

/**
 * Picks the payout provider once, at boot. There is no simulator (PO
 * 07/10/2026: no simulated flows); withdrawals go through payOS or not at all.
 *
 * PAYOUT_PROVIDER=payos needs the three payout-channel keys and fails the boot
 * without them, rather than failing on the first withdrawal hours later.
 * Unset outside production, the channel is disabled: the app boots and every
 * withdrawal is refused before the wallet is touched. Production must name it.
 */
export function createPayoutProvider(config: ConfigService): PayoutProvider {
  const logger = new Logger('PayoutProvider');
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  const choice = (config.get<string>('PAYOUT_PROVIDER') ?? '').trim().toLowerCase();

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

  if (!choice && !isProduction) {
    logger.warn('PAYOUT_PROVIDER is not set: withdrawals are disabled. Set PAYOUT_PROVIDER=payos with its keys to pay technicians.');
    return new DisabledPayoutProvider();
  }

  throw new Error(`PAYOUT_PROVIDER must be "payos" (got "${choice || 'nothing'}")`);
}

export const payoutProviderFactory: Provider = {
  provide: PAYOUT_PROVIDER,
  inject: [ConfigService],
  useFactory: createPayoutProvider,
};
