import { MigrationInterface, QueryRunner } from 'typeorm';

/** Upper bound for NEW W3 shipping quotes; never a price or financial switch. */
export class W3ShippingSafetyCap1793466000013 implements MigrationInterface {
  name = 'W3ShippingSafetyCap1793466000013';

  async up(q: QueryRunner): Promise<void> {
    // No conflict overwrite: an unledgered row must be investigated, never reset.
    await q.query(`INSERT INTO system_configs(key,value,value_type,description,updated_at)
      VALUES ('w3.shipping.max_new_fee_vnd','0','int',
        'Trần phí giao W3 mới (₫); 0 = chặn phí dương mới, không xóa nghĩa vụ phí thực tế hay mở thanh toán.',now())`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DO $$ BEGIN
      PERFORM 1 FROM system_configs WHERE key='w3.shipping.max_new_fee_vnd' FOR UPDATE;
      IF EXISTS(SELECT 1 FROM system_configs WHERE key='w3.shipping.max_new_fee_vnd'
        AND (value IS DISTINCT FROM '0' OR value_type IS DISTINCT FROM 'int' OR updated_by_user_id IS NOT NULL))
        OR EXISTS(SELECT 1 FROM audit_logs WHERE resource_type='system_config'
          AND resource_id='w3.shipping.max_new_fee_vnd')
      THEN RAISE EXCEPTION 'W3 shipping cap has history; use a forward migration'; END IF;
      DELETE FROM system_configs WHERE key='w3.shipping.max_new_fee_vnd';
    END $$`);
  }
}
