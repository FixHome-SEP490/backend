import 'reflect-metadata';
import { randomInt, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as bcrypt from 'bcrypt';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { User } from '../../modules/users/entities/user.entity';
import { Address } from '../../modules/users/entities/address.entity';
import {
  TechnicianProfile,
  TechnicianSkill,
  TechnicianSchedule,
  TechnicianServiceArea,
  TechnicianSkillVerification,
} from '../../modules/technicians/entities';
import { TechnicianVerification } from '../../modules/technician-verifications/entities/technician-verification.entity';
import { VerificationDocument } from '../../modules/technician-verifications/entities/verification-document.entity';
import { KycStorageService } from '../../modules/technician-verifications/kyc-storage.service';
import { Wallet } from '../../modules/wallet/entities/wallet.entity';
import { WalletTransaction } from '../../modules/wallet/entities/wallet-transaction.entity';
import { AuditLog } from '../../modules/audit-log/entities/audit-log.entity';
import { Booking } from '../../modules/bookings/entities/booking.entity';
import { technicianEligibility } from '../../modules/bookings/technician-eligibility';
import {
  AccountStatus,
  AuthProvider,
  DocumentType,
  Gender,
  OnboardingStatus,
  Role,
  ServicePricingMode,
  VerificationStatus,
  WalletTransactionType,
} from '../../shared/enums';

export const BATCH_ID = 'technicians-hcm-20261002-30';
export const COUNT = 30;
const BALANCE = 200000;

export interface TechnicianRange {
  from: number;
  to: number;
}

export function missingSequences(
  emails: string[],
  range: TechnicianRange,
): number[] {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 1 ||
    range.to < range.from ||
    range.to > 1000 ||
    range.to - range.from >= 500
  ) {
    throw new Error(
      'Expected an ascending range within 1..1000, at most 500 accounts',
    );
  }
  const occupied = new Set(emails.map((email) => email.toLowerCase()));
  return Array.from(
    { length: range.to - range.from + 1 },
    (_, index) => range.from + index,
  ).filter((number) => !occupied.has(`tech${number}@fixhome.vn`));
}

function rangeBatchId(range?: TechnicianRange): string {
  if (!range) return BATCH_ID;
  missingSequences([], range);
  return `technicians-hcm-range-${range.from}-${range.to}`;
}

// Synthetic GPS points for distance testing, not surveyed residential addresses.
// Ward codes/names are resolved against the current database, never inserted here.
export const LOCATIONS = [
  ['Bến Thành', 10.7725, 106.6954],
  ['Thủ Đức', 10.8506, 106.7539],
  ['Tân Mỹ', 10.729, 106.7175],
  ['Gò Vấp', 10.827, 106.6845],
  ['An Lạc', 10.73, 106.613],
  ['Tân Định', 10.7903, 106.689],
  ['Hiệp Bình', 10.839, 106.7205],
  ['Tân Hưng', 10.741, 106.7],
  ['Tân Sơn Hoà', 10.8, 106.6655],
  ['Bình Trị Đông', 10.756, 106.61],
  ['Sài Gòn', 10.7795, 106.705],
  ['Linh Xuân', 10.879, 106.762],
  ['Tân Thuận', 10.75, 106.727],
  ['Tân Sơn Nhất', 10.803, 106.65],
  ['Phú Lâm', 10.752, 106.632],
  ['Cầu Ông Lãnh', 10.763, 106.693],
  ['An Khánh', 10.797, 106.733],
  ['Phú Thuận', 10.73, 106.741],
  ['Phú Nhuận', 10.799, 106.681],
  ['Bình Phú', 10.742, 106.631],
  ['Xuân Hoà', 10.785, 106.688],
  ['Bình Trưng', 10.781, 106.77],
  ['Khánh Hội', 10.757, 106.701],
  ['Bảy Hiền', 10.793, 106.651],
  ['Chợ Lớn', 10.751, 106.655],
  ['Bàn Cờ', 10.77, 106.679],
  ['Phước Long', 10.823, 106.775],
  ['Vĩnh Hội', 10.758, 106.692],
  ['Bình Thạnh', 10.811, 106.704],
  ['An Đông', 10.756, 106.669],
] as const;

