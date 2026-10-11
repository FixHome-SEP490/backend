# Đợt tạo 30 kỹ thuật viên kiểm thử — 02/10/2026

## Kết quả

- Task: thêm 30 Technician phục vụ kiểm thử, giữ nguyên dữ liệu cũ.
- Repository: Backend-FixHome; nhánh `hoang_win`, commit nền `080a742`.
- Batch: `technicians-hcm-20261002-30`.
- Số thứ tự lớn nhất trước khi tạo: **12**. Đã tạo **tech13@fixhome.vn–tech42@fixhome.vn**.
- Đã đọc lại sau commit và chạy lại seed: trả `already-applied`, không thêm tài khoản.
- Cả 30 tài khoản: active, email verified, KYC verified, onboarding approved bước 5.
- 30 ví, mỗi ví **200.000 ₫**, tổng **6.000.000 ₫**; mỗi ví có một giao dịch ADJUSTMENT từ 0 và audit log.
- 204 skill đã duyệt, bao phủ toàn bộ 34 dịch vụ đang hoạt động. Không hard-code ID dịch vụ/danh mục/Admin.
- 30 phường và 30 điểm GPS khác nhau; địa chỉ mặc định và hồ sơ dùng cùng tọa độ. Mã phường được tra từ `service_areas` hiện có.
- Lịch làm việc 07:00–22:00, đủ 7 ngày/tuần, bán kính 10 km, sẵn sàng nhận việc.
- 30 tệp mẫu KYC trong kho riêng đã upload và đọc lại đúng nội dung. Mỗi tài khoản dùng một ảnh mẫu chung cho ba loại tài liệu danh tính và các chứng chỉ skill.

Đây là dữ liệu giả phục vụ kiểm thử. Ảnh ghi rõ không phải giấy tờ/chứng chỉ thật; CCCD dùng tiền tố giả `999`. GPS là điểm mô phỏng trong TP.HCM, không phải địa chỉ cư trú đã khảo sát. Mật khẩu được truyền qua biến môi trường khi chạy và bàn giao riêng, không lưu trong mã nguồn/báo cáo.

## Phân bổ

| Nhóm dịch vụ | Số dịch vụ | Số kỹ thuật viên | Skill được duyệt |
| --- | ---: | ---: | ---: |
| Thiết bị nhà bếp | 4 | 6 | 24 |
| Điện lạnh | 13 | 6 | 78 |
| Điện & Nước | 14 | 6 | 84 |
| Khác | 1 | 6 | 6 |
| Cửa & Khóa thông minh | 2 | 6 | 12 |

Mỗi người cung cấp toàn bộ dịch vụ trong nhóm được phân bổ. Xoay nhóm giữa các cụm vị trí để mỗi ngành có người ở nhiều phía thành phố.

## Triển khai và cách dùng

File thay đổi:

- `package.json`: lệnh `seed:technicians:test`.
- `src/database/seeds/seed-test-technicians.ts`: xem trước, seed chỉ thêm dữ liệu, kiểm tra và chống chạy lại cùng batch.
- `src/database/seeds/fixtures/technician-test-document.png`: ảnh mẫu giả có nhãn rõ ràng.
- `test/seeds/seed-test-technicians.spec.ts`: số thứ tự, giới hạn số, phân bổ, tọa độ.
- Tài liệu này: kết quả và giới hạn kiểm tra.

```powershell
# Xem trước khi batch chưa tồn tại; khi đã tồn tại thì kiểm tra batch cũ.
npm.cmd run seed:technicians:test

# Chỉ đọc và kiểm tra dữ liệu đã tạo.
npm.cmd run seed:technicians:test -- --verify

# Chỉ dùng cho lần áp dụng đầu trên database được chỉ định trong .env.
# SEED_TECHNICIAN_PASSWORD phải được đặt trong môi trường, không ghi vào source.
npm.cmd run seed:technicians:test -- --apply
```

Không gọi `seed:demo`: seed tổng có thao tác cập nhật tài khoản và xóa khu vực cũ. Seed mới chỉ INSERT, không chạy migration hoặc synchronize. Transaction `REPEATABLE READ` và advisory lock bảo vệ batch; lỗi trước commit rollback toàn bộ bản ghi database mới. Unique/FK của database vẫn được áp dụng. So sánh digest từng bản ghi cũ ở 12 bảng liên quan đã xác nhận không đổi trong transaction.

Storage không nằm trong transaction PostgreSQL. Nếu một lần chạy tương lai thất bại sau upload, tệp mới có thể còn trong kho riêng; script không xóa tệp, không ghi đè đường dẫn cũ. Batch này đã hoàn tất và mọi tệp đều có hồ sơ tham chiếu.

## Review

Đây là các góc nhìn tự review, không phải nhiều người/agent độc lập.

