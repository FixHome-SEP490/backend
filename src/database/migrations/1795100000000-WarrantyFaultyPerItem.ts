import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The faulty part is counted in line by line (PO 28/11/2026): the manager confirms how many of each line
 * arrived, sends them to the manufacturer and records its verdict. Replaces the order-level inspection,
 * whose columns stay as history. Forward-only: the backfill maps the old order-level state onto the lines.
 */
export class WarrantyFaultyPerItem1795100000000 implements MigrationInterface {
  name = 'WarrantyFaultyPerItem1795100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE part_request_items
        ADD COLUMN faulty_status varchar(30),
        ADD COLUMN faulty_received_qty int NOT NULL DEFAULT 0,
        ADD COLUMN faulty_received_at timestamptz,
        ADD COLUMN faulty_sent_at timestamptz,
        ADD COLUMN faulty_result_note text,
        ADD COLUMN faulty_result_evidence jsonb,
        ADD COLUMN faulty_resolved_at timestamptz,
        ADD COLUMN faulty_resolved_by uuid REFERENCES users(id),
        ADD CONSTRAINT ck_pri_faulty_status CHECK (faulty_status IS NULL OR faulty_status IN
          ('awaiting','partial','received','sent_to_manufacturer','manufacturer_accepted','manufacturer_rejected')),
        ADD CONSTRAINT ck_pri_faulty_received_qty CHECK (faulty_received_qty >= 0 AND faulty_received_qty <= quantity)
    `);

    // Every warranty line starts waiting; a hand-in or an inspection recorded under the old model counts the whole line in.
    await queryRunner.query(`
      UPDATE part_request_items i SET
        faulty_status = CASE
          WHEN r.faulty_inspection_result = 'installation' THEN 'manufacturer_rejected'
          WHEN r.faulty_inspection_result = 'manufacturer' THEN 'manufacturer_accepted'
          WHEN r.faulty_returned_at IS NOT NULL THEN 'received'
          ELSE 'awaiting' END,
        faulty_received_qty = CASE WHEN r.faulty_returned_at IS NOT NULL THEN i.quantity ELSE 0 END,
        faulty_received_at = r.faulty_returned_at,
        faulty_resolved_at = CASE WHEN r.faulty_inspection_result IN ('installation','manufacturer') THEN r.faulty_inspected_at END,
        faulty_resolved_by = CASE WHEN r.faulty_inspection_result IN ('installation','manufacturer') THEN r.faulty_inspected_by END,
        faulty_result_note = CASE WHEN r.faulty_inspection_result IN ('installation','manufacturer') THEN r.faulty_inspection_note END,
        faulty_result_evidence = CASE WHEN r.faulty_inspection_result IN ('installation','manufacturer') THEN r.faulty_inspection_evidence END
      FROM part_requests r
      WHERE r.id = i.part_request_id AND r.request_type::text = 'warranty'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE part_request_items
        DROP CONSTRAINT ck_pri_faulty_received_qty, DROP CONSTRAINT ck_pri_faulty_status,
        DROP COLUMN faulty_resolved_by, DROP COLUMN faulty_resolved_at, DROP COLUMN faulty_result_evidence,
        DROP COLUMN faulty_result_note, DROP COLUMN faulty_sent_at, DROP COLUMN faulty_received_at,
        DROP COLUMN faulty_received_qty, DROP COLUMN faulty_status
    `);
  }
}
