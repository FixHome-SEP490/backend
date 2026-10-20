import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuotationPartRequests1790000000044 implements MigrationInterface {
  name = 'QuotationPartRequests1790000000044';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TYPE part_request_type_enum ADD VALUE IF NOT EXISTS 'quotation'`);
    // PG17: do not cast/use the newly added enum value until this transaction commits.
    // Text comparisons keep the CHECK safe with migrationsTransactionMode=each/all.
    await runner.query(`
      ALTER TABLE part_requests
        ADD COLUMN quotation_id uuid,
        ADD CONSTRAINT fk_pr_quotation FOREIGN KEY (quotation_id) REFERENCES quotations(id),
        DROP CONSTRAINT ck_pr_cost_source,
        ADD CONSTRAINT ck_pr_cost_source CHECK (
          (request_type::text = 'pre_repair' AND additional_cost_id IS NULL AND quotation_id IS NULL)
          OR (request_type::text = 'additional' AND additional_cost_id IS NOT NULL AND quotation_id IS NULL)
          OR (request_type::text = 'quotation' AND quotation_id IS NOT NULL AND additional_cost_id IS NULL)
        );
      CREATE UNIQUE INDEX ux_pr_quotation ON part_requests(quotation_id) WHERE quotation_id IS NOT NULL;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Never remove links to stock already requested/issued or rewrite historical rows.
    await runner.query(`LOCK TABLE part_requests IN ACCESS EXCLUSIVE MODE`);
    await runner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM part_requests WHERE quotation_id IS NOT NULL OR request_type::text = 'quotation') THEN
        RAISE EXCEPTION 'Quotation part requests exist; rollback requires a reviewed forward migration';
      END IF;
    END $$`);
    await runner.query(`
      DROP INDEX ux_pr_quotation;
      ALTER TABLE part_requests DROP CONSTRAINT ck_pr_cost_source,
        DROP CONSTRAINT fk_pr_quotation, DROP COLUMN quotation_id,
        ADD CONSTRAINT ck_pr_cost_source CHECK (
          (request_type::text = 'additional' AND additional_cost_id IS NOT NULL)
          OR (request_type::text = 'pre_repair' AND additional_cost_id IS NULL)
        );
    `);
    // PostgreSQL cannot safely remove an enum label; the legacy CHECK disallows it.
  }
}
