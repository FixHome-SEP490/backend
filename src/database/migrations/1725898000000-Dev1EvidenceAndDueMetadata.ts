import { MigrationInterface, QueryRunner } from 'typeorm';

export class Dev1EvidenceAndDueMetadata1725898000000 implements MigrationInterface {
  name = 'Dev1EvidenceAndDueMetadata1725898000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE commission_dues ADD COLUMN due_date timestamptz;
      ALTER TABLE repair_evidences ADD COLUMN mime_type varchar(100), ADD COLUMN file_size integer;
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE commission_dues DROP COLUMN due_date;
      ALTER TABLE repair_evidences DROP COLUMN mime_type, DROP COLUMN file_size;
    `);
  }
}