interface CatalogRow {
  id: string;
  name: string;
  category_id: string;
  category_name: string;
  category_code: string;
  pricing_mode: ServicePricingMode;
  base_price: string | null;
}
interface AreaRow {
  province_code: string;
  province_name: string;
  district_code: string;
  district_name: string;
}

export function nextSequence(emails: string[]): number {
  let maximum = 0;
  for (const email of emails) {
    const match = /^tech([0-9]+)@fixhome\.vn$/i.exec(email);
    if (!match) continue;
    const number = Number(match[1]);
    if (
      !Number.isSafeInteger(number) ||
      number > Number.MAX_SAFE_INTEGER - COUNT
    ) {
      throw new Error('Technician sequence exceeds the safe integer range');
    }
    maximum = Math.max(maximum, number);
  }
  return maximum + 1;
}

export function allocateCategories(
  categoryIds: string[],
  count = COUNT,
): string[] {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !categoryIds.length ||
    categoryIds.length > count
  ) {
    throw new Error(
      'Expected at least one technician for each active category',
    );
  }
  // Rotate each wave so a trade does not stay clustered in one side of HCM.
  return Array.from(
    { length: count },
    (_, index) =>
      categoryIds[
        (index + Math.floor(index / categoryIds.length)) % categoryIds.length
      ],
  );
}

async function preflight(manager: EntityManager, range?: TechnicianRange) {
  const existing = await manager.query('SELECT email, role FROM users');
  const start = nextSequence(
    existing.map((row: { email: string }) => row.email),
  );
  const sequences = range
    ? missingSequences(
        existing.map((row) => row.email),
        range,
      )
    : Array.from({ length: COUNT }, (_, index) => start + index);
  if (
    range &&
    existing.some((row) => {
      const match = /^tech([0-9]+)@fixhome\.vn$/i.exec(row.email);
      return (
        match &&
        Number(match[1]) >= range.from &&
        Number(match[1]) <= range.to &&
        row.role !== Role.TECHNICIAN
      );
    })
  )
    throw new Error(
      'Requested range contains an account with a different role',
    );
  if (!sequences.length) return { start, sequences };
  const services: CatalogRow[] = await manager.query(`
    SELECT s.id, s.name, s.category_id, c.name category_name, c.code category_code,
           s.pricing_mode, s.base_price
    FROM services s JOIN service_categories c ON c.id=s.category_id
    WHERE s.is_active AND c.is_active ORDER BY c.code, s.code`);
  const categories = [
    ...new Set(services.map((service) => service.category_id)),
  ];
  const allocation = allocateCategories(categories, sequences.length);
  const areas: AreaRow[] = await manager.query(
    `SELECT * FROM service_areas WHERE province_code='79' AND is_active`,
  );
  const occupiedLocations = new Set(
    (
      await manager.query(
        'SELECT lat,lng FROM addresses WHERE lat IS NOT NULL AND lng IS NOT NULL',
      )
    ).map(
      (row) => `${Number(row.lat).toFixed(7)},${Number(row.lng).toFixed(7)}`,
    ),
  );
  const locations = sequences.map((sequence, index) => {
    const [name, baseLatitude, baseLongitude] =
      LOCATIONS[index % LOCATIONS.length];
    let offset = range
      ? (Math.floor(sequence / LOCATIONS.length) + 1) * 0.0002
      : 0;
    let latitude: number;
    let longitude: number;
    let key: string;
    do {
      latitude = Number((baseLatitude + offset).toFixed(7));
      longitude = Number((baseLongitude + offset).toFixed(7));
      key = `${latitude.toFixed(7)},${longitude.toFixed(7)}`;
      offset += 0.00001;
      if (offset > 0.005)
        throw new Error('Cannot allocate a distinct GPS point near this ward');
    } while (occupiedLocations.has(key));
    occupiedLocations.add(key);
    const area = areas.find((row) => row.district_name === `Phường ${name}`);
    if (!area) throw new Error(`Active HCM ward missing: ${name}`);
    return { ...area, latitude, longitude };
  });
  const admin = await manager.findOne(User, {
    where: { role: Role.ADMIN, status: AccountStatus.ACTIVE, isActive: true },
    order: { createdAt: 'ASC' },
  });
  if (!admin) throw new Error('An active Admin is required');
  const [config] = await manager.query(
    `SELECT value FROM system_configs WHERE key='wallet.minimum_balance'`,
  );
  const minimum = Number(config?.value ?? BALANCE);
  if (!Number.isFinite(minimum) || minimum > BALANCE)
    throw new Error('200000 VND does not meet the current wallet minimum');
  return {
    start,
    sequences,
    services,
    categories,
    allocation,
    locations,
    admin,
  };
}

