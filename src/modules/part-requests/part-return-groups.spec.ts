import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MY_RETURN_GROUPS, RETURN_GROUP_SQL, RETURN_STATUS_SQL, returnGroup } from './part-return-groups';
import { MyPartReturnsQueryDto } from './dto/my-part-returns-query.dto';
import { PartReturnsController } from './part-returns.controller';
import { Role } from '../../shared/enums';

describe('BUG DETECTOR 302: three groups of the technician part-return page', () => {
  it('maps every returnStatus to exactly the group PO set; exception and unknown to none', () => {
    expect(returnGroup('outstanding')).toBe('need_declare');
    expect(returnGroup('declared')).toBe('awaiting_manager');
    expect(returnGroup('partially_received')).toBe('awaiting_manager');
    expect(returnGroup('not_required')).toBe('completed');
    expect(returnGroup('received')).toBe('completed');
    expect(returnGroup('exception')).toBeNull();
    expect(returnGroup('unknown')).toBeNull();
    expect(MY_RETURN_GROUPS).toEqual(['need_declare', 'awaiting_manager', 'completed']);
  });

  it('keeps the SQL twin in the same order as view(): settled before exception before declarations', () => {
    const order = ['not_required', 'received', 'exception', 'partially_received', 'declared', 'outstanding'].map(s => RETURN_STATUS_SQL.indexOf(`'${s}'`));
    expect(order.every(i => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const [status, group] of [['outstanding', 'need_declare'], ['declared', 'awaiting_manager'], ['partially_received', 'awaiting_manager'], ['not_required', 'completed'], ['received', 'completed']]) {
      expect(RETURN_GROUP_SQL).toMatch(new RegExp(`WHEN '${status}' THEN '${group}'`));
    }
  });

  it('validates status and paging: only the three groups or all, pageSize at most 100', () => {
    const check = (q: object) => validateSync(plainToInstance(MyPartReturnsQueryDto, q)).length;
    for (const status of ['need_declare', 'awaiting_manager', 'completed', 'all']) expect(check({ status })).toBe(0);
    expect(check({})).toBe(0);
    expect(check({ status: 'exception' })).toBeGreaterThan(0);
    expect(check({ status: 'outstanding' })).toBeGreaterThan(0);
    expect(check({ status: 'completed', pageSize: '101' })).toBeGreaterThan(0);
    expect(check({ status: 'completed', page: '0' })).toBeGreaterThan(0);
    expect(plainToInstance(MyPartReturnsQueryDto, { status: 'completed' })).toMatchObject({ page: 1, pageSize: 20 });
  });

  it('answers as before without status and pages one group with status', async () => {
    const custody = { pending: vi.fn(async () => [{ id: 'open' }]), completedQty: vi.fn(async () => 17), mineByGroup: vi.fn(async () => ({ data: [], meta: {} })) };
    const controller = new PartReturnsController(custody as never);
    const req = { user: { id: 't', role: Role.TECHNICIAN } };
    expect(await controller.mine(plainToInstance(MyPartReturnsQueryDto, {}), req)).toEqual({ data: [{ id: 'open' }], meta: { completedQty: 17 } });
    expect(custody.mineByGroup).not.toHaveBeenCalled();
    await controller.mine(plainToInstance(MyPartReturnsQueryDto, { status: 'completed', page: '2', pageSize: '50' }), req);
    expect(custody.mineByGroup).toHaveBeenCalledWith(req.user, 'completed', 2, 50);
  });
});
