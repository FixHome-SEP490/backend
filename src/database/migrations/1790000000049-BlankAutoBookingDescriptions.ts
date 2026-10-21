import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 21/10/2026: the web used to fill an empty description with "Yêu cầu dịch
 * vụ: <tên>" or "Yêu cầu dịch vụ niêm yết: <tên>" (with " (2 máy)" for several
 * units), which the order pages then showed as the customer's own words. Only
 * those exact generated lines, naming the booking's own service, are blanked.
 */
export class BlankAutoBookingDescriptions1790000000049 implements MigrationInterface {
  name = 'BlankAutoBookingDescriptions1790000000049';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "bookings" SET "description" = ''
      WHERE "service_name_snapshot" IS NOT NULL AND (
        "description" = 'Yêu cầu dịch vụ: ' || "service_name_snapshot"
        OR "description" = 'Yêu cầu dịch vụ niêm yết: ' || "service_name_snapshot"
        OR "description" LIKE 'Yêu cầu dịch vụ niêm yết: ' || "service_name_snapshot" || ' (%)'
      )
    `);
  }

  public async down(): Promise<void> {
    // The generated lines carried nothing the customer wrote; they are not restored.
  }
}
