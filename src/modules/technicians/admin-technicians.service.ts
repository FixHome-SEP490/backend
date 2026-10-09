import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

const UUID_PREFIX = /^[0-9a-f-]{6,36}$/i;
// Vietnamese letters without their marks, so "Nguyen" finds "Nguyễn" (same map in SQL translate()).
export const VN_FROM = 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ';
export const VN_TO = 'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd';

/** Lower case without Vietnamese diacritics. */
export function foldVietnamese(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const i = VN_FROM.indexOf(ch);
    out += i >= 0 ? VN_TO[i] : ch;
  }
  return out;
}

/** Digits of a phone number as stored and as typed: 0912..., +84 912..., 84912... */
export function phoneDigitsVariants(search: string): string[] {
  const digits = search.replace(/\D/g, '');
  if (digits.length < 3) return [];
  const variants = new Set([digits]);
  if (digits.startsWith('84') && digits.length >= 10) variants.add('0' + digits.slice(2));
  if (digits.startsWith('0') && digits.length >= 9) variants.add('84' + digits.slice(1));
  return [...variants];
}

/**
 * Admin look-up of technicians (PO 08/10/2026): by name, email, phone, citizen
 * id (CCCD) or id, never by address; and everything known about one of them.
 */
@Injectable()
export class AdminTechniciansService {
  constructor(private readonly dataSource: DataSource) {}

