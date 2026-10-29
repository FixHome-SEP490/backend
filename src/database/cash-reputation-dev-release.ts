import 'reflect-metadata';
import dataSource from './data-source';
import { runCashReputationDevGate } from './cash-reputation-dev-gate';

async function main() {
  if (process.env.NODE_ENV !== 'production' || process.env.CASH_REPUTATION_DEV_RELEASE !== '1') {
    throw new Error('Cash/reputation DEV migration requires production runtime and explicit release flag');
  }
  if (process.env.CASH_FIRST_ENABLED === 'true' &&
      (process.env.CASH_LEGACY_COMPAT_ENABLED !== 'true' || process.env.CASH_FIRST_DEV_ACTIVATION !== '1')) {
    throw new Error('Cash-first DEV activation requires temporary Mobile compatibility and separate release opt-in');
  }
  const db = await dataSource.initialize();
  try {
    const pending = await runCashReputationDevGate(db, process.env.CASH_FIRST_ENABLED === 'true');
    console.info(pending.length ? 'Cash/reputation DEV migrations applied and verified'
      : 'Cash/reputation DEV migrations already applied and verified');
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Cash/reputation DEV migration gate failed');
  process.exitCode = 1;
});
