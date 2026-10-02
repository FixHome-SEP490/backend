import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carry the customer's assistant conversation into the booking, and let the
 * system send the technician's first message on their behalf.
 *
 * - ai_chat_sessions: running summary per AI session id, written by the backend
 *   from the replies it proxies.
 * - bookings.ai_summary: frozen copy taken when a booking is created from a
 *   session. Nullable; every existing booking simply has none.
 * - messages.is_automated: marks the greeting sent on accept so clients can
 *   label it. Existing messages were all typed by people, hence false.
 */
export class AiChatSessionsAndAutomatedMessages1790000000024 implements MigrationInterface {
  name = 'AiChatSessionsAndAutomatedMessages1790000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_chat_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "session_id" varchar(128) NOT NULL,
        "customer_id" uuid NULL REFERENCES "users"("id") ON DELETE SET NULL,
        "summary" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_ai_chat_sessions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "ux_ai_chat_sessions_session" ON "ai_chat_sessions" ("session_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "ix_ai_chat_sessions_customer" ON "ai_chat_sessions" ("customer_id")`);
    await queryRunner.query(`ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "ai_summary" jsonb NULL`);
    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "is_automated" boolean NOT NULL DEFAULT false`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN IF EXISTS "is_automated"`);
    await queryRunner.query(`ALTER TABLE "bookings" DROP COLUMN IF EXISTS "ai_summary"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_ai_chat_sessions_customer"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_ai_chat_sessions_session"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_chat_sessions"`);
  }
}
