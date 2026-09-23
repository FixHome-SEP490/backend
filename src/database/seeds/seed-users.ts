// src/database/seeds/seed-users.ts
// Seeds demo accounts per P12.3:
// 1 Admin, 2 SM, 12 Technicians (with profiles, areas, schedules), 8 Customers (1 suspended)
import { DataSource, QueryRunner } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Role, AccountStatus, VerificationStatus } from '../../shared/enums';

// Upsert-by-email never guarantees the hardcoded id below actually wins — an
// older seed generation may have created the row under a different id.
// Always resolve the row's ACTUAL id via email afterward and use that for
// every downstream FK-dependent insert, or those inserts break with a
// foreign-key violation against a hardcoded id that was never really written.
async function upsertUserByEmail(
  qr: QueryRunner,
  fallbackId: string,
  email: string,
  passwordHash: string,
  fullName: string,
  phone: string,
  role: Role,
  status: AccountStatus,
  suspendedUntil: Date | null = null,
): Promise<string> {
  await qr.query(
    `INSERT INTO "users" ("id", "email", "password_hash", "full_name", "phone_number", "role", "status", "is_active", "booking_suspended_until")
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
     ON CONFLICT ("email") DO UPDATE SET "password_hash" = EXCLUDED."password_hash"`,
    [fallbackId, email, passwordHash, fullName, phone, role, status, suspendedUntil],
  );
  const [{ id }] = await qr.query(`SELECT "id" FROM "users" WHERE "email" = $1`, [email]);
  return id as string;
}

