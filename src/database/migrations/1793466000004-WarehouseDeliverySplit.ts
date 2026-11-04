import { MigrationInterface, QueryRunner } from 'typeorm';

/** Snapshot preparation only. NO W3 enrollment, historical money backfill or ENV activation. */
export class WarehouseDeliverySplit1793466000004 implements MigrationInterface {
  name = 'WarehouseDeliverySplit1793466000004';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE invoices
        ADD COLUMN shipping_policy_version varchar(24) NOT NULL DEFAULT 'LEGACY_100_0',
        ADD COLUMN customer_shipping_share bigint,
        ADD COLUMN technician_shipping_share bigint,
        ADD CONSTRAINT ck_invoice_shipping_policy CHECK (shipping_policy_version IN ('LEGACY_100_0','W3_70_30_V1')),
        ADD CONSTRAINT ck_invoice_shipping_cutover_closed CHECK (shipping_policy_version = 'LEGACY_100_0'),
        ADD CONSTRAINT ck_invoice_shipping_shares CHECK (
          (shipping_policy_version = 'LEGACY_100_0' AND customer_shipping_share IS NULL AND technician_shipping_share IS NULL)
          OR (customer_shipping_share IS NOT NULL AND technician_shipping_share IS NOT NULL
            AND shipping_fee BETWEEN 0 AND 9007199254740991
            AND customer_shipping_share >= 0 AND technician_shipping_share >= 0
            AND customer_shipping_share <= shipping_fee AND technician_shipping_share <= shipping_fee
            AND customer_shipping_share::numeric + technician_shipping_share::numeric = shipping_fee::numeric
            AND ((shipping_policy_version = 'LEGACY_100_0' AND customer_shipping_share = shipping_fee AND technician_shipping_share = 0)
              OR (shipping_policy_version = 'W3_70_30_V1' AND customer_shipping_share::numeric = floor((shipping_fee::numeric * 7 + 5) / 10)))))
      ;
      CREATE FUNCTION protect_invoice_financial_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'Invoice financial history cannot be deleted';
        END IF;
        IF ROW(NEW.service_order_id, NEW.labor_total, NEW.parts_total, NEW.fixhome_parts_total,
          NEW.technician_parts_total, NEW.technician_part_warranty_fee_total, NEW.shipping_fee,
          NEW.grand_total, NEW.commission_base, NEW.commission_rate_snapshot, NEW.commission_amount,
          NEW.shipping_policy_version, NEW.customer_shipping_share, NEW.technician_shipping_share)
          IS DISTINCT FROM ROW(OLD.service_order_id, OLD.labor_total, OLD.parts_total, OLD.fixhome_parts_total,
          OLD.technician_parts_total, OLD.technician_part_warranty_fee_total, OLD.shipping_fee,
          OLD.grand_total, OLD.commission_base, OLD.commission_rate_snapshot, OLD.commission_amount,
          OLD.shipping_policy_version, OLD.customer_shipping_share, OLD.technician_shipping_share) THEN
          RAISE EXCEPTION 'Invoice financial snapshot is immutable';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER protect_invoice_financial_snapshot BEFORE UPDATE OR DELETE ON invoices
        FOR EACH ROW EXECUTE FUNCTION protect_invoice_financial_snapshot();
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    // Refuse destructive schema downgrade once any explicit snapshot has been written.
    await q.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM invoices WHERE
      shipping_policy_version <> 'LEGACY_100_0' OR customer_shipping_share IS NOT NULL OR technician_shipping_share IS NOT NULL)
      THEN RAISE EXCEPTION 'Refusing to discard shipping financial snapshots'; END IF; END $$`);
    await q.query(`DROP TRIGGER protect_invoice_financial_snapshot ON invoices;
      DROP FUNCTION protect_invoice_financial_snapshot();
      ALTER TABLE invoices DROP CONSTRAINT ck_invoice_shipping_shares,
        DROP CONSTRAINT ck_invoice_shipping_cutover_closed, DROP CONSTRAINT ck_invoice_shipping_policy,
        DROP COLUMN technician_shipping_share, DROP COLUMN customer_shipping_share, DROP COLUMN shipping_policy_version;`);
  }
}
