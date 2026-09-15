import { MigrationInterface, QueryRunner } from 'typeorm';

export class Dev1Integrity1725897000000 implements MigrationInterface {
  name = 'Dev1Integrity1725897000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE bookings ADD COLUMN province_snapshot varchar(100), ADD COLUMN district_snapshot varchar(100), ADD COLUMN service_name_snapshot varchar(255);
      UPDATE bookings b SET province_snapshot = a.province, district_snapshot = a.district,
        address_text_snapshot = COALESCE(b.address_text_snapshot, concat_ws(', ', a.line1, a.ward, a.district, a.province)),
        latitude_snapshot = COALESCE(b.latitude_snapshot, a.lat), longitude_snapshot = COALESCE(b.longitude_snapshot, a.lng)
        FROM addresses a WHERE a.id = b.address_id;
      UPDATE bookings b SET service_name_snapshot = s.name FROM services s WHERE s.id = b.service_id;
      DROP INDEX uq_invitation;
      CREATE UNIQUE INDEX uq_invitation ON booking_invitations(booking_id, priority_order);
      CREATE UNIQUE INDEX uq_pending_invitation ON booking_invitations(booking_id) WHERE status = 'pending';
      CREATE UNIQUE INDEX uq_invoice_order ON invoices(service_order_id);
      ALTER TABLE bookings ADD CONSTRAINT ck_booking_quantity CHECK (quantity > 0);
      ALTER TABLE bookings ADD CONSTRAINT ck_booking_window CHECK (preferred_end_at IS NULL OR preferred_start_at < preferred_end_at);
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    // Reverting repeated matching rounds requires explicit cleanup by the operator; no history deletion.
    await q.query(`
      ALTER TABLE bookings DROP CONSTRAINT ck_booking_window, DROP CONSTRAINT ck_booking_quantity;
      DROP INDEX uq_invoice_order;
      DROP INDEX uq_pending_invitation;
      DROP INDEX uq_invitation;
      CREATE UNIQUE INDEX uq_invitation ON booking_invitations(booking_id, technician_id);
      ALTER TABLE bookings DROP COLUMN service_name_snapshot, DROP COLUMN district_snapshot, DROP COLUMN province_snapshot;
    `);
  }
}
