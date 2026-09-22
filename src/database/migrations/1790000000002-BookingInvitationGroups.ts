import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives each shortlist/rematch round a durable identity so a customer TTL
 * extension cannot be reused by a later round. Existing invitation rows stay
 * nullable and therefore fail closed until a new round is created by code.
 */
export class BookingInvitationGroups1790000000002 implements MigrationInterface {
  name = 'BookingInvitationGroups1790000000002';

  private async targetSchema(queryRunner: QueryRunner): Promise<{ name: string; quoted: string }> {
    const rows = await queryRunner.query('SELECT current_schema() AS target_schema');
    const name: unknown = rows?.[0]?.target_schema;
    if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
      throw new Error('No current schema; refusing invitation group migration');
    }
    return { name, quoted: `"${name.replace(/"/g, '""')}"` };
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    const groups = `${schema.quoted}."booking_invitation_groups"`;
    const bookings = `${schema.quoted}."bookings"`;
    const invitations = `${schema.quoted}."booking_invitations"`;

    await queryRunner.query(`
      CREATE TABLE ${groups} (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "booking_id" uuid NOT NULL,
        "extension_used_at" timestamptz NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "fk_booking_invitation_groups_booking"
          FOREIGN KEY ("booking_id") REFERENCES ${bookings}("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_booking_invitation_groups_booking"
      ON ${groups} ("booking_id")
    `);
    await queryRunner.query(`
      ALTER TABLE ${invitations}
      ADD COLUMN "group_id" uuid NULL,
      ADD CONSTRAINT "fk_booking_invitations_group"
        FOREIGN KEY ("group_id") REFERENCES ${groups}("id") ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_booking_invitations_group"
      ON ${invitations} ("group_id")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    const groups = `${schema.quoted}."booking_invitation_groups"`;
    const invitations = `${schema.quoted}."booking_invitations"`;
    const rows = await queryRunner.query(`
      SELECT
        (SELECT COUNT(*)::int FROM ${groups}) AS group_count,
        (SELECT COUNT(*)::int FROM ${invitations} WHERE "group_id" IS NOT NULL) AS invitation_count
    `);
    if (rows?.length !== 1 || Number(rows[0]?.group_count) !== 0 || Number(rows[0]?.invitation_count) !== 0) {
      throw new Error('Cannot rollback invitation groups while durable group state exists');
    }
    await queryRunner.query(`DROP INDEX ${schema.quoted}."ix_booking_invitations_group"`);
    await queryRunner.query(`
      ALTER TABLE ${invitations}
      DROP CONSTRAINT "fk_booking_invitations_group",
      DROP COLUMN "group_id"
    `);
    await queryRunner.query(`DROP INDEX ${schema.quoted}."ix_booking_invitation_groups_booking"`);
    await queryRunner.query(`DROP TABLE ${groups}`);
  }
}
