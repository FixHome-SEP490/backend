import { randomUUID } from 'crypto';

/**
 * Order codes carry the date in Vietnam time. Taking it from toISOString()
 * stamped orders created between 00:00 and 07:00 with the previous day.
 */
export function newOrderCode(now: Date = new Date()): string {
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const day = vn.toISOString().slice(0, 10).replace(/-/g, '');
  return `FH-${day}-${randomUUID().slice(0, 8).toUpperCase()}`;
}
