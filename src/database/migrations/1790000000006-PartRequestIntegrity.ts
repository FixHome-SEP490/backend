import { MigrationInterface, QueryRunner } from 'typeorm';

export class PartRequestIntegrity1790000000006 implements MigrationInterface {
  name = 'PartRequestIntegrity1790000000006';

  async up(runner: QueryRunner): Promise<void> {
    // Fail on inconsistent historical data rather than silently deleting or repricing it.
    await runner.query(`
      ALTER TABLE invoices ADD COLUMN shipping_fee BIGINT NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0);
      ALTER TABLE part_requests
        ADD CONSTRAINT fk_pr_order FOREIGN KEY (service_order_id) REFERENCES service_orders(id),
        ADD CONSTRAINT fk_pr_technician FOREIGN KEY (technician_id) REFERENCES users(id),
        ADD CONSTRAINT fk_pr_cost FOREIGN KEY (additional_cost_id) REFERENCES additional_cost_requests(id),
        ADD CONSTRAINT fk_pr_preparer FOREIGN KEY (prepared_by_user_id) REFERENCES users(id),
        ADD CONSTRAINT ck_pr_shipping CHECK (shipping_fee >= 0),
        ADD CONSTRAINT ck_pr_cost_source CHECK ((request_type = 'additional' AND additional_cost_id IS NOT NULL) OR (request_type = 'pre_repair' AND additional_cost_id IS NULL));
      ALTER TABLE part_request_items
        ADD CONSTRAINT fk_pr_item_catalog FOREIGN KEY (part_catalog_id) REFERENCES fixhome_parts(id),
        ADD CONSTRAINT ck_pr_item_quantity CHECK (quantity > 0),
        ADD CONSTRAINT ck_pr_item_price CHECK (unit_price_snapshot >= 0),
        ADD CONSTRAINT ck_pr_item_catalog CHECK (part_source <> 'fixhome' OR part_catalog_id IS NOT NULL);
      CREATE UNIQUE INDEX ux_pr_active_pre_repair ON part_requests(service_order_id)
        WHERE request_type = 'pre_repair' AND status <> 'cancelled';
      CREATE UNIQUE INDEX ux_pr_additional_cost ON part_requests(additional_cost_id) WHERE additional_cost_id IS NOT NULL;
      CREATE INDEX ix_pr_created ON part_requests(created_at);
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE invoices DROP COLUMN shipping_fee;
      DROP INDEX ix_pr_created;
      DROP INDEX ux_pr_additional_cost;
      DROP INDEX ux_pr_active_pre_repair;
      ALTER TABLE part_request_items DROP CONSTRAINT ck_pr_item_catalog, DROP CONSTRAINT ck_pr_item_price,
        DROP CONSTRAINT ck_pr_item_quantity, DROP CONSTRAINT fk_pr_item_catalog;
      ALTER TABLE part_requests DROP CONSTRAINT ck_pr_cost_source, DROP CONSTRAINT ck_pr_shipping,
        DROP CONSTRAINT fk_pr_preparer, DROP CONSTRAINT fk_pr_cost, DROP CONSTRAINT fk_pr_technician, DROP CONSTRAINT fk_pr_order;
    `);
  }
}
