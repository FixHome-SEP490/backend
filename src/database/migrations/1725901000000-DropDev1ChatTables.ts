import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropDev1ChatTables1725901000000 implements MigrationInterface {
  name = 'DropDev1ChatTables1725901000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Safely drop Customer <-> Technician chat tables out of Dev1 scope
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_messages" CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations" CASCADE;`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate empty tables if rolled back
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "conversations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "booking_id" uuid NOT NULL UNIQUE
      );
      CREATE INDEX IF NOT EXISTS "idx_conversations_booking_id" ON "conversations"("booking_id");

      CREATE TABLE IF NOT EXISTS "chat_messages" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        "sender_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "content" text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_chat_messages_conversation_id" ON "chat_messages"("conversation_id");
    `);
  }
}
