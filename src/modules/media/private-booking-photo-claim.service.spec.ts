import { EntityManager } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { PrivateBookingPhotoUpload } from './entities/private-booking-photo-upload.entity';
import { PrivateBookingPhotoClaimService } from './private-booking-photo-claim.service';

const OWNER_ID = '7f2fd9d2-e616-4d44-b2c3-9be271029eba';
const FOREIGN_OWNER_ID = '9f2fd9d2-e616-4d44-b2c3-9be271029eba';
const BOOKING_ID = '4dd8729b-fb01-4f7b-b1f1-198a1e4a1771';
const OTHER_BOOKING_ID = '5dd8729b-fb01-4f7b-b1f1-198a1e4a1771';
const UPLOAD_IDS = [
  '25b11d61-7c97-4a29-a53b-97ca76ac3435',
  '35b11d61-7c97-4a29-a53b-97ca76ac3435',
  '45b11d61-7c97-4a29-a53b-97ca76ac3435',
  '55b11d61-7c97-4a29-a53b-97ca76ac3435',
  '65b11d61-7c97-4a29-a53b-97ca76ac3435',
  '75b11d61-7c97-4a29-a53b-97ca76ac3435',
] as const;
const OBJECT_REF = `storage://booking-private/${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`;
const FIXED_NOW = new Date('2026-09-21T12:00:00.000Z');

type UploadRow = PrivateBookingPhotoUpload & { id: string };

function uploadRow(
  id: string,
  overrides: Partial<UploadRow> = {},
): UploadRow {
  return {
    id,
    ownerUserId: OWNER_ID,
    objectRef: OBJECT_REF,
    mimeType: 'image/jpeg',
    sizeBytes: 128,
    expiresAt: new Date(FIXED_NOW.getTime() + 60_000),
    claimedBookingId: null,
    ...overrides,
  } as UploadRow;
}

function createMockManager(
  initialRows: UploadRow[],
  options: { failUpdateAt?: number } = {},
) {
  const rows = initialRows.map((row) => ({ ...row, expiresAt: new Date(row.expiresAt) }));
  const queryRunner = { isTransactionActive: true };
  let updateCount = 0;

  const findOne = vi.fn(
    async (
      _target: unknown,
      findOptions: { where?: { id?: string }; lock?: { mode: string } },
    ) => rows.find((row) => row.id === findOptions.where?.id) ?? null,
  );
  const update = vi.fn(
    async (
      _target: unknown,
      criteria: { id: string; ownerUserId: string },
      changes: { claimedBookingId: string },
    ) => {
      updateCount += 1;
      if (options.failUpdateAt === updateCount) {
        throw new Error(`database failure involving ${OBJECT_REF}`);
      }

      const row = rows.find(
        (candidate) =>
          candidate.id === criteria.id &&
          candidate.ownerUserId === criteria.ownerUserId &&
          candidate.claimedBookingId == null &&
          candidate.expiresAt > FIXED_NOW,
      );
      if (!row) return { affected: 0 };

      row.claimedBookingId = changes.claimedBookingId;
      return { affected: 1 };
    },
  );

  const manager = { queryRunner, findOne, update } as unknown as EntityManager;
  return { manager, rows, findOne, update, queryRunner };
}

async function runMockTransaction<T>(
  db: ReturnType<typeof createMockManager>,
  operation: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const before = db.rows.map((row) => ({ ...row, expiresAt: new Date(row.expiresAt) }));
  try {
    return await operation(db.manager);
  } catch (error) {
    db.rows.splice(0, db.rows.length, ...before);
    throw error;
  }
}

async function expectBusinessError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BusinessException);
  expect((error as BusinessException).getResponse()).toMatchObject({ code });
  expect(JSON.stringify((error as BusinessException).getResponse())).not.toContain(OBJECT_REF);
}