  async search(query: { search?: string; verificationStatus?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, Math.floor(Number(query.page)) || 1);
    const limit = Math.min(100, Math.max(1, Math.floor(Number(query.pageSize)) || 20));
    const where: string[] = [`u."role" = 'technician'`];
    const params: unknown[] = [];
    const add = (value: unknown) => { params.push(value); return `$${params.length}`; };
    const text = query.search?.trim().slice(0, 100) ?? '';
    if (text) {
      const like = add(`%${text}%`);
      const folded = add(`%${foldVietnamese(text)}%`);
      const any: string[] = [
        `translate(lower(u."full_name"), '${VN_FROM}', '${VN_TO}') LIKE ${folded}`,
        `u."email" ILIKE ${like}`,
      ];
      for (const digits of phoneDigitsVariants(text)) {
        any.push(`regexp_replace(COALESCE(u."phone_number", ''), '\\D', '', 'g') LIKE ${add(`%${digits}%`)}`);
      }
      const cccd = text.replace(/\D/g, '');
      if (cccd.length >= 3) any.push(`u."citizen_id_number" LIKE ${add(`${cccd}%`)}`);
      if (UUID_PREFIX.test(text)) {
        const prefix = add(`${text.toLowerCase()}%`);
        any.push(`u."id"::text LIKE ${prefix}`, `tp."id"::text LIKE ${prefix}`);
      }
      where.push(`(${any.join(' OR ')})`);
    }
    if (query.verificationStatus) where.push(`tp."verification_status"::text = ${add(query.verificationStatus)}`);
    const from = `FROM "users" u LEFT JOIN "technician_profiles" tp ON tp."user_id" = u."id" WHERE ${where.join(' AND ')}`;
    const [{ total }] = await this.dataSource.query(`SELECT COUNT(*)::int AS total ${from}`, params);
    const rows = await this.dataSource.query(
      `SELECT u."id", tp."id" AS "profileId", u."full_name" AS "fullName", u."email", u."phone_number" AS "phoneNumber",
              u."citizen_id_number" AS "citizenIdNumber", u."status", u."reputation_points" AS "reputationPoints",
              tp."verification_status" AS "verificationStatus", tp."is_available" AS "isAvailable",
              tp."average_rating" AS "averageRating", tp."rating_count" AS "ratingCount",
              tp."work_suspended_until" AS "workSuspendedUntil", u."created_at" AS "createdAt"
         ${from}
        ORDER BY u."full_name" ASC, u."id" ASC
        LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`,
      params,
    );
    return {
      data: rows.map((r: Record<string, unknown>) => ({
        ...r,
        reputationPoints: Number(r.reputationPoints),
        averageRating: r.ratingCount ? Number(r.averageRating) : null,
        ratingCount: Number(r.ratingCount ?? 0),
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Everything about one technician for the admin: account, profile, skills, areas, schedule, money, record. */
  async detail(userId: string) {
    const q = (sql: string, params: unknown[] = [userId]) => this.dataSource.query(sql, params);
    const [user] = await q(
      `SELECT u."id", u."full_name" AS "fullName", u."email", u."phone_number" AS "phoneNumber", u."citizen_id_number" AS "citizenIdNumber",
              u."date_of_birth" AS "dateOfBirth", u."gender", u."avatar_url" AS "avatarUrl", u."status", u."is_email_verified" AS "emailVerified",
              u."auth_provider" AS "authProvider", u."reputation_points" AS "reputationPoints", u."created_at" AS "createdAt"
         FROM "users" u WHERE u."id" = $1 AND u."role" = 'technician'`,
    );
    if (!user) throw new NotFoundException('Không tìm thấy kỹ thuật viên');
    const [profile] = await q(
      `SELECT tp."id", tp."verification_status" AS "verificationStatus", tp."years_experience" AS "yearsExperience", tp."bio",
              tp."average_rating" AS "averageRating", tp."rating_count" AS "ratingCount", tp."reliability_score" AS "reliabilityScore",
              tp."is_available" AS "isAvailable", tp."service_radius_km" AS "serviceRadiusKm", tp."full_address" AS "fullAddress",
              tp."work_suspended_until" AS "workSuspendedUntil", tp."priority_boost_until" AS "priorityBoostUntil",
              tp."last_location_at" AS "lastLocationAt", tp."onboarding_step" AS "onboardingStep"
         FROM "technician_profiles" tp WHERE tp."user_id" = $1`,
    );
    const profileId = profile?.id ?? null;
    const byProfile = (sql: string) => (profileId ? q(sql, [profileId]) : Promise.resolve([]));
    const [skills, areas, schedule, timeOff, wallet, orders, statusCounts, verification, reputation] = await Promise.all([
      byProfile(`SELECT s."name" AS "serviceName", ts."listed_labor_price" AS "listedLaborPrice", ts."verification_status" AS "verificationStatus", ts."is_active" AS "isActive"
                   FROM "technician_skills" ts JOIN "services" s ON s."id" = ts."service_id" WHERE ts."technician_id" = $1 ORDER BY s."name"`),
      byProfile(`SELECT "province_code" AS "provinceCode", "district_code" AS "districtCode" FROM "technician_service_areas" WHERE "technician_id" = $1`),
      byProfile(`SELECT "day_of_week" AS "dayOfWeek", "start_time" AS "startTime", "end_time" AS "endTime" FROM "technician_schedules" WHERE "technician_id" = $1 ORDER BY "day_of_week", "start_time"`),
      byProfile(`SELECT "start_at" AS "startAt", "end_at" AS "endAt" FROM "technician_time_off" WHERE "technician_id" = $1 AND "end_at" > now() ORDER BY "start_at" LIMIT 20`),
      q(`SELECT "balance" FROM "wallets" WHERE "technician_id" = $1`),
      q(`SELECT o."id", o."code", o."status", o."grand_total" AS "grandTotal", o."created_at" AS "createdAt"
           FROM "service_orders" o JOIN "technician_assignments" a ON a."service_order_id" = o."id" AND a."is_active"
          WHERE a."technician_id" = $1 ORDER BY o."created_at" DESC LIMIT 10`),
      q(`SELECT o."status", COUNT(*)::int AS n FROM "service_orders" o JOIN "technician_assignments" a ON a."service_order_id" = o."id" AND a."is_active"
          WHERE a."technician_id" = $1 GROUP BY o."status"`),
      q(`SELECT "status", "submitted_at" AS "submittedAt", "reviewed_at" AS "reviewedAt", "rejection_reason" AS "rejectionReason"
           FROM "technician_verifications" WHERE "technician_id" = $1 ORDER BY "submitted_at" DESC LIMIT 1`),
      q(`SELECT "kind", "delta", "points_after" AS "pointsAfter", "reason", "created_at" AS "createdAt" FROM "reputation_events" WHERE "user_id" = $1 ORDER BY "created_at" DESC LIMIT 10`),
    ]);
    return {
      user: { ...user, reputationPoints: Number(user.reputationPoints) },
      profile: profile
        ? { ...profile, averageRating: profile.ratingCount ? Number(profile.averageRating) : null, serviceRadiusKm: Number(profile.serviceRadiusKm) }
        : null,
      skills: skills.map((s: Record<string, unknown>) => ({ ...s, listedLaborPrice: s.listedLaborPrice == null ? null : Number(s.listedLaborPrice) })),
      serviceAreas: areas,
      schedule,
      upcomingTimeOff: timeOff,
      walletBalance: wallet[0] ? Number(wallet[0].balance) : null,
      orderCounts: Object.fromEntries(statusCounts.map((r: { status: string; n: number }) => [r.status, Number(r.n)])),
      recentOrders: orders.map((o: Record<string, unknown>) => ({ ...o, grandTotal: Number(o.grandTotal ?? 0) })),
      verification: verification[0] ?? null,
      reputationEvents: reputation,
    };
  }
}
