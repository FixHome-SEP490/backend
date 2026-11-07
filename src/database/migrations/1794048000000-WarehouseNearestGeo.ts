import { MigrationInterface, QueryRunner } from 'typeorm';

/** Additive W2 geo coordinates; no changes to historic allocations or stock journals. */
export class WarehouseNearestGeo1794048000000 implements MigrationInterface {
  name = 'WarehouseNearestGeo1794048000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE warehouses
      ADD COLUMN latitude numeric(10,7),
      ADD COLUMN longitude numeric(10,7),
      ADD CONSTRAINT chk_warehouse_coordinates
      CHECK (
        (latitude IS NULL AND longitude IS NULL) OR
        (latitude IS NOT NULL AND longitude IS NOT NULL
          AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    const [{ count }] = await q.query('SELECT count(*)::integer AS count FROM warehouses WHERE latitude IS NOT NULL OR longitude IS NOT NULL');
    if (Number(count) > 0) throw new Error('Refusing to discard warehouse coordinates in use');
    await q.query('ALTER TABLE warehouses DROP CONSTRAINT chk_warehouse_coordinates, DROP COLUMN latitude, DROP COLUMN longitude');
  }
}