describe('PrivateBookingPhotoClaimService', () => {
  let service: PrivateBookingPhotoClaimService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    service = new PrivateBookingPhotoClaimService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('locks upload rows in stable ID order and returns only safe metadata', async () => {
    const db = createMockManager([uploadRow(UPLOAD_IDS[1]), uploadRow(UPLOAD_IDS[0])]);

    const result = await service.claim(db.manager, OWNER_ID, BOOKING_ID, [
      UPLOAD_IDS[1],
      UPLOAD_IDS[0],
    ]);

    expect(db.findOne.mock.calls.map(([, options]) => options.where?.id)).toEqual([
      UPLOAD_IDS[0],
      UPLOAD_IDS[1],
    ]);
    expect(db.findOne.mock.calls.every(([, options]) => options.lock?.mode === 'pessimistic_write')).toBe(
      true,
    );
    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      db.findOne.mock.invocationCallOrder.at(-1)!,
    );
    const [entity, criteria, changes] = db.update.mock.calls[0];
    expect(entity).toBe(PrivateBookingPhotoUpload);
    expect(criteria.id).toBe(UPLOAD_IDS[0]);
    expect(criteria.ownerUserId).toBe(OWNER_ID);
    expect(Reflect.get(Reflect.get(criteria, 'claimedBookingId') as object, 'type')).toBe(
      'isNull',
    );
    const expiryCondition = Reflect.get(criteria, 'expiresAt') as object;
    expect(Reflect.get(expiryCondition, 'type')).toBe('moreThan');
    expect(Reflect.get(expiryCondition, 'value')).toEqual(FIXED_NOW);
    expect(changes).toEqual({ claimedBookingId: BOOKING_ID });
    expect(result).toEqual([
      { uploadId: UPLOAD_IDS[0], mimeType: 'image/jpeg', sizeBytes: 128 },
      { uploadId: UPLOAD_IDS[1], mimeType: 'image/jpeg', sizeBytes: 128 },
    ]);
    expect(JSON.stringify(result)).not.toContain('objectRef');
    expect(JSON.stringify(result)).not.toContain('storage://');
    expect(db.rows.every((row) => row.claimedBookingId === BOOKING_ID)).toBe(true);
  });

  it('accepts the maximum of five distinct uploads', async () => {
    const ids = UPLOAD_IDS.slice(0, 5);
    const db = createMockManager(ids.map((id) => uploadRow(id)));

    const result = await service.claim(db.manager, OWNER_ID, BOOKING_ID, [...ids]);

    expect(result).toHaveLength(5);
    expect(db.update).toHaveBeenCalledTimes(5);
  });

  it('rejects a missing upload without revealing storage metadata', async () => {
    const db = createMockManager([]);

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, [UPLOAD_IDS[0]]),
      ErrorCodes.OWNERSHIP_DENIED,
    );

    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects an upload owned by another customer', async () => {
    const db = createMockManager([
      uploadRow(UPLOAD_IDS[0], { ownerUserId: FOREIGN_OWNER_ID }),
    ]);

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, [UPLOAD_IDS[0]]),
      ErrorCodes.OWNERSHIP_DENIED,
    );

    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects an upload when its claim state is missing', async () => {
    const db = createMockManager([
      uploadRow(UPLOAD_IDS[0], { claimedBookingId: undefined }),
    ]);

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, [UPLOAD_IDS[0]]),
      ErrorCodes.OWNERSHIP_DENIED,
    );

    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects an upload whose expiry is equal to now and leaves all rows unchanged', async () => {
    const db = createMockManager([
      uploadRow(UPLOAD_IDS[0]),
      uploadRow(UPLOAD_IDS[1], { expiresAt: new Date(FIXED_NOW) }),
    ]);

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, [UPLOAD_IDS[0], UPLOAD_IDS[1]]),
      ErrorCodes.OWNERSHIP_DENIED,
    );

    expect(db.update).not.toHaveBeenCalled();
    expect(db.rows.every((row) => row.claimedBookingId == null)).toBe(true);
  });

  it.each([
    ['same booking', BOOKING_ID],
    ['different booking', OTHER_BOOKING_ID],
  ])('rejects a single-use replay for the %s', async (_label, replayBookingId) => {
    const db = createMockManager([uploadRow(UPLOAD_IDS[0])]);

    await service.claim(db.manager, OWNER_ID, BOOKING_ID, [UPLOAD_IDS[0]]);
    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, replayBookingId, [UPLOAD_IDS[0]]),
      ErrorCodes.OWNERSHIP_DENIED,
    );

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.rows[0].claimedBookingId).toBe(BOOKING_ID);
  });

  it('rejects duplicate UUIDs including case-only duplicates before querying', async () => {
    const db = createMockManager([uploadRow(UPLOAD_IDS[0])]);

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, [
        UPLOAD_IDS[0],
        UPLOAD_IDS[0].toUpperCase(),
      ]),
      ErrorCodes.VALIDATION_FAILED,
    );

    expect(db.findOne).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects more than five upload IDs before querying', async () => {
    const db = createMockManager([]);

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, [...UPLOAD_IDS]),
      ErrorCodes.VALIDATION_FAILED,
    );

    expect(db.findOne).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects non-UUID upload IDs before querying', async () => {
    const db = createMockManager([]);

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, ['not-a-uuid']),
      ErrorCodes.VALIDATION_FAILED,
    );

    expect(db.findOne).not.toHaveBeenCalled();
  });

  it('requires the caller-provided manager to be in an active transaction', async () => {
    const db = createMockManager([uploadRow(UPLOAD_IDS[0])]);
    db.queryRunner.isTransactionActive = false;

    await expectBusinessError(
      service.claim(db.manager, OWNER_ID, BOOKING_ID, [UPLOAD_IDS[0]]),
      ErrorCodes.INTERNAL_SERVER_ERROR,
    );

    expect(db.findOne).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('lets update failures escape the caller transaction so partial claims roll back', async () => {
    const db = createMockManager(
      [uploadRow(UPLOAD_IDS[0]), uploadRow(UPLOAD_IDS[1])],
      { failUpdateAt: 2 },
    );

    await expectBusinessError(
      runMockTransaction(db, (manager) =>
        service.claim(manager, OWNER_ID, BOOKING_ID, [UPLOAD_IDS[0], UPLOAD_IDS[1]]),
      ),
      ErrorCodes.INTERNAL_SERVER_ERROR,
    );

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.rows.every((row) => row.claimedBookingId == null)).toBe(true);
  });
});
