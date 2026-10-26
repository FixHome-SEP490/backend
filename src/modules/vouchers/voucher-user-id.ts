import { isUUID } from 'class-validator';

/** Legacy FixHome demo users were seeded with canonical version-0 UUIDs.
 * Newly registered users have version-4 UUIDs. Both are real database user IDs;
 * access is still restricted by authenticated role, ownership and FK lookups.
 */
export const LEGACY_FIXHOME_USER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-0[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFixHomeUserId(value: unknown): value is string {
  return typeof value === 'string' &&
    (isUUID(value, '4') || LEGACY_FIXHOME_USER_UUID.test(value));
}
