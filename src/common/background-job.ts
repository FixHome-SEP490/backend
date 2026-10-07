import { Logger } from '@nestjs/common';

export const DEFAULT_BACKGROUND_INTERVAL_MS = 60_000;

/**
 * Runs `work` every BACKGROUND_JOBS_INTERVAL_MS (default one minute) so time
 * based rules (an invitation expiring, a technician who has not set out) take
 * effect even when nobody opens a screen. Never two runs at once, a failure is
 * logged and the next tick tries again, and nothing runs under a test runner.
 * Row locks inside `work` keep several backend instances safe.
 */
export function startBackgroundJob(
  name: string,
  logger: Logger,
  work: () => Promise<void>,
): NodeJS.Timeout | null {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return null;
  const interval = Number(process.env.BACKGROUND_JOBS_INTERVAL_MS ?? DEFAULT_BACKGROUND_INTERVAL_MS);
  if (!Number.isFinite(interval) || interval <= 0) return null;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    work()
      .catch((error: unknown) => logger.warn(`${name} failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  }, interval);
  timer.unref?.();
  return timer;
}
