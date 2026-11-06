import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The technician names the faulty part lines when proposing a part fault, takes the replacement
 * first and brings the faulty part back to the warehouse before a deadline (PO 05/11/2026).
 * A manager inspects it once it is back; the result still decides who pays. Forward-only, nullable.
 */
export class WarrantyFaultyPartReturn1793466000004 implements MigrationInterface {
  name = 'WarrantyFaultyPartReturn1793466000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE warranty_visits ADD COLUMN faulty_invoice_item_ids jsonb`);
    await queryRunner.query(`
      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES
        ('warranty.faulty_return_days', '7', 'int',
         'Số ngày thợ phải nộp linh kiện hỏng về kho sau khi nhận linh kiện thay thế; quá hạn thì trừ ví theo giá linh kiện'),
        ('warranty.faulty_return_reminder_hours', '24', 'int',
         'Nhắc thợ nộp linh kiện hỏng trước hạn bao nhiêu giờ')
      ON CONFLICT ("key") DO NOTHING
    `);
    await queryRunner.query(`
      ALTER TABLE part_requests
        ADD COLUMN faulty_return_due_at timestamptz,
        ADD COLUMN faulty_returned_at timestamptz,
        ADD COLUMN faulty_return_note text,
        ADD COLUMN faulty_return_evidence jsonb,
        ADD COLUMN faulty_return_reminded_at timestamptz,
        ADD COLUMN faulty_return_charged_at timestamptz,
        ADD CONSTRAINT ck_pr_faulty_return CHECK (
          (faulty_return_due_at IS NULL AND faulty_returned_at IS NULL AND faulty_return_note IS NULL
            AND faulty_return_evidence IS NULL AND faulty_return_reminded_at IS NULL AND faulty_return_charged_at IS NULL)
          OR request_type::text = 'warranty'
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`LOCK TABLE part_requests IN ACCESS EXCLUSIVE MODE`);
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM part_requests WHERE faulty_return_due_at IS NOT NULL OR faulty_returned_at IS NOT NULL)
        OR EXISTS (SELECT 1 FROM warranty_visits WHERE faulty_invoice_item_ids IS NOT NULL) THEN
        RAISE EXCEPTION 'Faulty part returns exist; rollback requires a reviewed forward migration';
      END IF;
    END $$`);
    await queryRunner.query(`
      ALTER TABLE part_requests
        DROP CONSTRAINT ck_pr_faulty_return,
        DROP COLUMN faulty_return_charged_at,
        DROP COLUMN faulty_return_reminded_at,
        DROP COLUMN faulty_return_evidence,
        DROP COLUMN faulty_return_note,
        DROP COLUMN faulty_returned_at,
        DROP COLUMN faulty_return_due_at;
    `);
    await queryRunner.query(`ALTER TABLE warranty_visits DROP COLUMN faulty_invoice_item_ids`);
    await queryRunner.query(`DELETE FROM "system_configs" WHERE "key" IN ('warranty.faulty_return_days', 'warranty.faulty_return_reminder_hours')`);
  }
}
