import { MigrationInterface, QueryRunner } from 'typeorm';

export class TechnicianRoleEnhancements1725900000000 implements MigrationInterface {
  name = 'TechnicianRoleEnhancements1725900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create part_catalog table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "part_catalog" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "code" varchar(50) NOT NULL UNIQUE,
        "name" varchar(255) NOT NULL,
        "service_id" uuid REFERENCES "services"("id") ON DELETE SET NULL,
        "price" numeric(12, 2) NOT NULL,
        "warranty_days" int NOT NULL DEFAULT 90,
        "warranty_policy" varchar(255) NOT NULL DEFAULT 'Bảo hành chính hãng FixHome',
        "description" text,
        "is_active" boolean NOT NULL DEFAULT true
      );
      CREATE INDEX IF NOT EXISTS "idx_part_catalog_code" ON "part_catalog"("code");
      CREATE INDEX IF NOT EXISTS "idx_part_catalog_service_id" ON "part_catalog"("service_id");
    `);

    // 2. Create notifications table
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notifications" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "title" varchar(255) NOT NULL,
        "message" text NOT NULL,
        "type" varchar(50) NOT NULL DEFAULT 'INFO',
        "reference_id" uuid,
        "reference_type" varchar(50),
        "is_read" boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS "idx_notifications_user_id" ON "notifications"("user_id");
      CREATE INDEX IF NOT EXISTS "idx_notifications_user_unread" ON "notifications"("user_id", "is_read");
    `);

    // 3. Create conversations and chat_messages tables
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

    // 4. Seed standard FixHome parts
    await queryRunner.query(`
      INSERT INTO "part_catalog" ("code", "name", "price", "warranty_days", "warranty_policy", "description", "is_active")
      VALUES
        ('PART-AC-CAP-01', 'Tụ ngậm điều hòa 35uF/450V Daikin/Panasonic', 180000, 180, 'Bảo hành 1 đổi 1 chính hãng FixHome trong 6 tháng', 'Tụ ngậm khởi động block máy nén điều hòa inverter/mono', true),
        ('PART-AC-GAS-R32', 'Nạp bổ sung Gas R32 chuẩn Nhật (gói 1 máy)', 250000, 90, 'Bảo hành áp suất gas FixHome 90 ngày', 'Gas làm lạnh R32 độ tinh khiết cao', true),
        ('PART-AC-PIPE-01', 'Ống đồng dẫn gas Thái Lan 6.1/9.5 kèm bảo ôn (1 mét)', 160000, 365, 'Bảo hành đường ống chống rò rỉ 1 năm', 'Ống đồng nguyên chất chịu áp suất cao', true),
        ('PART-WM-VALVE-01', 'Van cấp nước đôi máy giặt lồng ngang', 220000, 180, 'Bảo hành van điện từ 6 tháng', 'Van cấp nước chống tràn cho máy giặt LG/Electrolux', true),
        ('PART-WM-BELT-01', 'Dây curoa chịu lực truyền động máy giặt', 120000, 180, 'Bảo hành 6 tháng', 'Dây curoa cao su tổng hợp chịu nhiệt', true),
        ('PART-PLUMB-VALVE', 'Van khóa nước tổng Inox 304 phi 21/27', 150000, 365, 'Bảo hành chống rò rỉ 1 năm', 'Van bi đồng mạ niken tay gạt inox', true),
        ('PART-ELEC-CB-01', 'Aptomat chống rò chống giật RCBO Panasonic 32A', 350000, 365, 'Bảo hành chính hãng 1 năm', 'Cầu dao tự động an toàn gia đình', true)
      ON CONFLICT ("code") DO NOTHING;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_messages";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "conversations";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notifications";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "part_catalog";`);
  }
}
