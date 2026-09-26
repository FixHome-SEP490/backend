# Đăng nhập Google — hướng dẫn cài cho máy mới

Dành cho người vừa pull repo về và muốn chạy được nút "Đăng nhập với Google".

Cả đội dùng **chung một cặp credentials**. Không ai phải tự tạo project hay khai
báo gì trên Google Cloud Console. Xin giá trị từ người giữ project, điền vào
`.env`, là xong.

## Vì sao không phải khai báo gì trên máy mình

Backend đứng ra làm trung gian: app và web không trực tiếp trao đổi mã với
Google, mà đi qua backend. Google vì thế chỉ cần biết đúng hai địa chỉ cố định,
và hai địa chỉ đó giống hệt nhau trên mọi máy vì ai cũng chạy `localhost`:

```
Authorized JavaScript origins :  http://localhost:5173
Authorized redirect URIs      :  http://localhost:3000/api/v1/auth/google/callback
```

Nếu làm theo cách thông thường là nhúng SDK Google thẳng vào app Android thì mỗi
máy lập trình viên lại phải khai vân tay SHA-1 của keystore debug riêng của mình
lên Console. Cách hiện tại tránh hẳn chuyện đó.

## Việc phải làm

### 1. Backend

Thêm bốn dòng vào `backend/.env`. Hai giá trị đầu xin từ người giữ project, hai
dòng sau chép nguyên văn:

```
GOOGLE_CLIENT_ID=<xin tu nguoi giu project>
GOOGLE_CLIENT_SECRET=<xin tu nguoi giu project>
GOOGLE_CALLBACK_URL=http://localhost:3000/api/v1/auth/google/callback
GOOGLE_ALLOWED_APP_REDIRECTS=exp://,fixhome://,http://localhost:5173,http://localhost:8081
```

`GOOGLE_CLIENT_SECRET` chỉ backend giữ. Gửi nhau qua tin nhắn riêng, không đẩy
lên git. `.env` đã nằm trong `.gitignore` của cả ba repo.

Backend phải chạy đúng **cổng 3000**, vì đó là cổng ghi trong địa chỉ đã khai với
Google. Đổi cổng là hỏng.

Bỏ trống hai giá trị đầu cũng không sao: backend vẫn khởi động bình thường, chỉ
các endpoint `/auth/google` trả 503 kèm lời nhắc.

### 2. Web

Thêm một dòng vào `web/.env`:

```
VITE_GOOGLE_CLIENT_ID=<cung Client ID voi backend>
```

Giá trị này công khai — nó nằm trong bundle mà trình duyệt tải về, ai xem mã
nguồn trang cũng thấy. Không sao cả. Nhưng Client Secret thì tuyệt đối không đặt
ở đây.

Bỏ trống thì nút Google tự ẩn đi, thay vì hiện một nút bấm vào không có gì xảy
ra.

Web phải chạy đúng **cổng 5173**.

### 3. Mobile

Không cần gì cả. App chỉ mở trình duyệt trỏ vào backend.

Riêng khi test trên **emulator Android** thì chạy thêm một lệnh:

```
adb reverse tcp:3000 tcp:3000
```

Lý do: sau khi người dùng đăng nhập, Google chuyển trình duyệt về
`http://localhost:3000/...` — mà `localhost` bên trong emulator là chính
emulator chứ không phải máy thật. Lệnh trên bắc cầu cổng 3000 sang máy thật.
Không chạy thì màn hình Google vẫn hiện bình thường nhưng bước quay về báo không
kết nối được. (Expo đã tự làm điều tương tự cho cổng 8081, riêng 3000 phải tự
chạy.)

### 4. Cơ sở dữ liệu

Không phải làm gì. Migration `1790000000007-GoogleSignIn` đã chạy trên Supabase,
mà cả đội dùng chung một database, nên các cột `google_id`, `auth_provider` và
việc `password_hash` nhận NULL đã có sẵn.

## Ai được phép đăng nhập

Chuyện này do cấu hình trên Console quyết định, không phải do máy của bạn.

Mở **APIs & Services → OAuth consent screen**, nhìn hai dòng:

**User type** — nếu là `Internal` thì chỉ tài khoản thuộc tổ chức sở hữu project
đăng nhập được, Gmail cá nhân sẽ bị từ chối. Nếu là `External` thì mọi tài khoản
Google đều dùng được, tuỳ trạng thái bên dưới.

**Publishing status** — `Testing` nghĩa là chỉ những Gmail nằm trong danh sách
Test users mới vào được, tối đa 100 người. `In production` nghĩa là ai cũng vào
được.

Muốn cả nhóm và người chấm bài đều đăng nhập được bằng Gmail bất kỳ thì để
`External` rồi bấm **Publish app**. Phạm vi đang xin chỉ gồm `openid`, `email`
và `profile`, đều thuộc loại không nhạy cảm, nên Publish không cần Google xét
duyệt.

## Tài khoản Google đăng nhập vào thì thành gì

Vai trò luôn là **Customer**, đúng luật tự đăng ký hiện hành — tài khoản
Technician do Service Manager hoặc Admin tạo.

Nếu email đó **đã có tài khoản mật khẩu** trong hệ thống thì hai tài khoản được
**tự động gộp làm một**: gắn thêm `google_id` vào tài khoản cũ, giữ nguyên mật
khẩu cũ. Sau đó đăng nhập bằng cách nào cũng được. Quyết định này do PO chốt
ngày 26/09/2026.

Nếu email chưa có thì tạo tài khoản mới, không mật khẩu, kích hoạt luôn — không
phải nhập OTP vì Google đã xác minh email rồi.

Tài khoản chỉ có Google mà lỡ bấm đăng nhập bằng mật khẩu sẽ nhận thông báo nhắc
bấm nút Google, chứ không phải câu "sai mật khẩu" khó hiểu. Muốn đặt thêm mật
khẩu thì dùng chức năng Quên mật khẩu như bình thường.

## Khi gặp lỗi

`origin_mismatch` trên web — ô Authorized JavaScript origins trên Console thiếu
`http://localhost:5173`, hoặc web đang chạy cổng khác 5173.

`redirect_uri_mismatch` — ô Authorized redirect URIs thiếu đúng chuỗi
`http://localhost:3000/api/v1/auth/google/callback`, hoặc backend chạy cổng khác
3000.

Trên emulator, màn hình Google hiện ra bình thường nhưng bấm xong thì báo không
kết nối được — chưa chạy `adb reverse tcp:3000 tcp:3000`.

Endpoint `/auth/google` trả 503 — `.env` của backend chưa có
`GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET`.

Đăng nhập bị từ chối dù cấu hình đúng — tài khoản đó chưa nằm trong Test users
và app vẫn ở trạng thái Testing, hoặc app đang là Internal mà tài khoản không
thuộc tổ chức.
