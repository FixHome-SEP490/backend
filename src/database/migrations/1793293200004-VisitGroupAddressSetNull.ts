import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DEF-r2-fix-visit-01 (01/11/2026): xoá một địa chỉ đã dùng cho lượt nhiều thiết bị trả 500 vì
 * `visit_groups_address_id_fkey` không có ON DELETE. Booking đã có ON DELETE SET NULL và giữ
 * `address_text_snapshot`; màn hình lượt sửa và đơn đọc địa chỉ từ snapshot của booking con,
 * không đọc `visit_groups.address_id`. Nên lượt sửa theo đúng cách của booking: cột cho phép
 * null và khoá ngoại SET NULL, lịch sử vẫn hiện địa chỉ như cũ.
 */
export class VisitGroupAddressSetNull1793293200004 implements MigrationInterface {
  name = 'VisitGroupAddressSetNull1793293200004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "visit_groups" ALTER COLUMN "address_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "visit_groups" DROP CONSTRAINT IF EXISTS "visit_groups_address_id_fkey"`);
    await queryRunner.query(`
      ALTER TABLE "visit_groups"
        ADD CONSTRAINT "visit_groups_address_id_fkey"
        FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL
    `);
  }

  // A group whose address was deleted keeps NULL; NOT NULL is only restored when none exists.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "visit_groups" DROP CONSTRAINT IF EXISTS "visit_groups_address_id_fkey"`);
    await queryRunner.query(`
      ALTER TABLE "visit_groups"
        ADD CONSTRAINT "visit_groups_address_id_fkey"
        FOREIGN KEY ("address_id") REFERENCES "addresses"("id")
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM "visit_groups" WHERE "address_id" IS NULL) THEN
          ALTER TABLE "visit_groups" ALTER COLUMN "address_id" SET NOT NULL;
        END IF;
      END $$
    `);
  }
}
