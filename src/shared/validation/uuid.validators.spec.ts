import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { QueryAuditLogDto } from '../../modules/audit-log/dto/query-audit-log.dto';
import { CreateNotificationDto } from '../../modules/notifications/dto/create-notification.dto';
import { QueryPartRequestsDto } from '../../modules/part-requests/dto';
import { StrikeListQueryDto } from '../../modules/service-orders/dto/order-list-query.dto';
import { AssignWarrantyClaimDto, QueryWarrantyClaimsDto } from '../../modules/service-orders/dto/warranty-claim.dto';
import { QuerySupportCasesDto } from '../../modules/support-cases/dto/query-support-cases.dto';
import { isCanonicalUuid } from './uuid.validators';

// Real ids of the seeded accounts on the shared database (version nibble 0).
const SEED_ADMIN = 'a0000000-0000-0000-0000-000000000001';
const SEED_MANAGER = 'b0000000-0000-0000-0000-000000000001';
const SEED_TECHNICIAN = 'c0000000-0000-0000-0000-000000000001';
const V4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const REJECTED = [
  '', ' ', 'admin', 'a0000000-0000-0000-0000-00000000001', 'a0000000-0000-0000-0000-0000000000011',
  'a0000000000000000000000000000001', 'a0000000-0000-0000-0000-00000000000g', ` ${SEED_ADMIN}`,
  `${SEED_ADMIN} `, `${SEED_ADMIN}' OR 1=1`, '{a0000000-0000-0000-0000-000000000001}', '🙂',
  'x'.repeat(2000),
];

const errorsFor = async <T extends object>(cls: new () => T, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe('isCanonicalUuid', () => {
  it('accepts the seeded legacy ids and RFC ids in any case', () => {
    for (const id of [SEED_ADMIN, SEED_MANAGER, SEED_TECHNICIAN, V4, V4.toUpperCase()]) {
      expect(isCanonicalUuid(id), id).toBe(true);
    }
  });

  it('rejects free text, wrong length, wrong grouping, padding and non strings', () => {
    for (const value of [...REJECTED, null, undefined, 1, {}, [SEED_ADMIN]]) {
      expect(isCanonicalUuid(value), String(value)).toBe(false);
    }
  });
});

describe('user id filters accept the seeded account ids', () => {
  const cases: Array<[string, new () => object, string, object]> = [
    ['audit log actor', QueryAuditLogDto, 'actorUserId', {}],
    ['strike list user', StrikeListQueryDto, 'userId', {}],
    ['part request technician', QueryPartRequestsDto, 'technicianId', {}],
    ['warranty claim list technician', QueryWarrantyClaimsDto, 'technicianId', {}],
    ['warranty claim assignment', AssignWarrantyClaimDto, 'technicianId', {}],
    ['support case manager', QuerySupportCasesDto, 'assignedManagerId', {}],
    ['notification target', CreateNotificationDto, 'userId', { title: 'Tiêu đề', message: 'Nội dung', type: 'SYSTEM' }],
  ];

  it.each(cases)('%s takes a seeded id and a v4 id', async (_name, cls, field, base) => {
    for (const id of [SEED_ADMIN, SEED_MANAGER, SEED_TECHNICIAN, V4]) {
      expect(await errorsFor(cls, { ...base, [field]: id })).not.toContain(field);
    }
  });

  it.each(cases)('%s still refuses anything that is not a UUID', async (_name, cls, field, base) => {
    for (const value of REJECTED) {
      expect(await errorsFor(cls, { ...base, [field]: value }), value).toContain(field);
    }
  });

  it('keeps the error text the Console already shows for a bad actor id', async () => {
    const [error] = await validate(plainToInstance(QueryAuditLogDto, { actorUserId: 'abc' }));
    expect(Object.values(error.constraints ?? {})).toEqual(['actorUserId must be a UUID']);
  });
});
