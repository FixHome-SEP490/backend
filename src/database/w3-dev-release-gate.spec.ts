import { describe, expect, it } from 'vitest';
import {
  CASH_MIGRATIONS,
  W3_MIGRATIONS,
  planW3DevMigrations,
} from './w3-dev-release-gate';

const financePrerequisites = [
  'VoucherCore1792994400000',
  'VoucherFundingLedger1792994400001',
  'VoucherCampaignLifecycle1793116800000',
  'InterruptionWorkflow1793203200000',
];
const warehousePrerequisites = [
  'WarehouseInventory1793379600003',
  'WarehousePartFulfillment1793466000003',
];
const image = [
  ...financePrerequisites,
  ...CASH_MIGRATIONS,
  ...warehousePrerequisites,
  ...W3_MIGRATIONS,
];
const appliedBeforeW3 = image.filter(
  (name) => !W3_MIGRATIONS.includes(name as (typeof W3_MIGRATIONS)[number]),
);
const appliedWithoutCash = appliedBeforeW3.filter(
  (name) => !CASH_MIGRATIONS.includes(name as (typeof CASH_MIGRATIONS)[number]),
);

describe('W3 DEV migration whitelist', () => {
  it('recognizes 0013 as the only pending migration after the 0012 prefix', () => {
    const cap = 'W3ShippingSafetyCap1793466000013';
    expect(W3_MIGRATIONS.at(-1)).toBe(cap);
    expect(planW3DevMigrations(image.filter(name => name !== cap), image)).toEqual([cap]);
  });
  it('accepts the exact W3 order and returns only pending W3 migrations', () => {
    expect(planW3DevMigrations(appliedBeforeW3, image)).toEqual([
      ...W3_MIGRATIONS,
    ]);
    expect(
      planW3DevMigrations([...appliedBeforeW3, W3_MIGRATIONS[0]], image),
    ).toEqual(W3_MIGRATIONS.slice(1));
    expect(
      planW3DevMigrations(
        [...appliedBeforeW3, ...W3_MIGRATIONS.slice(0, 3)],
        image,
      ),
    ).toEqual(W3_MIGRATIONS.slice(3));
    expect(
      planW3DevMigrations(
        [...appliedBeforeW3, ...W3_MIGRATIONS.slice(0, 4)],
        image,
      ),
    ).toEqual(W3_MIGRATIONS.slice(4));
    expect(
      planW3DevMigrations([...appliedBeforeW3, ...W3_MIGRATIONS], image),
    ).toEqual([]);
  });

  it('leaves the exact cash pair pending for the unchanged cash gate', () => {
    expect(planW3DevMigrations(appliedWithoutCash, image)).toEqual([
      ...W3_MIGRATIONS,
    ]);
    expect(
      planW3DevMigrations([...appliedWithoutCash, CASH_MIGRATIONS[0]], image),
    ).toEqual([...W3_MIGRATIONS]);
  });

  it('fails closed when a finance or warehouse prerequisite is missing', () => {
    expect(() =>
      planW3DevMigrations(
        appliedBeforeW3.filter(
          (name) => name !== 'WarehousePartFulfillment1793466000003',
        ),
        image,
      ),
    ).toThrow('W1/W2 warehouse migration prerequisites missing');
    expect(() =>
      planW3DevMigrations(
        appliedBeforeW3.filter(
          (name) => name !== 'InterruptionWorkflow1793203200000',
        ),
        image,
      ),
    ).toThrow('Voucher/interruption migration prerequisites missing');
  });

  it('rejects any pending migration outside W3 and the exact cash pair', () => {
    expect(() =>
      planW3DevMigrations(appliedBeforeW3, [
        ...image,
        'Unexpected1793466000010',
      ]),
    ).toThrow('Unexpected pending migration');
    expect(() =>
      planW3DevMigrations(
        appliedBeforeW3.filter(
          (name) => name !== 'OrderDelayNotice1793293200002',
        ),
        [...image, 'OrderDelayNotice1793293200002'],
      ),
    ).toThrow('Unexpected pending migration');
  });

  it('rejects missing, reordered or partially applied W3 migrations', () => {
    expect(() =>
      planW3DevMigrations(
        appliedBeforeW3,
        image.filter((name) => name !== W3_MIGRATIONS[3]),
      ),
    ).toThrow('W3 migrations missing from image');
    expect(() =>
      planW3DevMigrations(
        appliedBeforeW3,
        image.filter((name) => name !== W3_MIGRATIONS[4]),
      ),
    ).toThrow('W3 migrations missing from image');
    const reordered = [...image];
    const firstW3 = reordered.indexOf(W3_MIGRATIONS[0]);
    const secondW3 = reordered.indexOf(W3_MIGRATIONS[1]);
    [reordered[firstW3], reordered[secondW3]] = [
      reordered[secondW3],
      reordered[firstW3],
    ];
    expect(() => planW3DevMigrations(appliedBeforeW3, reordered)).toThrow(
      'W3 migrations missing from image or out of order',
    );
    expect(() =>
      planW3DevMigrations([...appliedBeforeW3, W3_MIGRATIONS[1]], image),
    ).toThrow('W3 migration ledger order is invalid');
  });

  it('upgrades an applied 0011 prefix through 0013 and rejects an incomplete image', () => {
    const preparation = 'W3DeductionPreparation1793466000012';
    const beforePreparation = image.filter((name) => name !== preparation && name !== 'W3ShippingSafetyCap1793466000013');
    expect(planW3DevMigrations(beforePreparation, image)).toEqual([preparation, 'W3ShippingSafetyCap1793466000013']);
    expect(() => planW3DevMigrations(beforePreparation, beforePreparation)).toThrow(
      'W3 migrations missing from image',
    );
  });

  it('rejects a reversed cash ledger but never downgrades an applied W3 migration', () => {
    expect(() =>
      planW3DevMigrations(
        [
          ...appliedBeforeW3.filter((name) => name !== CASH_MIGRATIONS[0]),
          CASH_MIGRATIONS[1],
        ],
        image,
      ),
    ).toThrow('Cash/reputation ledger order is invalid');

    const pending = planW3DevMigrations(
      [...appliedBeforeW3, W3_MIGRATIONS[0]],
      image,
    );
    expect(pending).not.toContain(W3_MIGRATIONS[0]);
    expect(pending).toEqual(W3_MIGRATIONS.slice(1));
  });
});
