import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 31/10/2026: báo trễ / nhả đơn kế tiếp phải có lý do và ảnh bằng chứng, lưu thành hồ sơ
 * hỗ trợ để quản lý dịch vụ xem. Thêm loại hồ sơ `technician_delay` và ba cột nullable.
 * `reason_code` của support_cases dành cho luồng trách nhiệm nên nhóm lý do nằm ở service_orders.
 */
export class TechnicianDelayCase1793293200003 implements MigrationInterface {
  name = 'TechnicianDelayCase1793293200003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "support_case_type_enum" ADD VALUE IF NOT EXISTS 'technician_delay'`);
    await queryRunner.query(`
      ALTER TABLE "service_orders"
        ADD COLUMN IF NOT EXISTS "delay_reason_code" varchar(32),
        ADD COLUMN IF NOT EXISTS "delay_current_order_id" uuid,
        ADD COLUMN IF NOT EXISTS "delay_support_case_id" uuid
    `);
  }

  // ponytail: PostgreSQL cannot drop an enum value; 'technician_delay' stays (harmless) on revert.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "service_orders"
        DROP COLUMN IF EXISTS "delay_support_case_id",
        DROP COLUMN IF EXISTS "delay_current_order_id",
        DROP COLUMN IF EXISTS "delay_reason_code"
    `);
  }
}
