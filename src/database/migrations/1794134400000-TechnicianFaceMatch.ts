import { MigrationInterface, QueryRunner } from 'typeorm';

/** Face match score between the CCCD photo and the selfie, kept for the admin reviewer. Forward-only, nullable. */
export class TechnicianFaceMatch1794134400000 implements MigrationInterface {
  name = 'TechnicianFaceMatch1794134400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE technician_verifications
      ADD COLUMN face_match_score numeric(5,2),
      ADD COLUMN face_match_at timestamp with time zone`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE technician_verifications
      DROP COLUMN face_match_at,
      DROP COLUMN face_match_score`);
  }
}
