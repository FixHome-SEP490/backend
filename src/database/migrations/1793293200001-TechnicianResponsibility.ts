import { MigrationInterface, QueryRunner } from 'typeorm';

/** Nullable forward-only review fields. Historical cases and reputation are not rewritten. */
export class TechnicianResponsibility1793293200001 implements MigrationInterface {
  name = 'TechnicianResponsibility1793293200001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE support_cases
        ADD COLUMN reason_class varchar(32),
        ADD COLUMN reason_code varchar(48),
        ADD COLUMN responsibility varchar(32),
        ADD COLUMN responsibility_command_id uuid,
        ADD COLUMN responsibility_actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
        ADD COLUMN responsibility_reason varchar(2000),
        ADD COLUMN responsibility_evidence_refs jsonb,
        ADD COLUMN responsibility_decided_at timestamptz,
        ADD CONSTRAINT chk_technician_report_reason CHECK (
          (reason_class IS NULL AND reason_code IS NULL AND responsibility IS NULL)
          OR (reason_class = 'technician_skill_gap' AND reason_code = 'skill_gap' AND responsibility IS NOT NULL)
          OR (reason_class = 'non_technician_exception' AND reason_code IN (
            'device_too_old','severe_damage','no_compatible_part','manufacturer_warranty_or_workshop',
            'customer_absent','customer_cancelled','dispute_or_other') AND responsibility IS NOT NULL)
        ),
        ADD CONSTRAINT chk_technician_report_decision CHECK (
          responsibility IS NULL OR responsibility = 'pending_sm_review' AND
            responsibility_command_id IS NULL AND responsibility_actor_id IS NULL AND
            responsibility_reason IS NULL AND responsibility_decided_at IS NULL
          OR responsibility IN ('technician_fault','no_technician_fault','inconclusive') AND
            responsibility_command_id IS NOT NULL AND responsibility_actor_id IS NOT NULL AND
            responsibility_reason IS NOT NULL AND responsibility_decided_at IS NOT NULL
        );
      CREATE UNIQUE INDEX uq_pending_technician_report ON support_cases(service_order_id, technician_id)
        WHERE reason_class IS NOT NULL AND responsibility = 'pending_sm_review';
      CREATE UNIQUE INDEX uq_technician_responsibility_command ON support_cases(responsibility_command_id)
        WHERE responsibility_command_id IS NOT NULL;
      ALTER TABLE reputation_events
        ADD COLUMN support_case_id uuid REFERENCES support_cases(id) ON DELETE RESTRICT;
      CREATE UNIQUE INDEX uq_reputation_case_event ON reputation_events(support_case_id)
        WHERE support_case_id IS NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ count: string }> = await queryRunner.query(`
      SELECT (SELECT count(*) FROM support_cases WHERE reason_class IS NOT NULL)
        + (SELECT count(*) FROM reputation_events WHERE support_case_id IS NOT NULL) AS count
    `);
    if (Number(rows[0]?.count) !== 0) throw new Error('Reviewed case evidence exists; rollback requires separate review');
    await queryRunner.query(`
      DROP INDEX uq_reputation_case_event;
      ALTER TABLE reputation_events DROP COLUMN support_case_id;
      DROP INDEX uq_technician_responsibility_command;
      DROP INDEX uq_pending_technician_report;
      ALTER TABLE support_cases
        DROP CONSTRAINT chk_technician_report_decision,
        DROP CONSTRAINT chk_technician_report_reason,
        DROP COLUMN responsibility_decided_at,
        DROP COLUMN responsibility_evidence_refs,
        DROP COLUMN responsibility_reason,
        DROP COLUMN responsibility_actor_id,
        DROP COLUMN responsibility_command_id,
        DROP COLUMN responsibility,
        DROP COLUMN reason_code,
        DROP COLUMN reason_class;
    `);
  }
}
