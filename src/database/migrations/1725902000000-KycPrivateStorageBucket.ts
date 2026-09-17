import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Registers the private Supabase Storage bucket that KycStorageService reads
 * from (SUPABASE_KYC_BUCKET, default 'kyc-private'). Guarded on the
 * `storage.buckets` table existing: local/CI Postgres (plain postgres:16
 * image, see docker-compose.yml) has no Supabase Storage schema, so this is a
 * no-op there. Only a real Supabase project is expected to have the bucket
 * actually created.
 */
export class KycPrivateStorageBucket1725902000000
  implements MigrationInterface
{
  name = 'KycPrivateStorageBucket1725902000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'storage' AND table_name = 'buckets'
        ) THEN
          INSERT INTO storage.buckets
            ("id", "name", "public", "file_size_limit", "allowed_mime_types")
          VALUES (
            'kyc-private',
            'kyc-private',
            false,
            10485760,
            ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
          )
          ON CONFLICT ("id") DO NOTHING;
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [bucketExists] = await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'storage' AND table_name = 'buckets'
      ) AS "exists"
    `);
    if (!bucketExists?.exists) return;

    const [objectsInBucket] = await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM storage.objects
      WHERE bucket_id = 'kyc-private'
    `);
    if (Number(objectsInBucket?.count) > 0) {
      throw new Error(
        'Refusing to drop the kyc-private bucket because it still holds objects',
      );
    }

    await queryRunner.query(
      `DELETE FROM storage.buckets WHERE "id" = 'kyc-private'`,
    );
  }
}
