import { MigrationInterface, QueryRunner } from 'typeorm';

export class ServiceOrderTechnicianLocation1725904000000 implements MigrationInterface {
  name = 'ServiceOrderTechnicianLocation1725904000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE service_orders
        ADD COLUMN technician_last_lat decimal(10,7),
        ADD COLUMN technician_last_lng decimal(10,7),
        ADD COLUMN technician_location_updated_at timestamptz;
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE service_orders
        DROP COLUMN technician_location_updated_at,
        DROP COLUMN technician_last_lng,
        DROP COLUMN technician_last_lat;
    `);
  }
}
