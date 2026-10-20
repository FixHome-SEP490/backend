# Ca tối — hợp đồng Backend (PO 19/10/2026)

Giờ Việt Nam UTC+7, không phụ thuộc múi giờ máy. Phạm vi chỉ booking và eligibility;
không đổi finance, AI, custody, RBAC hoặc vòng đời ServiceOrder.

- `slot`: `morning` (08:00–12:00), `afternoon` (13:00–18:00),
  `evening` (18:00–23:00). Một kỹ thuật viên tối đa một booking scheduled mỗi
  ngày/buổi, kể cả đơn đã hoàn thành; đơn hủy không chiếm buổi như trước.
- `POST /bookings`, `PATCH /bookings/:id/schedule`, `POST /bookings/:id/rebook`
  cùng dùng `date: YYYY-MM-DD`, `mode: scheduled`, `slot: evening`.
  Buổi tối chưa kết thúc có khung đến `[max(now,18:00),23:00)` của ngày đã chọn.
  Sáng/chiều vẫn từ chối khi buổi đã bắt đầu. Legacy explicit window giữ validation cũ.
- `GET /bookings/:id/available-slots` (kể cả `previous=1`) dùng cùng phép tính;
  22:59 vẫn có thể trả evening hôm nay, 23:00 không còn evening hôm nay.
  Có kỹ thuật viên thì kiểm lịch tuần, nghỉ và buổi đã nhận như trước.
- DTO create/schedule/rebook chấp nhận evening; Booking, chi tiết đơn và lời mời
  trả `slot`, `bookingMode`, `preferredStartAt`/`preferredEndAt` theo shape sẵn có.
  `available-slots` có nhãn `Buổi tối (18:00 - 23:00)`.

| Thời điểm gửi (VN) | Yêu cầu | Khung đến |
| --- | --- | --- |
| 20/10/2026 17:59 | evening 20/10 | 18:00–23:00 ngày 20/10 |
| 20/10/2026 22:59 | evening 20/10 | 22:59–23:00 ngày 20/10 |
| 20/10/2026 23:00 | evening 20/10 | Từ chối, buổi đã kết thúc |
| 20/10/2026 23:00 | urgent, cấu hình 120 phút | 23:00 ngày 20/10–01:00 ngày 21/10 |
| 21/10/2026 00:15 | evening 20/10 | Từ chối, buổi đã kết thúc |
| 21/10/2026 00:15 | urgent, cấu hình 120 phút | 00:15–02:15 ngày 21/10 |

Đây là khung **có thể đến**, không phải thời lượng sửa hay cam kết sửa xong lúc
23:00. Lịch tuần 18:00–02:00 được xét cả phần sau nửa đêm theo ngày bắt đầu ca;
lịch kết thúc đúng 23:00 không mở khả năng đến sau 23:00. Chỉ cần một phần khung
đến giao lịch làm việc theo helper hiện có; không hứa kỹ thuật viên làm cả khung.
Nghỉ có giao khung vẫn chặn theo quy tắc hiện tại.

EN_ROUTE/UNDER_REPAIR luôn chặn urgent, dù khung đến của đơn cũ đã hết hoặc khác
ngày/buổi. Cũng chặn lịch scheduled bắt đầu ngay khi còn đang thực hiện đơn khác.
ACCEPTED scheduled ngày mai không tự khóa urgent tối nay hay các buổi tương lai
khác. Với cuộc hẹn tương lai, giữ kiểm tra theo buổi; không ngoại suy trạng thái
đang sửa hôm nay thành bận vô hạn hoặc đoán giờ sửa xong. Matching/Accept kiểm
lại eligibility; kết quả available-slots không đặt chỗ hoặc bảo đảm nhận đơn.

Migration mới duy nhất: `1790000000041-BookingEveningSession.ts`, class/name
`BookingEveningSession1790000000041`, sau #0040. Chỉ thay CHECK
`CHK_bookings_slot`, giữ `NULL` và các constraint khác. `down` thay CHECK trong
một lệnh atomic, sẽ thất bại nếu có dữ liệu evening; không xóa hoặc đổi slot
để ép rollback. Không sửa migration đã phát hành.

Chưa chạy migration hoặc ghi DB trong task này. PostgreSQL/E2E, Docker runtime,
Web/Mobile parity: **NOT VERIFIED**. Các consumer cần hỗ trợ enum/nhãn/buổi còn
lại trong PR riêng. Khi phát hành được phép, migrate trước rồi restart backend;
không khởi động code mới trên schema còn CHECK hai buổi.
