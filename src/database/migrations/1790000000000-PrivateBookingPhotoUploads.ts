import { MigrationInterface, QueryRunner } from 'typeorm';

export class PrivateBookingPhotoUploads1790000000000 implements MigrationInterface {
  name = 'PrivateBookingPhotoUploads1790000000000';

  private async targetSchema(queryRunner: QueryRunner): Promise<{ name: string; quoted: string }> {
    const rows = await queryRunner.query('SELECT current_schema() AS target_schema');
    const name: unknown = rows?.[0]?.target_schema;
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
      throw new Error('No current schema; refusing Booking media upload migration');
    }
    return { name, quoted: `"${name.replace(/"/g, '""')}"` };
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    const table = `${schema.quoted}."booking_media_uploads"`;
    await queryRunner.query(`
      CREATE TABLE ${table} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "owner_user_id" uuid NOT NULL,
        "object_ref" varchar NOT NULL,
        "mime_type" varchar(30) NOT NULL,
        "size_bytes" integer NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "claimed_booking_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "uq_booking_media_uploads_object_ref" UNIQUE ("object_ref"),
        CONSTRAINT "fk_booking_media_uploads_owner_user"
          FOREIGN KEY ("owner_user_id") REFERENCES ${schema.quoted}."users"("id") ON DELETE RESTRICT,
        CONSTRAINT "fk_booking_media_uploads_claimed_booking"
          FOREIGN KEY ("claimed_booking_id") REFERENCES ${schema.quoted}."bookings"("id") ON DELETE RESTRICT,
        CONSTRAINT "ck_booking_media_uploads_size_bytes" CHECK ("size_bytes" > 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_booking_media_uploads_owner_expires_at"
      ON ${table} ("owner_user_id", "expires_at")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    const table = `${schema.quoted}."booking_media_uploads"`;
    const existence = await queryRunner.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'booking_media_uploads'
      ) AS table_exists`,
      [schema.name],
    );
    if (existence?.[0]?.table_exists !== true) return;

    const rows = await queryRunner.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    if (rows?.length !== 1 || !Number.isSafeInteger(Number(rows[0]?.count))) {
      throw new Error('Cannot verify Booking photo upload ownership metadata; refusing rollback');
    }
    if (Number(rows[0].count) > 0) {
      throw new Error('Cannot drop booking_media_uploads while upload ownership metadata exists');
    }
    await queryRunner.query(`DROP TABLE ${table}`);
  }
}