export async function seedUsers(dataSource: DataSource): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.query(`DELETE FROM "technician_service_areas" WHERE "province_code" = '79'`);

  console.log('👤 Seeding demo user accounts per P12.3...');

  const passwordHash = await bcrypt.hash('Password123!', 12);

  // 1. Admin
  await upsertUserByEmail(
    queryRunner, 'a0000000-0000-4000-8000-000000000001', 'admin@fixhome.vn',
    passwordHash, 'Admin FixHome', '0901000001', Role.ADMIN, AccountStatus.ACTIVE,
  );

  // 2. Service Managers
  const smAccounts = [
    {
      id: 'b0000000-0000-4000-8000-000000000001',
      email: 'sm.hcm@fixhome.vn',
      fullName: 'Quan Ly HCM',
      phone: '0902000001',
      scopeType: 'GLOBAL',
      provinceCodes: null,
    },
    {
      id: 'b0000000-0000-4000-8000-000000000002',
      email: 'sm.hn@fixhome.vn',
      fullName: 'Quan Ly Ha Noi',
      phone: '0902000002',
      scopeType: 'REGIONAL',
      provinceCodes: ['01'], // Hanoi code
    },
  ];

  for (const sm of smAccounts) {
    const smId = await upsertUserByEmail(
      queryRunner, sm.id, sm.email, passwordHash, sm.fullName, sm.phone,
      Role.SERVICE_MANAGER, AccountStatus.ACTIVE,
    );

    await queryRunner.query(
      `INSERT INTO "user_scopes" ("user_id", "scope_type", "scope_province_codes")
       VALUES ($1, $2, $3)
       ON CONFLICT ("user_id") DO UPDATE SET "scope_type" = EXCLUDED."scope_type"`,
      [smId, sm.scopeType, sm.provinceCodes],
    );
  }

  // 3. Technicians (12 accounts)
  for (let i = 1; i <= 12; i++) {
    const techId = await upsertUserByEmail(
      queryRunner,
      `c0000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
      `tech${i}@fixhome.vn`,
      passwordHash,
      `Tho Dien Lanh ${i}`,
      `0903${i.toString().padStart(6, '0')}`,
      Role.TECHNICIAN,
      AccountStatus.ACTIVE,
    );
    const rating = (4.5 + (i % 6) * 0.1).toFixed(2);

    await queryRunner.query(
      `INSERT INTO "technician_profiles" ("id", "user_id", "verification_status", "years_experience", "bio", "average_rating", "rating_count", "reliability_score", "is_available")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100, true)
       ON CONFLICT ("user_id") DO UPDATE SET "average_rating" = EXCLUDED."average_rating"`,
      [
        `c1000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
        techId,
        VerificationStatus.VERIFIED,
        3 + (i % 10),
        `Kỹ thuật viên chuyên nghiệp với hơn ${3 + (i % 10)} năm kinh nghiệm sửa chữa điện lạnh, điện nước gia đình.`,
        rating,
        15 + i * 4,
      ],
    );
    const [{ id: profileId }] = await queryRunner.query(
      `SELECT "id" FROM "technician_profiles" WHERE "user_id" = $1`, [techId],
    );

    // Schedule: Mon to Sat (1..6), 08:00 - 18:00
    for (let day = 1; day <= 6; day++) {
      await queryRunner.query(
        `INSERT INTO "technician_schedules" ("technician_id", "day_of_week", "start_time", "end_time")
         VALUES ($1, $2, '08:00', '18:00')
         ON CONFLICT ("technician_id", "day_of_week") DO NOTHING`,
        [profileId, day],
      );
    }

    // Service Areas: real HCM wards post-2025 reform (province 79 now also covers
    // old Bình Dương + Bà Rịa-Vũng Tàu). 26743=P.Bến Thành (old Q1), 27073=P.Phú Nhuận,
    // 26884=P.Gò Vấp, 26929=P.Bình Thạnh, 27004=P.Tân Bình, 26824=P.Thủ Đức,
    // 25951=P.Đông Hoà (old Dĩ An, Bình Dương), 25942=P.Dĩ An, 26506=P.Vũng Tàu.
    const hcmWards = ['26743', '27073', '26884', '26929', '27004', '26824', '25951', '25942', '26506'];
    // Give each tech their primary ward and central ward 26743 (P.Bến Thành) so customer testing always has matching candidates
    const assignedDistricts = new Set(['26743', hcmWards[i % hcmWards.length], hcmWards[(i + 1) % hcmWards.length]]);
    for (const distCode of assignedDistricts) {
      await queryRunner.query(
        `INSERT INTO "technician_service_areas" ("technician_id", "province_code", "district_code")
         VALUES ($1, '79', $2)
         ON CONFLICT DO NOTHING`,
        [profileId, distCode],
      );
    }
  }

  // 4. Customers (8 accounts, 1 suspended)
  const suspendUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

  for (let i = 1; i <= 8; i++) {
    const email = i === 8 ? 'customer.suspended@fixhome.vn' : `customer${i}@fixhome.vn`;
    const name = i === 8 ? 'Khach Hang Bi Khoa' : `Khach Hang ${i}`;
    const status = i === 8 ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE;

    const custId = await upsertUserByEmail(
      queryRunner,
      `d0000000-0000-4000-8000-${i.toString().padStart(12, '0')}`,
      email,
      passwordHash,
      name,
      `0904${i.toString().padStart(6, '0')}`,
      Role.CUSTOMER,
      status,
      i === 8 ? suspendUntil : null,
    );

    // Default address for each customer
    await queryRunner.query(
      `INSERT INTO "addresses" ("user_id", "label", "line1", "ward", "district", "province", "lat", "lng", "is_default")
       VALUES ($1, 'Nhà riêng', $2, 'Phường Bến Thành', 'Quận 1', 'TP. Hồ Chí Minh', 10.7769, 106.7009, true)
       ON CONFLICT ("user_id") WHERE "is_default" DO NOTHING`,
      [custId, `${100 + i} Lê Thánh Tôn`],
    );
  }

  await queryRunner.release();
  console.log('✅ Seeded: 1 Admin, 2 SMs, 12 Technicians (with profiles & schedules), 8 Customers (1 suspended)');
}
