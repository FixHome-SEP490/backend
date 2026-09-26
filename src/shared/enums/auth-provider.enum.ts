// src/shared/enums/auth-provider.enum.ts
//
// Cách một tài khoản chứng minh danh tính.
//
// LOCAL: có mật khẩu do người dùng đặt, băm bằng bcrypt.
// GOOGLE: không có mật khẩu, danh tính do Google xác nhận.
//
// Một tài khoản đăng ký bằng mật khẩu rồi sau đó đăng nhập Google bằng cùng
// email thì vẫn giữ LOCAL và được gắn thêm google_id, vì mật khẩu cũ vẫn dùng
// được. Cột này trả lời câu "tài khoản này có mật khẩu không", không phải câu
// "lần đăng nhập gần nhất bằng gì".
export enum AuthProvider {
  LOCAL = 'local',
  GOOGLE = 'google',
}
