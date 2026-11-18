import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BookingListQueryDto } from '../../modules/bookings/dto/booking-list-query.dto';
import { OrderListQueryDto } from '../../modules/service-orders/dto/order-list-query.dto';
import { bookingStageSql, orderStageSql, replacementOrderSql } from './customer-activity-stage';

describe('customer activity stages', () => {
  it('a replacement order is accepted or en route with no active technician', () => {
    const sql = replacementOrderSql('o');
    expect(sql).toContain("o.status IN ('accepted', 'en_route')");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('ta.is_active = true');
  });

  it('repairs in progress leave out the orders that lost their technician', () => {
    const sql = orderStageSql('in_progress');
    expect(sql).toContain("'under_repair'");
    expect(sql).toContain(`NOT ${replacementOrderSql('o')}`);
    expect(orderStageSql('completed')).toBe("o.status = 'completed'");
    expect(orderStageSql('cancelled')).toBe("o.status = 'cancelled'");
  });

  it('requests without a technician are closed bookings or bookings whose order lost its technician', () => {
    const sql = bookingStageSql('no_technician');
    expect(sql).toContain("b.status = 'closed'");
    expect(sql).toContain(replacementOrderSql('ro'));
  });

  it('sent requests are still searching and never matched, and cancelled ones are separate', () => {
    expect(bookingStageSql('sent')).toContain("b.status IN ('submitted', 'matching')");
    expect(bookingStageSql('sent')).not.toContain("'matched'");
    expect(bookingStageSql('cancelled')).toContain("b.status = 'cancelled'");
  });

  it('a booking whose order was cancelled is that cancelled order, never also a cancelled or closed request', () => {
    const noOrder = 'NOT EXISTS (SELECT 1 FROM service_orders bo WHERE bo.booking_id = b.id)';
    expect(bookingStageSql('cancelled')).toBe(`(b.status = 'cancelled' AND ${noOrder})`);
    expect(bookingStageSql('no_technician')).toContain(`(b.status = 'closed' AND ${noOrder})`);
    // The replacement branch still counts a matched booking whose order lost its technician.
    expect(bookingStageSql('no_technician')).toContain(`OR EXISTS (SELECT 1 FROM service_orders ro`);
  });

  it('the list queries accept only known stages', async () => {
    expect(await validate(plainToInstance(BookingListQueryDto, { stage: 'no_technician' }))).toHaveLength(0);
    expect(await validate(plainToInstance(BookingListQueryDto, { stage: 'matched' }))).not.toHaveLength(0);
    expect(await validate(plainToInstance(OrderListQueryDto, { stage: 'in_progress' }))).toHaveLength(0);
    expect(await validate(plainToInstance(OrderListQueryDto, { stage: 'accepted' }))).not.toHaveLength(0);
  });
});

describe('active first ranking (PO 19/11)', () => {
  it('ranks waiting and running work 0, the rest 1', async () => {
    const { orderActiveRankSql, bookingActiveRankSql, visitActiveRankSql } = await import('./customer-activity-stage');
    expect(orderActiveRankSql('o')).toBe("CASE WHEN o.status IN ('accepted', 'en_route', 'under_repair') THEN 0 ELSE 1 END");
    expect(bookingActiveRankSql('b')).toBe("CASE WHEN b.status IN ('submitted', 'matching', 'closed') THEN 0 ELSE 1 END");
    const visit = visitActiveRankSql('X');
    for (const s of ['submitted', 'matching', 'no_technician', 'accepted', 'en_route', 'under_repair']) expect(visit).toContain(`'${s}'`);
    for (const s of ['completed', 'cancelled', 'mixed', 'failed']) expect(visit).not.toContain(`'${s}'`);
  });
});
