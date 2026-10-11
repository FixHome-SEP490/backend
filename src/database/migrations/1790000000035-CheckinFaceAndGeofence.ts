import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 11/10/2026: check-in takes the technician's face with the camera, stored as evidence of a new
 * type, and the GPS check passes within 5 km of the booking with up to 5 km of reported error.
 */
export class CheckinFaceAndGeofence1790000000035 implements MigrationInterface {
  name = 'CheckinFaceAndGeofence1790000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "evidence_type_enum" ADD VALUE IF NOT EXISTS 'checkin_face'`);
    await queryRunner.query(`UPDATE "system_configs" SET "value" = '5000', "updated_at" = now() WHERE "key" IN ('geofence.radius_meters', 'geofence.min_gps_accuracy_meters')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "system_configs" SET "value" = '300', "updated_at" = now() WHERE "key" = 'geofence.radius_meters'`);
    await queryRunner.query(`UPDATE "system_configs" SET "value" = '100', "updated_at" = now() WHERE "key" = 'geofence.min_gps_accuracy_meters'`);
    // A Postgres enum value cannot be dropped; face rows become plain "additional" evidence instead.
    await queryRunner.query(`UPDATE "repair_evidences" SET "type" = 'additional' WHERE "type" = 'checkin_face'`);
  }
}
