import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 08/10/2026: after checking in, a technician who finds the job outside
 * their skills reports "Cần thay đổi thợ"; it reaches the Service Manager as a
 * support case of its own type. The order photos are stamped with the date
 * and order code at upload (Cloudinary), which needs no schema change.
 */
export class TechnicianReplacementCase1790000000029 implements MigrationInterface {
  name = 'TechnicianReplacementCase1790000000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "support_case_type_enum" ADD VALUE IF NOT EXISTS 'technician_replacement'`);
  }

  public async down(): Promise<void> {
    // Postgres cannot drop an enum value; rows using it would have to be removed first.
  }
}
