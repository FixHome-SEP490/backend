import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chỗ ngồi cho tài khoản đăng nhập bằng Google.
 *
 * Ba thay đổi, mỗi cái có lý do riêng:
 *
 * `password_hash` phải nhận NULL, vì tài khoản tạo ra từ Google không hề có mật
 * khẩu. Trước đây cột này NOT NULL nên không có cách nào ghi một tài khoản như
 * vậy mà không bịa ra một chuỗi băm giả — và chuỗi giả đó sẽ là một mật khẩu
 * thật sự dùng được nếu ai đó đoán ra cách sinh nó.
 *
 * `google_id` giữ `sub` của Google, thứ định danh không bao giờ đổi kể cả khi
 * người dùng đổi địa chỉ Gmail. Ràng buộc duy nhất chỉ áp cho hàng có giá trị,
 * nên vô số tài khoản thường vẫn để NULL được.
 *
 * `auth_provider` trả lời câu "tài khoản này có mật khẩu không". Tài khoản đăng
 * ký bằng mật khẩu rồi sau đó liên kết Google vẫn giữ 'local' vì mật khẩu cũ
 * còn dùng được.
 */
export class GoogleSignIn1790000000007 implements MigrationInterface {
  name = 'GoogleSignIn1790000000007';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
      ALTER TABLE users ADD COLUMN google_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN auth_provider VARCHAR(20) NOT NULL DEFAULT 'local';
      ALTER TABLE users ADD CONSTRAINT ck_users_auth_provider
        CHECK (auth_provider IN ('local', 'google'));
      -- Tài khoản 'local' bắt buộc phải có mật khẩu; tài khoản 'google' bắt
      -- buộc phải có google_id. Không có hàng nào được phép không đăng nhập
      -- được bằng cách nào cả.
      ALTER TABLE users ADD CONSTRAINT ck_users_credential_present
        CHECK (
          (auth_provider = 'local' AND password_hash IS NOT NULL)
          OR (auth_provider = 'google' AND google_id IS NOT NULL)
        );
      CREATE UNIQUE INDEX ux_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
    `);
  }

  async down(runner: QueryRunner): Promise<void> {
    // Trả lại NOT NULL chỉ an toàn khi không còn tài khoản nào thiếu mật khẩu.
    // Xoá chúng đi thì mất dữ liệu người dùng thật, nên để câu lệnh tự báo lỗi
    // còn hơn âm thầm huỷ tài khoản.
    await runner.query(`
      DROP INDEX ux_users_google_id;
      ALTER TABLE users DROP CONSTRAINT ck_users_credential_present;
      ALTER TABLE users DROP CONSTRAINT ck_users_auth_provider;
      ALTER TABLE users DROP COLUMN auth_provider;
      ALTER TABLE users DROP COLUMN google_id;
      ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
    `);
  }
}
