# FIXHOME - BÁO CÁO THIẾT KẾ & TRIỂN KHAI TOÀN DIỆN
## QUY TRÌNH LINH KIỆN VÀ SỬA CHỮA (FLOW 1 & FLOW 2)

Xem tài liệu đầy đủ tại [PARTS_REPAIR_FLOW_IMPLEMENTATION.md](file:///d:/SEP490%28%20d%E1%BB%B1%20%C3%A1n/SEP490/Docs-FixHome/docs/PARTS_REPAIR_FLOW_IMPLEMENTATION.md) trong thư mục `Docs-FixHome/docs/`.

### Tóm tắt kết quả triển khai:
- **Backend (`Backend-FixHome`):**
  - Đã thêm module `PartRequestsModule` (`part-requests.service.ts`, `part-requests.controller.ts`, state machine, DTOs, entities).
  - Tích hợp vào `QuotationsModule` cho phép nguồn linh kiện `EXTERNAL` và tự động sinh `PartRequest` khi khách duyệt chi phí phát sinh với linh kiện FixHome.
  - Hỗ trợ phương thức bàn giao `PICKUP` / `DELIVERY`, phí giao hàng `shippingFee`.
  - Sinh và xác thực mã QR token bàn giao (thời hạn 48 giờ, xác thực quyền sở hữu thợ).
  - Cập nhật trạng thái linh kiện `USED` / `RETURNED` (chỉ tính tiền linh kiện `USED`).
  - Migration database: `1790000000005-PartRequestsAndLifecycle.ts`.
  - Build NestJS: **PASS (Exit 0)**.
  - Unit tests: **14/14 PASS (100%)**.

- **Frontend (`Frontend-FixHome`):**
  - Thêm API clients: `part-requests.api.ts`, `parts-catalog.api.ts`, cập nhật `orders.api.ts`.
  - Thêm component `TechnicianPartsSection.vue` vào trang thợ `TechnicianJobDetailPage.vue`.
  - Nâng cấp form chi phí phát sinh hỗ trợ linh kiện FixHome/Ngoài, chọn giao hàng, nhập ship và cảnh báo bảo hành.
  - Thêm trang quản lý điều phối linh kiện `ConsolePartRequestsPage.vue` (`/console/part-requests`) cho Service Manager & Admin kèm QR Code modal bàn giao.
  - Cập nhật trang khách `CustomerOrderDetailPage.vue`: hiển thị cảnh báo linh kiện ngoài, checkbox bắt buộc xác nhận miễn trừ bảo hành trước khi duyệt, và hiển thị phí ship.
  - Build Vite + Vue-tsc: **PASS (Exit 0)**.