| Góc nhìn | Kết quả review |
| --- | --- |
| BA/PM | Đủ 30 tài khoản, cân bằng 5 ngành, bao phủ 34 dịch vụ, ví đúng số tiền yêu cầu. |
| CTO/Tech Lead | Giữ ranh giới backend, dùng TypeORM/entity/enum và database hiện có; không đổi API, RBAC, schema hoặc nghiệp vụ. |
| Senior Developer | Tra ID động, bcrypt cost 12, transaction, marker chống tạo lại, kiểm tra trạng thái sau ghi. |
| Security | Không in token/hash/khóa storage; tệp KYC riêng tư; dữ liệu giả; audit ghi rõ syntheticTestFixture và batch. |
| Tester/QA/QC | Đếm và join dữ liệu thật, kiểm tra gần/xa qua technicianEligibility, đăng nhập/JWT/RBAC/onboarding qua service thật. |
| Designer/cross-platform | Đã đọc code Web/Mobile: cả hai nhận approved hoặc verified là đã duyệt. Không đổi UI. Kiểm thử trực quan chưa thực hiện. |
| DevOps | Không thêm dependency, không đổi runtime contract/Docker. Build thành công; môi trường E2E localhost còn thiếu. |

Đã đọc design system canonical Docs v1.0.0 và bản Backend v1.1.0. Hai bản đang lệch phiên bản từ trước; task này không thay đổi quy chuẩn/UI.

## Kiểm tra kỹ thuật

| Kiểm tra | Trạng thái | Bằng chứng |
| --- | --- | --- |
| Tạo và đọc lại đúng 30 tài khoản, email không trùng | PASS | tech13–tech42; lần chạy thứ hai trả already-applied. |
| KYC/onboarding/skill đã duyệt, reviewer Admin hợp lệ | PASS | Join bản ghi duyệt và chứng chỉ; 30 KYC, 204 skill. |
| Ví và lịch sử ví | PASS | 30 × 200.000 ₫; credit ADJUSTMENT 0 → 200.000. |
| GPS/khu vực/lịch làm việc | PASS | 30 phường, 30 tọa độ, 210 lịch làm việc. |
| Điều kiện matching thực tế | PASS | 30 trường hợp gần đủ điều kiện; 30 trường hợp xa bị từ chối đúng lý do. Booking chỉ tạo trong bộ nhớ. |
| Foreign key và giữ nguyên dữ liệu cũ | PASS | Constraint có hiệu lực khi INSERT; SET CONSTRAINTS ALL IMMEDIATE; digest các bản ghi cũ không đổi. |
| KYC private storage | PASS | 30 upload và tải qua signed access, nội dung trùng fixture. |
| Đăng nhập, JWT, RBAC, onboarding | PASS | 30/30 qua AuthService và TechnicianOnboardingService; token kiểm tra trong bộ nhớ, refresh session thử rollback. |
| HealthService / database | PASS | status=ok, database=connected, kiểm tra 16:26 ngày 02/10/2026 giờ Việt Nam. |
| npm run lint | PASS | 0 lỗi; 1 warning có sẵn tại migration ResetUnfundedTechnicianWallets. |
| npm run typecheck | PASS | tsc --noEmit. |
| npm test | PASS | 112 file, 1.036 test; 4 test seed chạy lại sau điều chỉnh phân bổ đều qua. |
| npm run build | PASS | nest build; đã chạy lại trong lệnh E2E. |
| npm run test:e2e | FAIL | Không có PostgreSQL 127.0.0.1:5432; 2 suite lỗi setup, 59 test skipped. Docker daemon cũng chưa chạy. |
| HTTP server đầy đủ / giao diện Web-Mobile | NOT VERIFIED | Chưa có backend HTTP đang chạy tại cổng 3000; chỉ kiểm tra trực tiếp service và đối chiếu code client. |
| git diff --check | PASS | Không lỗi whitespace. |

Issues found / Auto fix: seed tổng không phù hợp yêu cầu chỉ thêm; đã dùng seed riêng. GPS matching lấy ở addresses; đã điền đồng bộ với profile. Xác minh skill là luồng riêng; đã thêm đầy đủ skill verification, chứng chỉ và audit. Phân bổ nhóm được xoay giữa các khu vực.

Remaining issues: cần môi trường PostgreSQL test biệt lập để chạy đủ E2E và server/client đang chạy để kiểm thử HTTP/UI. Không thể kết luận toàn bộ project không có lỗi từ các kiểm tra service và build.

Final status: **hoàn tất tạo và kiểm tra dữ liệu 30 tài khoản**; E2E đầy đủ còn giới hạn môi trường như trên.

## Danh sách tài khoản

