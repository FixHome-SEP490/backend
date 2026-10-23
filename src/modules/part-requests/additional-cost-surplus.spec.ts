import { describe, expect, it } from 'vitest';
import { assertApprovedPartsResolved, usedPartQuantities } from './part-request-lifecycle';
import { PartRequestStatus, PartRequestType, PartSource, PartUsageStatus } from '../../shared/enums';
import type { PartRequest } from './entities/part-request.entity';

// BUG DETECTOR 14: parts the technician already holds from the pre-repair request serve an
// approved additional cost; each approval still keeps its own quantity.
const fixhome = (quantity: number) => ({ partSource: PartSource.FIXHOME, partCatalogId: 'valve', quantity });
const preRepair = (quantity: number, usage = PartUsageStatus.USED) => ({
  id: 'pre', status: PartRequestStatus.RECEIVED, requestType: PartRequestType.PRE_REPAIR,
  items: [{ id: 'pre-item', quantity, partSource: PartSource.FIXHOME, partCatalogId: 'valve', usageStatus: usage }],
}) as unknown as PartRequest;
const additional = (quantity: number) => ({
  id: 'add', status: PartRequestStatus.RECEIVED, requestType: PartRequestType.ADDITIONAL, additionalCostId: 'cost',
  items: [{ id: 'add-item', quantity, partSource: PartSource.FIXHOME, partCatalogId: 'valve', usageStatus: PartUsageStatus.USED }],
}) as unknown as PartRequest;
const lines = (quote: number, cost: number) => [{ ...fixhome(quote), source: 'quotation' }, { ...fixhome(cost), source: 'cost' }];

describe('an additional cost served by parts already held', () => {
  it('bills the quotation and the additional cost from the units used, in either order', () => {
    // 2 received before repair, quote approved 1, additional cost approved 1 with no new request, both used.
    const custody = new Map([['pre-item', 2]]);
    const quoteFirst = usedPartQuantities([preRepair(2)], custody, 'quote', lines(1, 1));
    expect([quoteFirst('quotation', fixhome(1)), quoteFirst('cost', fixhome(1))]).toEqual([1, 1]);
    const costFirst = usedPartQuantities([preRepair(2)], custody, 'quote', lines(1, 1));
    expect([costFirst('cost', fixhome(1)), costFirst('quotation', fixhome(1))]).toEqual([1, 1]);
    expect(() => assertApprovedPartsResolved(lines(1, 1), [preRepair(2)], 'quote', custody)).not.toThrow();
  });

  it('uses the additional cost own units first and the held surplus only for the rest', () => {
    const custody = new Map([['pre-item', 2], ['add-item', 1]]);
    const bill = usedPartQuantities([preRepair(2), additional(1)], custody, 'quote', lines(1, 2));
    expect(bill('cost', fixhome(2))).toBe(2);
    expect(bill('quotation', fixhome(1))).toBe(1);
    expect(() => assertApprovedPartsResolved(lines(1, 2), [preRepair(2), additional(1)], 'quote', custody)).not.toThrow();
  });

  it('never bills or accepts more than the approvals together', () => {
    // 3 used out of the pre-repair line, but only 1 + 1 approved.
    const custody = new Map([['pre-item', 3]]);
    expect(() => assertApprovedPartsResolved(lines(1, 1), [preRepair(3)], 'quote', custody)).toThrow();
    const bill = usedPartQuantities([preRepair(3)], custody, 'quote', lines(1, 1));
    expect(bill('quotation', fixhome(1)) + bill('cost', fixhome(1))).toBe(2);
  });

  it('does not let an additional cost lean on units nobody holds', () => {
    // Quote 1 and cost 1, but only 1 delivered: the cost has no supply.
    expect(() => assertApprovedPartsResolved(lines(1, 1), [preRepair(1)], 'quote', new Map([['pre-item', 1]]))).toThrow();
  });

  it('keeps the old separation when no additional cost needs the surplus', () => {
    const bill = usedPartQuantities([preRepair(2)], new Map([['pre-item', 1]]), 'quote', lines(1, 0));
    expect(bill('cost', fixhome(1))).toBe(0);
    expect(bill('quotation', fixhome(1))).toBe(1);
  });
});
