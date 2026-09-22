import { MigrationInterface, QueryRunner } from 'typeorm';

export class AdditionalCostEvidence1726800000000 implements MigrationInterface {
  name = 'AdditionalCostEvidence1726800000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE additional_cost_requests
        ADD COLUMN evidence_urls jsonb;
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE additional_cost_requests
        DROP COLUMN evidence_urls;
    `);
  }
}
