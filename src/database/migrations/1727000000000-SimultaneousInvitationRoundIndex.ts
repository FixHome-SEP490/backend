import { MigrationInterface, QueryRunner } from 'typeorm';

/** Allow 1–5 pending invitations in the same round while preserving uniqueness
 * for each booking/technician pair. Replaces the old booking-only partial index. */
export class SimultaneousInvitationRoundIndex1727000000000 implements MigrationInterface {
  name = 'SimultaneousInvitationRoundIndex1727000000000';

  private async targetSchema(queryRunner: QueryRunner): Promise<string> {
    const rows = await queryRunner.query('SELECT current_schema() AS target_schema');
    const schema = rows[0]?.target_schema;
    if (typeof schema !== 'string' || !schema.trim()) {
      throw new Error('No current schema; refusing invitation index migration');
    }
    return schema;
  }

  private quoteIdentifier(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  private async assertIndex(
    queryRunner: QueryRunner,
    schema: string,
    name: string,
    columns: RegExp,
  ): Promise<void> {
    const rows = await queryRunner.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = $1 AND tablename = 'booking_invitations' AND indexname = $2
    `, [schema, name]);
    const definition: unknown = rows[0]?.indexdef;
    if (rows.length !== 1 || typeof definition !== 'string' ||
        !/CREATE UNIQUE INDEX/i.test(definition) || !columns.test(definition) ||
        !/WHERE\s*\(?\s*status\s*=\s*'pending'/i.test(definition)) {
      throw new Error(`Expected ${name} on booking_invitations in current schema; refusing unsafe migration`);
    }
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    await this.assertIndex(queryRunner, schema, 'uq_pending_invitation', /\(\s*booking_id\s*\)/i);
    const table = `${this.quoteIdentifier(schema)}."booking_invitations"`;
    await queryRunner.query(`DROP INDEX ${this.quoteIdentifier(schema)}."uq_pending_invitation"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_pending_booking_technician"
      ON ${table} ("booking_id", "technician_id") WHERE "status" = 'pending'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.targetSchema(queryRunner);
    await this.assertIndex(queryRunner, schema, 'uq_pending_booking_technician', /\(\s*booking_id\s*,\s*technician_id\s*\)/i);
    const table = `${this.quoteIdentifier(schema)}."booking_invitations"`;
    const multiple = await queryRunner.query(`
      SELECT booking_id FROM ${table} WHERE status = 'pending'
      GROUP BY booking_id HAVING COUNT(*) > 1 LIMIT 1
    `);
    if (multiple.length) {
      throw new Error('Cannot downgrade: multiple pending invitations exist for a booking; preserve invitation history');
    }
    await queryRunner.query(`DROP INDEX ${this.quoteIdentifier(schema)}."uq_pending_booking_technician"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_pending_invitation"
      ON ${table} ("booking_id") WHERE "status" = 'pending'
    `);
  }
}