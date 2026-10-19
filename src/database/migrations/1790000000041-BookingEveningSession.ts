import { MigrationInterface, QueryRunner } from 'typeorm';

/** Add the approved Vietnam evening arrival session; preserve every booking. */
export class BookingEveningSession1790000000041 implements MigrationInterface {
  name = 'BookingEveningSession1790000000041';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT "CHK_bookings_slot",
      ADD CONSTRAINT "CHK_bookings_slot" CHECK ("slot" IS NULL OR "slot" IN ('morning', 'afternoon', 'evening'))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Atomic replacement fails if evening rows exist, without deleting or
    // relabelling history or leaving the table without its slot constraint.
    await queryRunner.query(`ALTER TABLE "bookings" DROP CONSTRAINT "CHK_bookings_slot",
      ADD CONSTRAINT "CHK_bookings_slot" CHECK ("slot" IS NULL OR "slot" IN ('morning', 'afternoon'))`);
  }
}
