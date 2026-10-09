import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { foldVietnamese, VN_FROM, VN_TO } from '../technicians/admin-technicians.service';

export interface AdminReviewQuery {
  search?: string;
  /** Exact number of stars, 1 to 5. */
  rating?: number;
  /** Only reviews of this many stars or fewer, e.g. 2 for the poor ones. */
  maxRating?: number;
  /** Vietnam calendar days, YYYY-MM-DD, both included. */
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const stars = (value: unknown) => {
  const n = Math.floor(Number(value));
  return n >= 1 && n <= 5 ? n : null;
};

/**
 * Admin: every customer review (PO 09/10/2026), read only: who rated whom on
 * which order, filtered by stars and days, with the average and the spread
 * of stars for the same filter.
 */
@Injectable()
export class AdminReviewsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(query: AdminReviewQuery) {
    const page = Math.max(1, Math.floor(Number(query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize)) || 20));
    const params: unknown[] = [];
    const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const where: string[] = [];
    const exact = stars(query.rating);
    const max = stars(query.maxRating);
    if (exact) where.push(`r."rating" = ${add(exact)}`);
    if (max) where.push(`r."rating" <= ${add(max)}`);
    if (query.from && DAY.test(query.from)) where.push(`r."created_at" >= (${add(query.from)}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`);
    if (query.to && DAY.test(query.to)) where.push(`r."created_at" < ((${add(query.to)}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`);
    const text = query.search?.trim().slice(0, 100) ?? '';
    if (text) {
      const like = add(`%${text}%`);
      const folded = add(`%${foldVietnamese(text)}%`);
      const name = (alias: string) => `translate(lower(${alias}."full_name"), '${VN_FROM}', '${VN_TO}') LIKE ${folded}`;
      where.push(`(${name('t')} OR ${name('c')} OR t."email" ILIKE ${like} OR c."email" ILIKE ${like} OR so."code" ILIKE ${like} OR r."comment" ILIKE ${like})`);
    }
    const from = `
      FROM "reviews" r
      JOIN "users" t ON t."id" = r."technician_id"
      JOIN "users" c ON c."id" = r."customer_id"
      LEFT JOIN "service_orders" so ON so."id" = r."service_order_id"
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
    const [totals] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS "total", ROUND(AVG(r."rating")::numeric, 2) AS "average",
              COUNT(*) FILTER (WHERE r."rating" = 1)::int AS "s1", COUNT(*) FILTER (WHERE r."rating" = 2)::int AS "s2",
              COUNT(*) FILTER (WHERE r."rating" = 3)::int AS "s3", COUNT(*) FILTER (WHERE r."rating" = 4)::int AS "s4",
              COUNT(*) FILTER (WHERE r."rating" = 5)::int AS "s5"
         ${from}`,
      params,
    );
    const rows = await this.dataSource.query(
      `SELECT r."id", r."rating", r."comment", r."created_at" AS "createdAt",
              so."id" AS "orderId", so."code" AS "orderCode",
              t."id" AS "technicianId", t."full_name" AS "technicianName", t."email" AS "technicianEmail",
              c."id" AS "customerId", c."full_name" AS "customerName", c."email" AS "customerEmail"
         ${from}
        ORDER BY r."created_at" DESC, r."id" DESC
        LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`,
      params,
    );
    const total = Number(totals.total);
    return {
      data: rows.map((r: Record<string, unknown>) => ({ ...r, rating: Number(r.rating) })),
      meta: {
        page, limit, total, totalPages: Math.ceil(total / limit),
        summary: {
          average: totals.average === null ? null : Number(totals.average),
          stars: { 1: totals.s1, 2: totals.s2, 3: totals.s3, 4: totals.s4, 5: totals.s5 },
        },
      },
    };
  }
}
