import 'reflect-metadata';
import dataSource from './data-source';
import { runW3DevGate } from './w3-dev-release-gate';

async function main() {
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.W3_DEV_RELEASE !== '1'
  ) {
    throw new Error(
      'W3 DEV migration requires production runtime and explicit release flag',
    );
  }
  const db = await dataSource.initialize();
  try {
    const pending = await runW3DevGate(db);
    console.info(
      pending.length
        ? 'W3 DEV migrations applied and verified'
        : 'W3 DEV migrations already applied and verified',
    );
  } finally {
    await db.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'W3 DEV migration gate failed',
  );
  process.exitCode = 1;
});
