import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PO 01/11/2026 (duyệt audit AI): trạng thái chẩn đoán của cuộc trò chuyện với trợ lý lưu ở đây,
 * không chỉ trong bộ nhớ ai-service. `ai_chat_sessions` giữ bản mới nhất (`diagnostic_state`,
 * `state_version`, chỉ ghi đè bằng bản có version lớn hơn); `ai_chat_turns` ghi từng lượt để chống
 * xử lý trùng một tin nhắn (`client_message_id`) và để đo (độ trễ, model, phiên bản kho tri thức).
 * Chỉ thêm, không đổi cột cũ: rollback là bỏ cột và bảng, hành vi trở về như trước.
 */
export class AiDiagnosticState1793379600000 implements MigrationInterface {
  name = 'AiDiagnosticState1793379600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_chat_sessions"
        ADD COLUMN IF NOT EXISTS "diagnostic_state" jsonb,
        ADD COLUMN IF NOT EXISTS "state_version" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_chat_turns" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "session_id" varchar(128) NOT NULL,
        "client_message_id" varchar(64),
        "route" varchar(16) NOT NULL,
        "status" varchar(32) NOT NULL,
        "state_version" integer,
        "latency_ms" integer,
        "model" varchar(160),
        "kb_version" varchar(40),
        "response" jsonb,
        CONSTRAINT "pk_ai_chat_turns" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_ai_chat_turns_message"
        ON "ai_chat_turns" ("session_id", "client_message_id")
        WHERE "client_message_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_ai_chat_turns_session_created" ON "ai_chat_turns" ("session_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_chat_turns"`);
    await queryRunner.query(`
      ALTER TABLE "ai_chat_sessions"
        DROP COLUMN IF EXISTS "state_version",
        DROP COLUMN IF EXISTS "diagnostic_state"
    `);
  }
}
