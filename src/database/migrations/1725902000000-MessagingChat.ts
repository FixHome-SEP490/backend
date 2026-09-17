import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Booking-scoped Customer <-> Technician chat (spec 8.6 / CHAT-BR-01).
 *
 * The Dev1 tables dropped in 1725901000000 keyed a conversation by booking alone.
 * The spec opens one conversation per invited Technician and turns the losing
 * ones read-only once the Booking is assigned, so the natural key is the
 * (booking, technician) pair.
 */
export class MessagingChat1725902000000 implements MigrationInterface {
  name = 'MessagingChat1725902000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "conversations_status_enum" AS ENUM ('active', 'read_only', 'closed');
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "conversations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
        "customer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "technician_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "service_order_id" uuid NULL REFERENCES "service_orders"("id") ON DELETE SET NULL,
        "status" "conversations_status_enum" NOT NULL DEFAULT 'active',
        "service_name_snapshot" varchar(255) NULL,
        "last_message_at" timestamptz NULL,
        "last_message_preview" varchar(255) NULL,
        "customer_last_read_at" timestamptz NULL,
        "technician_last_read_at" timestamptz NULL,
        CONSTRAINT "uq_conversation_booking_technician" UNIQUE ("booking_id", "technician_id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_conversations_customer"
        ON "conversations" ("customer_id", "last_message_at");
      CREATE INDEX IF NOT EXISTS "ix_conversations_technician"
        ON "conversations" ("technician_id", "last_message_at");
      CREATE INDEX IF NOT EXISTS "ix_conversations_service_order"
        ON "conversations" ("service_order_id");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messages" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
        "sender_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "content" text NOT NULL,
        "edited_at" timestamptz NULL,
        "deleted_at" timestamptz NULL,
        "client_message_id" varchar(64) NULL
      );
    `);

    // Thread paging is always "newest first within one conversation".
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_messages_conversation_created"
        ON "messages" ("conversation_id", "created_at");
      CREATE INDEX IF NOT EXISTS "ix_messages_sender"
        ON "messages" ("sender_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "messages" CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations" CASCADE;`);
    await queryRunner.query(`DROP TYPE IF EXISTS "conversations_status_enum";`);
  }
}
