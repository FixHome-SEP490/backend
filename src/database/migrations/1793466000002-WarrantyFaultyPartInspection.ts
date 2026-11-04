import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A faulty FixHome part comes back to the warehouse and a manager inspects it before the
 * replacement is issued (PO 04/11/2026). The result decides who pays: manufacturer fault and
 * undetermined are FixHome's, installation fault is the technician's. Forward-only, nullable.
 */
export class WarrantyFaultyPartInspection1793466000002 implements MigrationInterface {
  name = 'WarrantyFaultyPartInspection1793466000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE part_requests
        ADD COLUMN faulty_inspection_result varchar(16),
        ADD COLUMN faulty_inspection_note text,
        ADD COLUMN faulty_inspection_evidence jsonb,
        ADD COLUMN faulty_inspected_at timestamptz,
        ADD COLUMN faulty_inspected_by uuid REFERENCES users(id) ON DELETE RESTRICT,
        ADD CONSTRAINT ck_pr_faulty_inspection CHECK (
          faulty_inspection_result IS NULL
          OR (request_type::text = 'warranty'
            AND faulty_inspection_result IN ('manufacturer','installation','undetermined')
            AND faulty_inspected_at IS NOT NULL AND faulty_inspected_by IS NOT NULL
            AND (faulty_inspection_result <> 'installation'
              OR (length(btrim(coalesce(faulty_inspection_note, ''))) >= 10
                AND jsonb_typeof(faulty_inspection_evidence) = 'array'
                AND jsonb_array_length(faulty_inspection_evidence) >= 1)))
        );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`LOCK TABLE part_requests IN ACCESS EXCLUSIVE MODE`);
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM part_requests WHERE faulty_inspection_result IS NOT NULL) THEN
        RAISE EXCEPTION 'Faulty part inspections exist; rollback requires a reviewed forward migration';
      END IF;
    END $$`);
    await queryRunner.query(`
      ALTER TABLE part_requests
        DROP CONSTRAINT ck_pr_faulty_inspection,
        DROP COLUMN faulty_inspected_by,
        DROP COLUMN faulty_inspected_at,
        DROP COLUMN faulty_inspection_evidence,
        DROP COLUMN faulty_inspection_note,
        DROP COLUMN faulty_inspection_result;
    `);
  }
}
