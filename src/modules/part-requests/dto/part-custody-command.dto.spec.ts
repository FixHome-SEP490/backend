import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { PartCustodyCommandDto } from './part-custody-command.dto';

const common = {
  partRequestId: 'da8b3cc7-147d-48fd-a4ce-91699524a4c7',
  partRequestItemId: '1e27cb29-7150-423e-9430-c02d8b04f33e',
  expectedVersion: 0,
  idempotencyKey: 'custody-key-0001',
};

describe('PartCustodyCommandDto', () => {
  it.each([
    { kind: 'record_usage', usedQty: 2, quantity: 1 },
    { kind: 'declare_return', quantity: 1, usedQty: 2 },
    { kind: 'accept_return', quantity: 1, observedQty: 0 },
    { kind: 'report_discrepancy', declaredQty: 1, observedQty: 0, quantity: 1 },
  ])('rejects fields belonging to another command: %o', async (fields) => {
    expect(await validate(plainToInstance(PartCustodyCommandDto, { ...common, ...fields }))).not.toHaveLength(0);
  });
  it('accepts bounded positive return counts and a zero discrepancy observation', async () => {
    const declaration = plainToInstance(PartCustodyCommandDto, {
      ...common,
      kind: 'declare_return',
      quantity: 3,
    });
    const discrepancy = plainToInstance(PartCustodyCommandDto, {
      ...common,
      kind: 'report_discrepancy',
      declaredQty: 1,
      observedQty: 0,
      evidenceReferenceId: 'da8b3cc7-147d-48fd-a4ce-91699524a4c7',
    });

    expect(await validate(declaration)).toHaveLength(0);
    expect(await validate(discrepancy)).toHaveLength(0);
  });

  it.each([
    { kind: 'declare_return', quantity: 0 },
    { kind: 'accept_return', quantity: 101 },
    { kind: 'record_usage', usedQty: 1.5 },
    { kind: 'report_discrepancy', declaredQty: 1, observedQty: -1 },
  ])('rejects invalid count bounds for %o', async (fields) => {
    const dto = plainToInstance(PartCustodyCommandDto, { ...common, ...fields });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('rejects invalid idempotency keys, versions, and evidence references', async () => {
    const dto = plainToInstance(PartCustodyCommandDto, {
      ...common,
      kind: 'declare_return',
      quantity: 1,
      expectedVersion: -1,
      idempotencyKey: 'key contains spaces',
      partRequestId: '../request',
      evidenceReferenceId: 'sensitive/path?token=abc',
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('sanitizes reason text before it can be used by the domain', () => {
    const dto = plainToInstance(PartCustodyCommandDto, {
      ...common,
      kind: 'report_discrepancy',
      declaredQty: 1,
      observedQty: 0,
      reason: '  <b>Không nhận được</b>\u0000 email: name@example.com gọi 0912345678 https://example.com  ',
    });

    expect(dto.reason).toBe('Không nhận được email: [đã ẩn] gọi [đã ẩn] [đã ẩn]');
  });

  it('rejects reason text longer than the command bound after sanitization', async () => {
    const dto = plainToInstance(PartCustodyCommandDto, {
      ...common,
      kind: 'report_discrepancy',
      declaredQty: 1,
      observedQty: 0,
      reason: 'x'.repeat(301),
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
