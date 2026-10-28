import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateCashIntentDto, ReceiveCashIntentDto } from './cash-intent.dto';

describe('cash-intent transport', () => {
  it('requires UUID command and reservation identifiers', async () => {
    const dto = plainToInstance(CreateCashIntentDto, { commandId: 'not-a-uuid', voucherReservationId: 'bad' });
    expect(await validate(dto)).toHaveLength(2);
  });

  it('rejects fractional or missing physical receipt amounts', async () => {
    const valid = '7de9bf22-54ed-4a7f-af84-641706aac559';
    const fractional = plainToInstance(ReceiveCashIntentDto, { intentId: valid, commandId: valid, receivedAmountVnd: 12.5 });
    const missing = plainToInstance(ReceiveCashIntentDto, { intentId: valid, commandId: valid });
    expect(await validate(fractional)).not.toHaveLength(0);
    expect(await validate(missing)).not.toHaveLength(0);
  });
});