const TRACKED_TABLES = [
  'users',
  'addresses',
  'technician_profiles',
  'technician_skills',
  'technician_schedules',
  'technician_service_areas',
  'technician_verifications',
  'technician_skill_verifications',
  'verification_documents',
  'wallets',
  'wallet_transactions',
  'audit_logs',
] as const;

async function snapshot(manager: EntityManager) {
  const result: Record<string, Array<{ id: string; digest: string }>> = {};
  for (const table of TRACKED_TABLES) {
    result[table] = await manager.query(
      `SELECT id, md5(row_to_json(t)::text) digest FROM "${table}" t ORDER BY id`,
    );
  }
  return result;
}

async function verifyOldRows(
  manager: EntityManager,
  before: Awaited<ReturnType<typeof snapshot>>,
) {
  for (const table of TRACKED_TABLES) {
    const rows = before[table];
    const after = await manager.query(
      `SELECT id, md5(row_to_json(t)::text) digest FROM "${table}" t WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [rows.map((row) => row.id)],
    );
    if (JSON.stringify(rows) !== JSON.stringify(after))
      throw new Error(`Existing data changed in ${table}`);
  }
}

export async function verifyBatch(manager: EntityManager, batchId = BATCH_ID) {
  const batch = await manager.findOneBy(AuditLog, {
    action: 'TEST_TECHNICIANS_SEEDED',
    resourceId: batchId,
  });
  if (!batch) throw new Error('Batch has not been applied');
  const ids = batch.after.userIds as string[];
  const count = Number(batch.after.count);
  if (!Number.isInteger(count) || count < 1)
    throw new Error('Invalid batch count');
  const expectedServices = batch.after.serviceIds as string[];
  const rows = await manager.query(
    `
    SELECT u.id,u.email,u.full_name,p.id profile_id,p.latitude,p.longitude,a.district_code,a.ward,
      w.balance,p.service_radius_km,
      (SELECT count(*)::int FROM technician_schedules sch WHERE sch.technician_id=p.id AND sch.start_time='07:00' AND sch.end_time='22:00') schedule_count,
      (SELECT count(*)::int FROM verification_documents d WHERE d.verification_id=v.id AND d.storage_object_path IS NOT NULL) kyc_documents,
      (SELECT count(*)::int FROM wallet_transactions tx WHERE tx.wallet_id=w.id AND tx.type='ADJUSTMENT' AND tx.amount=200000 AND tx.balance_before=0 AND tx.balance_after=200000) credits
    FROM users u JOIN technician_profiles p ON p.user_id=u.id
    JOIN addresses a ON a.user_id=u.id AND a.is_default
    JOIN wallets w ON w.technician_id=u.id
    JOIN technician_verifications v ON v.technician_id=u.id
    JOIN users reviewer ON reviewer.id=v.reviewed_by AND reviewer.role='admin'
    JOIN service_areas area ON area.province_code=a.province_code AND area.district_code=a.district_code AND area.is_active
    WHERE u.id=ANY($1::uuid[]) AND u.role='technician' AND u.status='active' AND u.is_active AND u.is_email_verified
      AND u.date_of_birth IS NOT NULL AND u.gender IS NOT NULL AND u.citizen_id_number IS NOT NULL
      AND p.verification_status='verified' AND p.onboarding_status='approved' AND p.onboarding_step=5 AND p.is_available
      AND v.status='verified' AND v.reviewed_at IS NOT NULL AND v.verified_full_name=u.full_name
      AND p.latitude=a.lat AND p.longitude=a.lng AND a.province_code='79'
      AND p.latitude BETWEEN 10.70 AND 10.90 AND p.longitude BETWEEN 106.60 AND 106.80
      AND EXISTS (SELECT 1 FROM technician_service_areas ta WHERE ta.technician_id=p.id AND ta.province_code=a.province_code AND ta.district_code=a.district_code)
    ORDER BY substring(u.email from '^tech([0-9]+)')::int`,
    [ids],
  );
  if (
    ids.length !== count ||
    rows.length !== count ||
    new Set(rows.map((row) => row.email)).size !== count
  )
    throw new Error(`Expected exactly ${count} complete accounts`);
  if (
    rows.some(
      (row) =>
        Number(row.balance) !== BALANCE ||
        row.schedule_count !== 7 ||
        row.kyc_documents !== 3 ||
        row.credits !== 1,
    )
  )
    throw new Error('Wallet, schedule or KYC mismatch');
  if (
    new Set(rows.map((row) => row.district_code)).size !==
      Math.min(count, LOCATIONS.length) ||
    new Set(rows.map((row) => `${row.latitude},${row.longitude}`)).size !==
      count
  )
    throw new Error('Unexpected ward coverage or duplicate GPS points');
  const duplicates = await manager.query(
    `SELECT lower(email) FROM users WHERE lower(email)=ANY($1::text[]) GROUP BY lower(email) HAVING count(*)>1`,
    [rows.map((row) => row.email)],
  );
  if (duplicates.length) throw new Error('Duplicate email');
  const skills = await manager.query(
    `
    SELECT sk.id,sk.technician_id,sk.service_id,c.name category_name,
      (sk.is_active AND sk.verification_status='verified' AND sv.status='verified'
       AND sv.reviewed_at IS NOT NULL AND reviewer.role='admin' AND d.id IS NOT NULL) approved
    FROM technician_skills sk JOIN technician_profiles p ON p.id=sk.technician_id
    JOIN services s ON s.id=sk.service_id JOIN service_categories c ON c.id=s.category_id
    LEFT JOIN technician_skill_verifications sv ON sv.technician_skill_id=sk.id
    LEFT JOIN users reviewer ON reviewer.id=sv.reviewed_by
    LEFT JOIN verification_documents d ON d.skill_verification_id=sv.id AND d.document_type='certificate' AND d.issued_by=sv.reviewed_by
    WHERE p.user_id=ANY($1::uuid[])`,
    [ids],
  );
  if (
    skills.some((skill) => !skill.approved) ||
    expectedServices.some(
      (id) => !skills.some((skill) => skill.service_id === id),
    )
  )
    throw new Error('Missing approved service coverage');
  // Exercise the actual matching business logic without persisting bookings.
  const tomorrow = new Date(Date.now() + 86400000);
  const vnDay = new Date(tomorrow.getTime() + 7 * 3600000)
    .toISOString()
    .slice(0, 10);
  for (const row of rows) {
    const skill = skills.find((item) => item.technician_id === row.profile_id);
    if (!skill) throw new Error(`No skill for ${row.email}`);
    const booking = {
      serviceId: skill.service_id,
      preferredStartAt: new Date(`${vnDay}T10:00:00+07:00`),
      preferredEndAt: new Date(`${vnDay}T11:00:00+07:00`),
      latitudeSnapshot: Number(row.latitude),
      longitudeSnapshot: Number(row.longitude),
    } as Booking;
    const near = await technicianEligibility(manager, row.id, booking);
    if (!near.eligible) throw new Error(`${row.email}: ${near.reason}`);
    const far = await technicianEligibility(manager, row.id, {
      ...booking,
      latitudeSnapshot: Number(row.latitude) + 0.3,
    } as Booking);
    if (far.eligible || far.reason !== 'Outside technician service radius')
      throw new Error('Distance boundary check failed');
  }
  return {
    batchId,
    count: rows.length,
    emails: rows.map((row) => row.email),
    verified: rows.length,
    walletBalanceEach: BALANCE,
    totalBalance: BALANCE * count,
    coveredServices: new Set(skills.map((skill) => skill.service_id)).size,
    skillRecords: skills.length,
    distinctWards: new Set(rows.map((row) => row.district_code)).size,
    matchingNearPassed: count,
    matchingFarRejected: count,
    categories: [...new Set(skills.map((skill) => skill.category_name))].map(
      (name) => ({
        name,
        technicians: new Set(
          skills
            .filter((skill) => skill.category_name === name)
            .map((skill) => skill.technician_id),
        ).size,
      }),
    ),
    accounts: rows.map((row) => ({
      email: row.email,
      name: row.full_name,
      ward: row.ward,
      latitude: row.latitude,
      longitude: row.longitude,
    })),
  };
}

export async function seedTestTechnicians(
  source: DataSource,
  apply = false,
  range?: TechnicianRange,
) {
  const batchId = rangeBatchId(range);
  const runner = source.createQueryRunner();
  await runner.connect();
  await runner.startTransaction('REPEATABLE READ');
  try {
    await runner.query(`SET LOCAL lock_timeout='10s'`);
    // Serialize this fixture; a committed audit marker makes retries a no-op.
    await runner.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      'fixhome-test-technicians',
    ]);
    const manager = runner.manager;
    const existingBatch = await manager.findOneBy(AuditLog, {
      action: 'TEST_TECHNICIANS_SEEDED',
      resourceId: batchId,
    });
    if (existingBatch) {
      const report = await verifyBatch(manager, batchId);
      await runner.rollbackTransaction();
      return { mode: 'already-applied', ...report };
    }
    const plan = await preflight(manager, range);
    const count = plan.sequences.length;
    if (!count) {
      await runner.rollbackTransaction();
      return { mode: 'range-complete', count: 0, range };
    }
    const summary = {
      maximumExistingNumber: plan.start - 1,
      firstEmail: `tech${plan.sequences[0]}@fixhome.vn`,
      lastEmail: `tech${plan.sequences[count - 1]}@fixhome.vn`,
      count,
      range,
      categories: plan.categories.map((id) => ({
        name: plan.services.find((service) => service.category_id === id)
          .category_name,
        technicians: plan.allocation.filter((category) => category === id)
          .length,
        services: plan.services
          .filter((service) => service.category_id === id)
          .map((service) => service.name),
      })),
      wards: plan.locations.map((location) => location.district_name),
    };
    if (!apply) {
      await runner.rollbackTransaction();
      return { mode: 'dry-run', ...summary };
    }
    const password = process.env.SEED_TECHNICIAN_PASSWORD;
    if (!password || password.length < 8)
      throw new Error('SEED_TECHNICIAN_PASSWORD (8+ characters) is required');
    const hash = await bcrypt.hash(password, 12);
    const fixture = readFileSync(
      resolve('src/database/seeds/fixtures/technician-test-document.png'),
    );
    const storage = new KycStorageService(new ConfigService());
    const before = await snapshot(manager);
    const occupiedPhones = new Set(
      (
        await manager.query(
          'SELECT phone_number FROM users WHERE phone_number IS NOT NULL',
        )
      ).map((row) => row.phone_number.replace(/^\+84/, '0')),
    );
    const occupiedIds = new Set(
      (
        await manager.query(
          'SELECT citizen_id_number FROM users WHERE citizen_id_number IS NOT NULL',
        )
      ).map((row) => row.citizen_id_number),
    );
    const userIds: string[] = [];
    const surnames = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Võ'];
    const givenNames = [
      'Minh An',
      'Quốc Bảo',
      'Thanh Bình',
      'Hữu Dũng',
      'Tuấn Khang',
    ];
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      const profileId = randomUUID();
      const verificationId = randomUUID();
      const walletId = randomUUID();
      const sequence = plan.sequences[index];
      const email = `tech${sequence}@fixhome.vn`;
      const fullName = `${surnames[Math.floor(index / 5) % surnames.length]} ${givenNames[index % 5]}${range ? ` (kiểm thử ${sequence})` : ''}`;
      let phone: string;
      do {
        phone = `09${randomInt(10000000, 100000000)}`;
      } while (occupiedPhones.has(phone));
      occupiedPhones.add(phone);
      let citizenId: string;
      // 999 is intentionally synthetic, never a claim of a real identity.
      do {
        citizenId = `999${randomInt(100000000, 1000000000)}`;
      } while (occupiedIds.has(citizenId));
      occupiedIds.add(citizenId);
      const area = plan.locations[index];
      const fullAddress = `Điểm kiểm thử ${sequence}, ${area.district_name}, ${area.province_name}`;
      const now = new Date();
      const upload = await storage.createSignedUploadUrl(id, 'image/png');
      try {
        await axios.put(upload.uploadUrl, fixture, {
          headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
          timeout: 15000,
        });
        const access = await storage.createSignedAccess(
          upload.storageObjectPath,
          id,
        );
        const downloaded = await axios.get(access.signedUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
        });
        if (!Buffer.from(downloaded.data).equals(fixture))
          throw new Error('Fixture content mismatch');
      } catch {
        throw new Error(`Private fixture upload/read failed for ${email}`);
      }
      const document = {
        storageObjectPath: upload.storageObjectPath,
        fileName: 'mau-kiem-thu-khong-phai-giay-to-that.png',
        fileSize: fixture.length,
        mimeType: 'image/png',
      };
      await manager.insert(User, {
        id,
        email,
        passwordHash: hash,
        fullName,
        phoneNumber: phone,
        role: Role.TECHNICIAN,
        status: AccountStatus.ACTIVE,
        isActive: true,
        isEmailVerified: true,
        authProvider: AuthProvider.LOCAL,
        dateOfBirth: new Date(`${1985 + (index % 15)}-05-15T00:00:00Z`),
        gender: Gender.MALE,
        citizenIdNumber: citizenId,
      });
      await manager.insert(TechnicianProfile, {
        id: profileId,
        userId: id,
        verificationStatus: VerificationStatus.VERIFIED,
        onboardingStatus: OnboardingStatus.APPROVED,
        onboardingStep: 5,
        yearsExperience: 3 + (index % 8),
        bio: `Tài khoản kiểm thử kỹ thuật viên — ${plan.services.find((service) => service.category_id === plan.allocation[index]).category_name}.`,
        averageRating: 5,
        ratingCount: 0,
        reliabilityScore: 100,
        isAvailable: true,
        serviceRadiusKm: 10,
        fullAddress,
        latitude: area.latitude,
        longitude: area.longitude,
      });
      await manager.insert(Address, {
        id: randomUUID(),
        userId: id,
        label: 'Điểm làm việc kiểm thử',
        line1: fullAddress,
        ward: area.district_name,
        district: area.district_name,
        province: area.province_name,
        provinceCode: area.province_code,
        districtCode: area.district_code,
        lat: area.latitude,
        lng: area.longitude,
        isDefault: true,
      });
      await manager.insert(TechnicianServiceArea, {
        id: randomUUID(),
        technicianId: profileId,
        provinceCode: area.province_code,
        districtCode: area.district_code,
      });
      await manager.insert(
        TechnicianSchedule,
        Array.from({ length: 7 }, (_, day) => ({
          id: randomUUID(),
          technicianId: profileId,
          dayOfWeek: day,
          startTime: '07:00',
          endTime: '22:00',
        })),
      );
      await manager.insert(TechnicianVerification, {
        id: verificationId,
        technicianId: id,
        status: VerificationStatus.VERIFIED,
        submittedAt: now,
        reviewedAt: now,
        reviewedById: plan.admin.id,
        verifiedFullName: fullName,
      });
      await manager.insert(
        VerificationDocument,
        [
          DocumentType.CITIZEN_ID_FRONT,
          DocumentType.CITIZEN_ID_BACK,
          DocumentType.FACE_PHOTO,
        ].map((documentType) => ({
          id: randomUUID(),
          verificationId,
          documentType,
          ...document,
        })),
      );
      const audit = async (
        action: string,
        resourceType: string,
        resourceId: string,
        after: Record<string, unknown>,
      ) =>
        manager.insert(AuditLog, {
          id: randomUUID(),
          actorUserId: plan.admin.id,
          actorRole: Role.ADMIN,
          action,
          resourceType,
          resourceId,
          after: { ...after, syntheticTestFixture: true, batchId },
        });
      await audit(
        'KYC_VERIFICATION_APPROVED',
        'technician_verification',
        verificationId,
        { status: VerificationStatus.VERIFIED, reviewedById: plan.admin.id },
      );
      for (const service of plan.services.filter(
        (item) => item.category_id === plan.allocation[index],
      )) {
        const skillId = randomUUID();
        const skillVerificationId = randomUUID();
        await manager.insert(TechnicianSkill, {
          id: skillId,
          technicianId: profileId,
          serviceId: service.id,
          level: 'INTERMEDIATE',
          listedLaborPrice:
            service.pricing_mode === ServicePricingMode.FIXED_PRICE
              ? null
              : Number(service.base_price ?? 0),
          typicalWarrantyDays: 30,
          isActive: true,
          verificationStatus: VerificationStatus.VERIFIED,
        });
        await manager.insert(TechnicianSkillVerification, {
          id: skillVerificationId,
          technicianSkillId: skillId,
          status: VerificationStatus.VERIFIED,
          submittedAt: now,
          reviewedAt: now,
          reviewedById: plan.admin.id,
        });
        await manager.insert(VerificationDocument, {
          id: randomUUID(),
          skillVerificationId,
          documentType: DocumentType.CERTIFICATE,
          issuedById: plan.admin.id,
          ...document,
        });
        await audit(
          'SKILL_VERIFICATION_APPROVED',
          'technician_skill_verification',
          skillVerificationId,
          { status: VerificationStatus.VERIFIED, reviewedById: plan.admin.id },
        );
      }
      await manager.insert(Wallet, {
        id: walletId,
        technicianId: id,
        balance: BALANCE,
      });
      await manager.insert(WalletTransaction, {
        id: randomUUID(),
        walletId,
        type: WalletTransactionType.ADJUSTMENT,
        amount: BALANCE,
        balanceBefore: 0,
        balanceAfter: BALANCE,
        referenceType: 'ADMIN_ADJUSTMENT',
        referenceId: plan.admin.id,
        idempotencyKey: `${batchId}:${id}`,
        description: 'Cấp 200.000 ₫ cho tài khoản kiểm thử kỹ thuật viên',
      });
      await audit('WALLET_ADJUSTMENT', 'wallet', walletId, {
        balanceBefore: 0,
        balance: BALANCE,
        amount: BALANCE,
      });
      userIds.push(id);
      if ((index + 1) % 10 === 0 || index + 1 === count)
        console.log(
          `Prepared ${index + 1}/${count} technicians; transaction not committed yet`,
        );
    }
    await manager.insert(AuditLog, {
      id: randomUUID(),
      actorUserId: plan.admin.id,
      actorRole: Role.ADMIN,
      action: 'TEST_TECHNICIANS_SEEDED',
      resourceType: 'seed_batch',
      resourceId: batchId,
      after: {
        userIds,
        serviceIds: plan.services.map((service) => service.id),
        syntheticTestFixture: true,
        ...summary,
      },
    });
    const report = await verifyBatch(manager, batchId);
    await verifyOldRows(manager, before);
    await runner.query('SET CONSTRAINTS ALL IMMEDIATE');
    await runner.commitTransaction();
    return {
      mode: 'applied',
      existingRowsUnchanged: true,
      privateFixturesUploadedAndRead: count,
      ...report,
    };
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    // Do not delete storage objects on failure: this seed is append-only.
    // Random object names ensure an unsuccessful run cannot overwrite old files.
    throw error;
  } finally {
    await runner.release();
  }
}

if (require.main === module) {
  void (async () => {
    let dataSource: DataSource;
    try {
      const args = process.argv.slice(2);
      const fromIndex = args.indexOf('--from');
      const toIndex = args.indexOf('--to');
      if ((fromIndex === -1) !== (toIndex === -1))
        throw new Error('Provide both --from and --to');
      const range =
        fromIndex === -1
          ? undefined
          : {
              from: Number(args[fromIndex + 1]),
              to: Number(args[toIndex + 1]),
            };
      const batchId = rangeBatchId(range);
      dataSource = (await import('../data-source')).default;
      await dataSource.initialize();
      const report = process.argv.includes('--verify')
        ? await verifyBatch(dataSource.manager, batchId)
        : await seedTestTechnicians(
            dataSource,
            process.argv.includes('--apply'),
            range,
          );
      console.log(JSON.stringify(report, null, 2));
    } catch (error) {
      // Never print driver/provider objects: they can include credentials or hashes.
      console.error(
        error instanceof Error ? error.message : 'Technician seed failed',
      );
      process.exitCode = 1;
    } finally {
      if (dataSource?.isInitialized) await dataSource.destroy();
    }
  })();
}
