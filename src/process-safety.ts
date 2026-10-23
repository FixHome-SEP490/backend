import { Logger } from '@nestjs/common';

/**
 * A promise nobody awaited (a fire-and-forget notification, a background sweep)
 * that rejects is logged, not allowed to stop the server. On 23/10/2026 the
 * database refused new connections for a while; each failed notification then
 * ended the process (Node 20 exits on an unhandled rejection), Docker restarted
 * it, and every restart opened its connections again. A synchronous uncaught
 * exception still stops the process, since its state is unknown.
 */
export function installProcessSafety(target: NodeJS.Process = process, logger = new Logger('Process')): void {
  target.on('unhandledRejection', (reason: unknown) => {
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    logger.error(`Unhandled promise rejection: ${detail}`);
  });
}
