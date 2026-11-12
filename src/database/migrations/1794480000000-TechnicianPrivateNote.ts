import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TECH 42 (PO 13/11/2026): a technician's private note on an order, the same note on web
 * and mobile. One nullable column on the existing technician_assignments row (no new
 * table); only that technician reads or writes it, customers and staff never see it.
 */
export class TechnicianPrivateNote1794480000000 implements MigrationInterface {
  name = 'TechnicianPrivateNote1794480000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "technician_assignments" ADD COLUMN IF NOT EXISTS "private_note" text NULL`);
    await queryRunner.query(`ALTER TABLE "technician_assignments" ADD CONSTRAINT "chk_technician_assignment_private_note_length"
      CHECK ("private_note" IS NULL OR char_length("private_note") <= 2000)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "technician_assignments" DROP CONSTRAINT IF EXISTS "chk_technician_assignment_private_note_length"`);
    await queryRunner.query(`ALTER TABLE "technician_assignments" DROP COLUMN IF EXISTS "private_note"`);
  }
}
