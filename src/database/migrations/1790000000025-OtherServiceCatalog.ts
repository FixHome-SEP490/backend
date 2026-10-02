import { MigrationInterface, QueryRunner } from 'typeorm';

export class OtherServiceCatalog1790000000025 implements MigrationInterface {
  name = 'OtherServiceCatalog1790000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "service_categories"
        ("name", "code", "slug", "icon_key", "sort_order", "description", "is_active")
      VALUES
        ('Khác', 'KHAC', 'khac', 'Ellipsis', 99,
         'Yêu cầu sửa chữa hoặc lắp đặt chưa có trong danh mục FixHome', true)
      ON CONFLICT ("code") DO UPDATE SET
        "name" = EXCLUDED."name",
        "slug" = EXCLUDED."slug",
        "icon_key" = EXCLUDED."icon_key",
        "sort_order" = EXCLUDED."sort_order",
        "description" = EXCLUDED."description",
        "is_active" = true,
        "updated_at" = now()
    `);

    await queryRunner.query(`
      INSERT INTO "services"
        ("category_id", "name", "code", "slug", "base_price", "min_price", "max_price",
         "estimated_minutes", "description", "pricing_mode", "unit", "fixed_price",
         "scope_description", "is_active")
      SELECT
        category."id", 'Khác', 'DICH_VU_KHAC', 'dich-vu-khac', 0, NULL, NULL,
        60,
        'Dành cho công việc chưa có trong danh sách dịch vụ. Khách hàng mô tả rõ nhu cầu khi đặt lịch.',
        'inspection_required', 'Yêu cầu', NULL,
        'Kỹ thuật viên đọc mô tả, khảo sát phạm vi công việc và báo giá trước khi thực hiện.',
        true
      FROM "service_categories" AS category
      WHERE category."code" = 'KHAC'
      ON CONFLICT ("code") DO UPDATE SET
        "category_id" = EXCLUDED."category_id",
        "name" = EXCLUDED."name",
        "slug" = EXCLUDED."slug",
        "base_price" = EXCLUDED."base_price",
        "min_price" = EXCLUDED."min_price",
        "max_price" = EXCLUDED."max_price",
        "estimated_minutes" = EXCLUDED."estimated_minutes",
        "description" = EXCLUDED."description",
        "pricing_mode" = EXCLUDED."pricing_mode",
        "unit" = EXCLUDED."unit",
        "fixed_price" = EXCLUDED."fixed_price",
        "scope_description" = EXCLUDED."scope_description",
        "is_active" = true,
        "updated_at" = now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Keep historical Booking/ServiceOrder foreign keys intact. A revert only
    // removes the option from new customer flows instead of deleting catalog
    // rows that may already be referenced by real records.
    await queryRunner.query(`
      UPDATE "services"
      SET "is_active" = false, "updated_at" = now()
      WHERE "code" = 'DICH_VU_KHAC'
    `);
    await queryRunner.query(`
      UPDATE "service_categories"
      SET "is_active" = false, "updated_at" = now()
      WHERE "code" = 'KHAC'
    `);
  }
}
