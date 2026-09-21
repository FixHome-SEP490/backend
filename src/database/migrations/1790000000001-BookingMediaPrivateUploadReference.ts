import { MigrationInterface, QueryRunner } from 'typeorm';

export class BookingMediaPrivateUploadReference1790000000001 implements MigrationInterface {
  name = 'BookingMediaPrivateUploadReference1790000000001';

  private async targetSchema(queryRunner: QueryRunner): Promise<{ name: string; quoted: string }> {
    const rows = await queryRunner.query('SELECT current_schema() AS target_schema');
    const name: unknown = rows?.[0]?.target_schema;
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
      throw new Error('No current schema; refusing private Booking media reference migration');
    }
    return { name, quoted: '"' + name.replace(/"/g, '""') + '"' };
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    const bookingMedia = schema.quoted + '."booking_media"';
    const uploads = schema.quoted + '."booking_media_uploads"';
    const ddl = [
      'ALTER TABLE ' + bookingMedia,
      'ADD COLUMN "private_upload_id" uuid NULL,',
      'ADD CONSTRAINT "fk_booking_media_private_upload" FOREIGN KEY ("private_upload_id")',
      'REFERENCES ' + uploads + '("id") ON DELETE RESTRICT,',
      'ADD CONSTRAINT "uq_booking_media_private_upload" UNIQUE ("private_upload_id"),',
      'ADD CONSTRAINT "ck_booking_media_private_url_empty"',
      'CHECK ("private_upload_id" IS NULL OR "url" = \'\')',
    ].join(' ');
    await queryRunner.query(ddl);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    const bookingMedia = schema.quoted + '."booking_media"';
    const rows = await queryRunner.query(
      'SELECT COUNT(*)::int AS count FROM ' + bookingMedia + ' WHERE "private_upload_id" IS NOT NULL',
    );
    if (rows?.length !== 1 || !Number.isSafeInteger(Number(rows[0]?.count))) {
      throw new Error('Cannot verify private Booking media reference count; refusing rollback');
    }
    if (Number(rows[0].count) > 0) {
      throw new Error('Cannot drop private_upload_id while private Booking media references exist');
    }
    const ddl = [
      'ALTER TABLE ' + bookingMedia,
      'DROP CONSTRAINT "ck_booking_media_private_url_empty",',
      'DROP CONSTRAINT "uq_booking_media_private_upload",',
      'DROP CONSTRAINT "fk_booking_media_private_upload",',
      'DROP COLUMN "private_upload_id"',
    ].join(' ');
    await queryRunner.query(ddl);
  }
}
