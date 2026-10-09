import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentAttemptStatus, PaymentPurpose } from '../../shared/enums';

export interface AdminPaymentQuery {
  search?: string;
  status?: string;
  purpose?: string;
  provider?: string;
  /** Vietnam calendar days, YYYY-MM-DD, both included. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

const STATUSES = Object.values(PaymentAttemptStatus) as string[];
const PURPOSES = Object.values(PaymentPurpose) as string[];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Admin: every payment attempt (PO 09/10/2026): invoices paid by VNPay or
 * the customer wallet, technician commission dues and wallet top-ups, with
 * who paid, the order behind it and the provider reference to reconcile.
 */
@Injectable()
export class AdminPaymentsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: AdminPaymentQuery) {
    const page = Math.max(1, Math.floor(Number(query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize)) || 20));
    const params: unknown[] = [];
    const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const where: string[] = [];
    if (query.status && STATUSES.includes(query.status)) where.push(`p."status"::text = ${add(query.status)}`);
    if (query.purpose && PURPOSES.includes(query.purpose)) where.push(`p."purpose"::text = ${add(query.purpose)}`);
    if (query.provider === 'none') where.push(`p."provider" IS NULL`);
    else if (query.provider) where.push(`p."provider" = ${add(query.provider.slice(0, 64))}`);
    if (query.from && DAY.test(query.from)) where.push(`p."requested_at" >= (${add(query.from)}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`);
    if (query.to && DAY.test(query.to)) where.push(`p."requested_at" < ((${add(query.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`);
    const text = query.search?.trim().slice(0, 100) ?? '';
    if (text) {
      const like = add(`%${text}%`);
      where.push(`(so."code" ILIKE ${like} OR u."email" ILIKE ${like} OR u."full_name" ILIKE ${like} OR p."provider_reference" ILIKE ${like} OR p."id"::text ILIKE ${add(`${text.toLowerCase()}%`)})`);
    }
    const from = `
      FROM "payments" p
      JOIN "users" u ON u."id" = p."requested_by_user_id"
      LEFT JOIN "invoices" i ON i."id" = p."invoice_id"
      LEFT JOIN "commission_dues" cd ON cd."id" = p."commission_due_id"
      LEFT JOIN "service_orders" so ON so."id" = COALESCE(i."service_order_id", cd."service_order_id")
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const [totals] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "total",
              COALESCE(SUM(p."amount") FILTER (WHERE p."status" = 'verified'), 0)::bigint AS "verifiedAmount",
              COUNT(*) FILTER (WHERE p."status" = 'verified')::int AS "verified",
              COUNT(*) FILTER (WHERE p."status" = 'pending')::int AS "pending",
              COUNT(*) FILTER (WHERE p."status" = 'failed')::int AS "failed"
         ${from}`,
      params,
    );
    const rows = await this.dataSource.query(
      `SELECT p."id", p."purpose", p."amount", p."currency", p."mode", p."provider", p."status",
              p."provider_reference" AS "providerReference", p."failure_code" AS "failureCode",
              p."requested_at" AS "requestedAt", p."verified_at" AS "verifiedAt", p."invoice_id" AS "invoiceId",
              u."id" AS "payerId", u."full_name" AS "payerName", u."email" AS "payerEmail", u."role" AS "payerRole",
              so."id" AS "orderId", so."code" AS "orderCode"
         ${from}
        ORDER BY p."requested_at" DESC, p."id" DESC
        LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`,
      params,
    );
    const total = Number(totals.total);
    return {
      data: rows.map((r: Record<string, unknown>) => ({ ...r, amount: Number(r.amount) })),
      meta: {
        page, limit, total, totalPages: Math.ceil(total / limit),
        summary: { verifiedAmount: Number(totals.verifiedAmount), verified: totals.verified, pending: totals.pending, failed: totals.failed },
      },
    };
  }
}
