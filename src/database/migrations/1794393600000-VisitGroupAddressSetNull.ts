import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BUG DETECTOR 59: deleting an address once used for a multi-device visit (even a
 * cancelled one) returned 500, because visit_groups.address_id was NOT NULL with a
 * foreign key that had no delete action. Bookings already keep the address as a
 * snapshot and set their reference to NULL on delete; the visit group follows the
 * same rule. Changes an existing column and constraint only, no new table (PO 11/11).
 */
export class VisitGroupAddressSetNull1794393600000 implements MigrationInterface {
  name = 'VisitGroupAddressSetNull1794393600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "visit_groups" ALTER COLUMN "address_id" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "visit_groups" DROP CONSTRAINT IF EXISTS "visit_groups_address_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "visit_groups" ADD CONSTRAINT "visit_groups_address_id_fkey"
      FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Groups whose address was deleted cannot get it back; restore only the constraint shape.
    await queryRunner.query(`ALTER TABLE "visit_groups" DROP CONSTRAINT IF EXISTS "visit_groups_address_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "visit_groups" ADD CONSTRAINT "visit_groups_address_id_fkey"
      FOREIGN KEY ("address_id") REFERENCES "addresses"("id")`);
  }
}
