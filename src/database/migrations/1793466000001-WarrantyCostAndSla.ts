import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Warranty cost and deadlines (PO 04/11/2026): a FixHome part for a warranty re-service
 * is a free part request tied to the claim, a technician who caused the fault pays for it,
 * a claim that cannot be fixed is refunded to the customer wallet and charged to the
 * original technician, and unattended claims are chased by deadline sweeps.
 * Forward-only, nullable additions; historical rows are not rewritten.
 */
export class WarrantyCostAndSla1793466000001 implements MigrationInterface {
  name = 'WarrantyCostAndSla1793466000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Text comparisons keep the CHECK safe: the 'warranty' label was added by the previous migration.
    await queryRunner.query(`
      ALTER TABLE warranty_claims
        ADD COLUMN awaiting_since timestamptz,
        ADD COLUMN last_reminder_at timestamptz,
        ADD COLUMN no_show_flagged_at timestamptz,
        ADD COLUMN decline_review varchar(12),
        ADD COLUMN outcome_code varchar(12),
        ADD COLUMN refund_amount bigint,
        ADD CONSTRAINT chk_warranty_decline_review CHECK (decline_review IS NULL OR decline_review IN ('pending','valid','invalid')),
        ADD CONSTRAINT chk_warranty_outcome_code CHECK (outcome_code IS NULL OR outcome_code IN ('fixed','unfixed','rejected')),
        ADD CONSTRAINT chk_warranty_refund_amount CHECK (refund_amount IS NULL OR (refund_amount >= 0 AND outcome_code = 'unfixed'));

      ALTER TABLE part_requests
        ADD COLUMN warranty_claim_id uuid,
        ADD COLUMN charge_technician boolean NOT NULL DEFAULT false,
        ADD CONSTRAINT fk_pr_warranty_claim FOREIGN KEY (warranty_claim_id) REFERENCES warranty_claims(id),
        DROP CONSTRAINT ck_pr_cost_source,
        ADD CONSTRAINT ck_pr_cost_source CHECK (
          (request_type::text = 'pre_repair' AND additional_cost_id IS NULL AND quotation_id IS NULL AND warranty_claim_id IS NULL)
          OR (request_type::text = 'additional' AND additional_cost_id IS NOT NULL AND quotation_id IS NULL AND warranty_claim_id IS NULL)
          OR (request_type::text = 'quotation' AND quotation_id IS NOT NULL AND additional_cost_id IS NULL AND warranty_claim_id IS NULL)
          OR (request_type::text = 'warranty' AND warranty_claim_id IS NOT NULL AND additional_cost_id IS NULL AND quotation_id IS NULL)
        ),
        ADD CONSTRAINT ck_pr_charge_warranty_only CHECK (charge_technician = false OR request_type::text = 'warranty');
      CREATE UNIQUE INDEX ux_pr_warranty_claim ON part_requests(warranty_claim_id) WHERE warranty_claim_id IS NOT NULL;

      ALTER TABLE reputation_events
        ADD COLUMN warranty_claim_id uuid REFERENCES warranty_claims(id) ON DELETE RESTRICT,
        ADD COLUMN warranty_cause varchar(16),
        ADD CONSTRAINT chk_reputation_warranty_cause CHECK (
          (warranty_claim_id IS NULL AND warranty_cause IS NULL)
          OR (warranty_claim_id IS NOT NULL AND warranty_cause IN ('decline','no_show','unfixed'))
        );
      CREATE UNIQUE INDEX uq_reputation_warranty_event ON reputation_events(warranty_claim_id, warranty_cause)
        WHERE warranty_claim_id IS NOT NULL;

      INSERT INTO "system_configs" ("key", "value", "value_type", "description")
      VALUES
        ('warranty.tech_response_hours', '48', 'int',
         'Giờ thợ phải nhận hoặc từ chối yêu cầu bảo hành; quá hạn thì gỡ thợ và nhắc quản lý phân công lại'),
        ('warranty.inspection_hours', '72', 'int',
         'Giờ thợ phải đến kiểm tra kể từ khi nhận yêu cầu bảo hành; quá hạn thì báo quản lý'),
        ('warranty.customer_response_hours', '72', 'int',
         'Giờ khách phản hồi kết luận hoặc việc bảo hành đã xong; quá hạn thì tự đóng yêu cầu'),
        ('reputation.warranty_violation_points', '5', 'int',
         'Số điểm uy tín bị trừ khi thợ từ chối bảo hành không chính đáng, không đến, hoặc không sửa được trong hạn')
      ON CONFLICT ("key") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`LOCK TABLE part_requests, warranty_claims, reputation_events IN ACCESS EXCLUSIVE MODE`);
    await queryRunner.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM part_requests WHERE warranty_claim_id IS NOT NULL OR request_type::text = 'warranty')
        OR EXISTS (SELECT 1 FROM reputation_events WHERE warranty_claim_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM warranty_claims WHERE outcome_code IS NOT NULL OR decline_review IS NOT NULL) THEN
        RAISE EXCEPTION 'Warranty cost records exist; rollback requires a reviewed forward migration';
      END IF;
    END $$`);
    await queryRunner.query(`
      DELETE FROM "system_configs" WHERE "key" IN (
        'warranty.tech_response_hours','warranty.inspection_hours','warranty.customer_response_hours',
        'reputation.warranty_violation_points');
      DROP INDEX uq_reputation_warranty_event;
      ALTER TABLE reputation_events
        DROP CONSTRAINT chk_reputation_warranty_cause,
        DROP COLUMN warranty_cause,
        DROP COLUMN warranty_claim_id;
      DROP INDEX ux_pr_warranty_claim;
      ALTER TABLE part_requests
        DROP CONSTRAINT ck_pr_charge_warranty_only,
        DROP CONSTRAINT ck_pr_cost_source,
        DROP CONSTRAINT fk_pr_warranty_claim,
        DROP COLUMN charge_technician,
        DROP COLUMN warranty_claim_id,
        ADD CONSTRAINT ck_pr_cost_source CHECK (
          (request_type::text = 'pre_repair' AND additional_cost_id IS NULL AND quotation_id IS NULL)
          OR (request_type::text = 'additional' AND additional_cost_id IS NOT NULL AND quotation_id IS NULL)
          OR (request_type::text = 'quotation' AND quotation_id IS NOT NULL AND additional_cost_id IS NULL)
        );
      ALTER TABLE warranty_claims
        DROP CONSTRAINT chk_warranty_refund_amount,
        DROP CONSTRAINT chk_warranty_outcome_code,
        DROP CONSTRAINT chk_warranty_decline_review,
        DROP COLUMN refund_amount,
        DROP COLUMN outcome_code,
        DROP COLUMN decline_review,
        DROP COLUMN no_show_flagged_at,
        DROP COLUMN last_reminder_at,
        DROP COLUMN awaiting_since;
    `);
  }
}
