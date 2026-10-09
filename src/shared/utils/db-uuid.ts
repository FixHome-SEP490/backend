/**
 * The shape PostgreSQL stores for a uuid column. Ids the server itself issued or
 * read (the signed-in user, a booking, a media row) are checked against this, not
 * isUUID(): the seeded accounts carry ids such as d0000000-0000-0000-0000-000000000001
 * that are valid uuids to the database but not RFC 4122 versions, and isUUID()
 * turned every one of their photo bookings away.
 */
export const DB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isDbUuid = (value: unknown): value is string => typeof value === 'string' && DB_UUID.test(value);