| Email | Họ tên | Nhóm dịch vụ | Phường | Latitude | Longitude |
| --- | --- | --- | --- | ---: | ---: |
| tech13@fixhome.vn | Nguyễn Minh An | Thiết bị nhà bếp | Phường Bến Thành | 10.7725000 | 106.6954000 |
| tech14@fixhome.vn | Nguyễn Quốc Bảo | Điện lạnh | Phường Thủ Đức | 10.8506000 | 106.7539000 |
| tech15@fixhome.vn | Nguyễn Thanh Bình | Điện & Nước | Phường Tân Mỹ | 10.7290000 | 106.7175000 |
| tech16@fixhome.vn | Nguyễn Hữu Dũng | Khác | Phường Gò Vấp | 10.8270000 | 106.6845000 |
| tech17@fixhome.vn | Nguyễn Tuấn Khang | Cửa & Khóa thông minh | Phường An Lạc | 10.7300000 | 106.6130000 |
| tech18@fixhome.vn | Trần Minh An | Điện lạnh | Phường Tân Định | 10.7903000 | 106.6890000 |
| tech19@fixhome.vn | Trần Quốc Bảo | Điện & Nước | Phường Hiệp Bình | 10.8390000 | 106.7205000 |
| tech20@fixhome.vn | Trần Thanh Bình | Khác | Phường Tân Hưng | 10.7410000 | 106.7000000 |
| tech21@fixhome.vn | Trần Hữu Dũng | Cửa & Khóa thông minh | Phường Tân Sơn Hoà | 10.8000000 | 106.6655000 |
| tech22@fixhome.vn | Trần Tuấn Khang | Thiết bị nhà bếp | Phường Bình Trị Đông | 10.7560000 | 106.6100000 |
| tech23@fixhome.vn | Lê Minh An | Điện & Nước | Phường Sài Gòn | 10.7795000 | 106.7050000 |
| tech24@fixhome.vn | Lê Quốc Bảo | Khác | Phường Linh Xuân | 10.8790000 | 106.7620000 |
| tech25@fixhome.vn | Lê Thanh Bình | Cửa & Khóa thông minh | Phường Tân Thuận | 10.7500000 | 106.7270000 |
| tech26@fixhome.vn | Lê Hữu Dũng | Thiết bị nhà bếp | Phường Tân Sơn Nhất | 10.8030000 | 106.6500000 |
| tech27@fixhome.vn | Lê Tuấn Khang | Điện lạnh | Phường Phú Lâm | 10.7520000 | 106.6320000 |
| tech28@fixhome.vn | Phạm Minh An | Khác | Phường Cầu Ông Lãnh | 10.7630000 | 106.6930000 |
| tech29@fixhome.vn | Phạm Quốc Bảo | Cửa & Khóa thông minh | Phường An Khánh | 10.7970000 | 106.7330000 |
| tech30@fixhome.vn | Phạm Thanh Bình | Thiết bị nhà bếp | Phường Phú Thuận | 10.7300000 | 106.7410000 |
| tech31@fixhome.vn | Phạm Hữu Dũng | Điện lạnh | Phường Phú Nhuận | 10.7990000 | 106.6810000 |
| tech32@fixhome.vn | Phạm Tuấn Khang | Điện & Nước | Phường Bình Phú | 10.7420000 | 106.6310000 |
| tech33@fixhome.vn | Hoàng Minh An | Cửa & Khóa thông minh | Phường Xuân Hoà | 10.7850000 | 106.6880000 |
| tech34@fixhome.vn | Hoàng Quốc Bảo | Thiết bị nhà bếp | Phường Bình Trưng | 10.7810000 | 106.7700000 |
| tech35@fixhome.vn | Hoàng Thanh Bình | Điện lạnh | Phường Khánh Hội | 10.7570000 | 106.7010000 |
| tech36@fixhome.vn | Hoàng Hữu Dũng | Điện & Nước | Phường Bảy Hiền | 10.7930000 | 106.6510000 |
| tech37@fixhome.vn | Hoàng Tuấn Khang | Khác | Phường Chợ Lớn | 10.7510000 | 106.6550000 |
| tech38@fixhome.vn | Võ Minh An | Thiết bị nhà bếp | Phường Bàn Cờ | 10.7700000 | 106.6790000 |
| tech39@fixhome.vn | Võ Quốc Bảo | Điện lạnh | Phường Phước Long | 10.8230000 | 106.7750000 |
| tech40@fixhome.vn | Võ Thanh Bình | Điện & Nước | Phường Vĩnh Hội | 10.7580000 | 106.6920000 |
| tech41@fixhome.vn | Võ Hữu Dũng | Khác | Phường Bình Thạnh | 10.8110000 | 106.7040000 |
| tech42@fixhome.vn | Võ Tuấn Khang | Cửa & Khóa thông minh | Phường An Đông | 10.7560000 | 106.6690000 |
