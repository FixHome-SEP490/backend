# FIXHOME - BÁO CÁO THIẾT KẾ & TRIỂN KHAI TOÀN DIỆN
## QUY TRÌNH QUẢN LÝ LINH KIỆN & THEO DÕI BÀN GIAO (PARTS CATALOG & REQUEST TRACKING)

> [!IMPORTANT]
> **"FixHome does not implement full warehouse or inventory management."**  
> Hệ thống FixHome tập trung vào **Parts Catalog**, **Parts Request Tracking**, **QR Handover**, và **USED / RETURNED History**. Hệ thống **KHÔNG** quản lý kho bãi, tồn kho (stock quantities), nhập/xuất kho kế toán, nhà cung cấp (suppliers), đơn đặt mua hàng (purchase orders), kiểm kê định kỳ, hay chuyển kho (warehouse transfers).

**Dự án:** FixHome (SEP490 Capstone Project)  
**Phạm vi:** Backend + Web + Docs (Tuyệt đối không can thiệp Mobile)  
**Nhánh thực hiện:** `Truonghoang`  
**Ngày hoàn thiện:** 24/09/2026  
**Trạng thái kiểm thử:** 
- Frontend: Lint (0 error, 0 warning) | Typecheck (0 error) | Tests (330/330 PASS) | Build (PASS)
- Backend: Lint (0 error) | Typecheck (0 error) | Audit (0 High/Critical) | Tests (616/616 PASS) | Build (PASS)

---

## 1. PHÂN HỆ ADMIN: PARTS CATALOG QUẢN TRỊ

Admin chịu trách nhiệm cấu hình danh mục linh kiện phân phối chính hãng trong hệ sinh thái FixHome:

### 1.1. Chức năng Admin quản lý:
- **Xem danh mục linh kiện (Parts Catalog List):** Tìm kiếm theo tên, mã SKU, lọc theo trạng thái (Đang hoạt động / Đã vô hiệu), phân trang.
- **Xem chi tiết linh kiện (Part Detail Modal):** Hiển thị đầy đủ SKU, Tên, Mô tả kỹ thuật, Giá bán niêm yết (VNĐ), Số ngày bảo hành, Chính sách bảo hành, Trạng thái hoạt động, Ngày tạo, Ngày cập nhật.
- **Tạo mới linh kiện (Create Part):** Nhập SKU, Tên, Mô tả, Giá bán, Số ngày bảo hành (0 - 3650 ngày), Chính sách bảo hành.
- **Chỉnh sửa linh kiện (Edit Part):** Cập nhật thông tin chi tiết, giá bán, thời hạn bảo hành.
- **Kích hoạt / Vô hiệu hóa (Active / Inactive Toggle):** Chuyển đổi trạng thái linh kiện an toàn qua hộp thoại xác nhận. Khi vô hiệu hóa, linh kiện không còn hiển thị cho Kỹ thuật viên chọn trong các đơn hàng mới.
- **Xem lịch sử yêu cầu linh kiện (Parts Request History):** Quyền xem (read-only audit) toàn bộ danh sách yêu cầu linh kiện trên hệ thống nhằm phục vụ đối soát, kiểm toán chất lượng.

### 1.2. Admin KHÔNG quản lý (Out of Scope):
- Tồn kho (inventory quantity / stock level)
- Nhập kho / Xuất kho (stock-in / stock-out)
- Nhà cung cấp (suppliers)
- Đơn mua hàng (purchase orders)
- Kiểm kê kho (stocktaking)
- Điều chuyển kho (warehouse transfer)

---

## 2. PHÂN HỆ SERVICE MANAGER: PARTS REQUEST OPERATIONS

Service Manager (SM) đóng vai trò điều phối, chuẩn bị và theo dõi giao nhận linh kiện thực tế phục vụ đơn sửa chữa:

### 2.1. Quy trình vận hành chuẩn:
```
Technician tạo Parts Request (PRE_REPAIR hoặc ADDITIONAL)
  ↓
SM tiếp nhận yêu cầu trên Console (/console/part-requests)
  (Xem: Mã đơn, Kỹ thuật viên, Danh sách linh kiện, Số lượng, Loại yêu cầu, Hình thức Pickup/Delivery)
  ↓
SM chuẩn bị hàng xong tại trạm kho
  ↓
SM bấm "Chuẩn bị xong (Mark READY)" → Hệ thống tự sinh mã QR Token bảo mật (48h expiry)
  ↓
[Nhánh 1: Tự đến lấy (PICKUP)]
  → Kỹ thuật viên đến trạm kho
  → Quét mã QR / Nhập mã Token
  → Trạng thái chuyển thành RECEIVED
  
[Nhánh 2: Giao tận nơi (DELIVERY)]
  → SM bấm "Giao hàng (Mark DELIVERING)" (hệ thống ghi nhận phí ship)
  → Đơn vị giao hàng mang tới chân công trình
  → Kỹ thuật viên nhận hàng, quét mã QR / Nhập mã Token
  → Trạng thái chuyển thành RECEIVED
  ↓
[Sau sửa chữa - Chốt sử dụng]
  → Kỹ thuật viên đánh dấu:
      • USED: Đã lắp đặt vào thiết bị (Tính vào chi phí quyết toán đơn hàng)
      • RETURNED: Trả lại kho FixHome nguyên vẹn (Miễn phí 100% cho khách hàng)
  ↓
SM theo dõi toàn bộ lịch sử bàn giao và chốt số lượng USED / RETURNED
```

### 2.2. SM KHÔNG quản lý:
- Tồn kho, kiểm kê, hao hụt kho
- Nhà cung cấp, giá vốn (COGS), purchase orders
- Bảng giá niêm yết (chỉ Admin mới có quyền sửa giá/warranty/SKU)

---

## 3. STATE MACHINES & ENUMS HỆ THỐNG

### 3.1. Vòng đời Parts Request (`PartRequestStatus`)
```
[REQUESTED] ---> [READY] ---> [RECEIVED] ---> [COMPLETED]
                   |              ^
                   v              |
             [DELIVERING] --------+
                   |
     (Trước khi bàn giao) --------> [CANCELLED]
```
- `REQUESTED`: Thợ vừa tạo yêu cầu, chờ SM kiểm tra và chuẩn bị.
- `READY`: Kho chuẩn bị xong, mã QR Token được sinh ra để bàn giao.
- `DELIVERING`: Đang vận chuyển linh kiện tới công trình (chỉ dành cho DELIVERY).
- `RECEIVED`: Thợ đã quét QR xác nhận nhận đủ linh kiện.
- `COMPLETED`: Toàn bộ các linh kiện trong yêu cầu đã được chốt trạng thái `USED` hoặc `RETURNED`.
- `CANCELLED`: Yêu cầu bị hủy (bởi SM/Admin hoặc khi ServiceOrder bị hủy).

> **Lưu ý quan trọng:** Trạng thái của Parts Request hoạt động độc lập và **KHÔNG** đưa vào Service Order State Machine (`ACCEPTED -> EN_ROUTE -> UNDER_REPAIR -> COMPLETED | CANCELLED`).

### 3.2. Trạng thái sử dụng linh kiện (`PartUsageStatus`)
- `PENDING`: Linh kiện đã bàn giao cho thợ nhưng chưa chốt sử dụng.
- `USED`: Đã thực tế thay thế vào thiết bị của khách (khách thanh toán theo báo giá/chi phí phát sinh được duyệt).
- `RETURNED`: Trả lại kho FixHome (khách KHÔNG bị tính chi phí).

### 3.3. Phương thức bàn giao (`FulfillmentMethod`)
- `PICKUP`: Thợ tự ghé trạm kho nhận linh kiện (Phí ship = 0đ).
- `DELIVERY`: Giao hàng tận nơi cho thợ tại công trình (Có phí giao hàng `shippingFee`).

### 3.4. Nguồn linh kiện (`PartSource`)
- `FIXHOME`: Linh kiện do kho FixHome cung cấp (có bảo hành linh kiện chính hãng).
- `TECHNICIAN`: Linh kiện do thợ tự chuẩn bị.
- `EXTERNAL`: Linh kiện mua ngoài thị trường (FixHome không bảo hành linh kiện).

---

## 4. CƠ SỞ DỮ LIỆU & QUAN HỆ THỰC THỂ

### 4.1. Bảng `part_requests`
- `id` (UUID, PK)
- `service_order_id` (UUID, FK -> `service_orders.id` ON DELETE CASCADE)
- `technician_id` (UUID, FK -> `users.id`)
- `request_type` (`part_request_type_enum`: `pre_repair`, `additional`)
- `fulfillment_method` (`fulfillment_method_enum`: `pickup`, `delivery`)
- `status` (`part_request_status_enum`: `requested`, `ready`, `delivering`, `received`, `completed`, `cancelled`)
- `reason` (TEXT)
- `shipping_fee` (BIGINT / NUMERIC, DEFAULT 0)
- `additional_cost_id` (UUID, FK -> `additional_cost_requests.id`)
- `qr_token` (VARCHAR(128), UNIQUE)
- `qr_generated_at` (TIMESTAMPTZ)
- `received_at` (TIMESTAMPTZ)
- `completed_at` (TIMESTAMPTZ)
- `cancelled_at` (TIMESTAMPTZ)
- `prepared_by_user_id` (UUID)
- `created_at`, `updated_at` (TIMESTAMPTZ)

### 4.2. Bảng `part_request_items`
- `id` (UUID, PK)
- `part_request_id` (UUID, FK -> `part_requests.id` ON DELETE CASCADE)
- `part_catalog_id` (UUID, FK -> `fixhome_parts.id` / `part_catalog.id`)
- `part_source` (`part_source_enum`: `fixhome`, `technician`, `external`)
- `part_name_snapshot` (VARCHAR(255))
- `quantity` (INT, DEFAULT 1)
- `unit_price_snapshot` (BIGINT / NUMERIC, DEFAULT 0)
- `usage_status` (`part_usage_status_enum`: `pending`, `used`, `returned`)
- `note` (TEXT)
- `created_at`, `updated_at` (TIMESTAMPTZ)

### 4.3. Cập nhật bảng `additional_cost_requests`
- `fulfillment_method` (`fulfillment_method_enum`, DEFAULT `'pickup'`)
- `shipping_fee` (BIGINT, DEFAULT 0)

---

## 5. API VÀ MA TRẬN PHÂN QUYỀN (RBAC MATRIX)

| API Route | HTTP | Quyền (Roles) | Mô tả & Ràng buộc bảo mật |
|---|---|---|---|
| `GET /parts/catalog` | `GET` | All Authenticated | Xem danh mục linh kiện phân phối |
| `POST /parts/catalog` | `POST` | `ADMIN` | Thêm linh kiện mới vào Catalog |
| `PATCH /parts/catalog/:id` | `PATCH` | `ADMIN` | Sửa thông tin, giá, bảo hành linh kiện |
| `PATCH /parts/catalog/:id/status`| `PATCH` | `ADMIN` | Kích hoạt / Vô hiệu hóa linh kiện |
| `POST /service-orders/:orderId/part-requests` | `POST` | `TECHNICIAN` | Thợ tạo yêu cầu linh kiện trước sửa chữa (đơn ở `ACCEPTED`) |
| `GET /service-orders/:orderId/part-requests` | `GET` | `TECH`, `SM`, `ADMIN`, `CUST` | Xem danh sách yêu cầu linh kiện của đơn hàng |
| `GET /part-requests` | `GET` | `SERVICE_MANAGER`, `ADMIN` | SM/Admin truy vấn toàn bộ yêu cầu, lọc theo trạng thái/thợ/đơn/thời gian |
| `GET /part-requests/:id` | `GET` | `SM`, `ADMIN`, `TECH` | Xem chi tiết yêu cầu linh kiện & tình trạng sử dụng |
| `PATCH /part-requests/:id/ready` | `PATCH` | `SERVICE_MANAGER`, `ADMIN` | SM xác nhận chuẩn bị xong -> Sinh mã QR Token |
| `PATCH /part-requests/:id/delivering` | `PATCH` | `SERVICE_MANAGER`, `ADMIN` | SM chuyển trạng thái giao hàng tận nơi |
| `POST /part-requests/:id/receive` | `POST` | `TECHNICIAN` | Thợ quét QR Token nhận hàng (Validate token, thợ phụ trách, thời hạn 48h) |
| `PATCH /part-requests/:id/items/:itemId/usage` | `PATCH` | `TECHNICIAN` | Thợ cập nhật linh kiện thành `USED` hoặc `RETURNED` |
| `PATCH /part-requests/:id/cancel` | `PATCH` | `SM`, `ADMIN`, `TECH` | Hủy yêu cầu linh kiện chưa bàn giao |

---

## 6. NGUYÊN TẮC BẢO MẬT & QUY TẮC NGHIỆP VỤ (SECURITY & BUSINESS RULES)

1. **Phân quyền chặt chẽ:**
   - Chỉ `ADMIN` mới có quyền can thiệp giá bán, SKU, bảo hành và trạng thái Catalog.
   - `SERVICE_MANAGER` điều phối thao tác `READY`, `DELIVERING`, hủy yêu cầu; không thể sửa bảng giá.
   - `CUSTOMER` bị chặn toàn bộ đối với các API điều phối kho và quản trị catalog.
2. **Xác thực bảo mật bàn giao QR:**
   - Mã QR Token có định dạng `FH-PR-<TOKEN>`.
   - Token chỉ có hiệu lực trong vòng **48 giờ** kể từ lúc sinh ra.
   - Backend xác thực bắt buộc: mã QR phải trùng khớp, đúng Kỹ thuật viên được giao đơn hàng (`OWNERSHIP_DENIED`), và yêu cầu phải đang ở trạng thái `READY` hoặc `DELIVERING`.
   - Chặn tuyệt đối nhận trùng lặp: Một yêu cầu đã `RECEIVED` không thể quét nhận lần 2.
3. **Chống giả mạo giá (Zero Trust on Client Prices):**
   - Giá linh kiện kho FixHome luôn được tra cứu và snapshot trực tiếp từ cơ sở dữ liệu (`FixHomePart`), không chấp nhận dữ liệu giá tự gửi từ frontend.
4. **Bảo vệ tài chính khách hàng:**
   - Yêu cầu linh kiện ban đầu (Pre-Repair Request) **không tính tiền** khách hàng.
   - Khi nghiệm thu, khách hàng **chỉ thanh toán** cho linh kiện có trạng thái `USED` nằm trong báo giá hoặc chi phí phát sinh đã được khách duyệt.
   - Toàn bộ linh kiện `RETURNED` được miễn phí 100%.
5. **Cảnh báo minh bạch đối với linh kiện ngoài (`EXTERNAL`):**
   - Linh kiện mua ngoài không có bảo hành từ FixHome.
   - Frontend hiển thị cảnh báo nổi bật và bắt buộc khách hàng tích xác nhận miễn trừ trước khi duyệt chi phí phát sinh.

---

## 7. GIAO DIỆN WEB ĐÃ TRIỂN KHAI

### 7.1. Admin Web
- [AdminPartsPage.vue](file:///d:/SEP490%28%20d%E1%BB%B1%20%C3%A1n/SEP490/Frontend-FixHome/src/pages/console/admin/AdminPartsPage.vue) (`/console/admin/parts`):
  - Danh mục linh kiện đầy đủ chức năng: Xem danh sách, tìm kiếm, phân trang, thêm mới, sửa đổi, bật/tắt hoạt động.
  - Nút **"Xem chi tiết"** mở popup chi tiết linh kiện kèm đầy đủ thuộc tính bảo hành và ngày cập nhật.
  - Nút **"Lịch sử Parts Request (Audit)"** trên thanh tiêu đề dẫn thẳng đến màn hình giám sát yêu cầu linh kiện.
  - Banner định nghĩa rõ phạm vi hệ thống: *Không quản lý kho bãi/tồn kho*.

### 7.2. Service Manager Web
- [ConsolePartRequestsPage.vue](file:///d:/SEP490%28%20d%E1%BB%B1%20%C3%A1n/SEP490/Frontend-FixHome/src/pages/console/ConsolePartRequestsPage.vue) (`/console/part-requests`):
  - Bộ đếm thời gian thực các trạng thái (`REQUESTED`, `READY`, `DELIVERING`, `RECEIVED`, `COMPLETED`).
  - Thanh công cụ tìm kiếm và bộ lọc đa chiều: Trạng thái, Loại yêu cầu, Phương thức nhận, và **Thời gian (Hôm nay / 7 ngày qua / 30 ngày qua / Mọi thời gian)**.
  - Nút thao tác một chạm:
    - *"Chuẩn bị xong (Mark READY)"*: Sinh mã QR và bật ngay modal hiển thị QR động kèm mã text token copyable.
    - *"Giao hàng"*: Chuyển trạng thái giao hàng tận nơi.
    - *"Xem chi tiết"*: Modal xem chi tiết trạng thái từng linh kiện (`PENDING`, `USED`, `RETURNED`) và thời gian nhận hàng.

### 7.3. Kỹ thuật viên Web
- [TechnicianJobDetailPage.vue](file:///d:/SEP490%28%20d%E1%BB%B1%20%C3%A1n/SEP490/Frontend-FixHome/src/pages/technician/TechnicianJobDetailPage.vue) & [TechnicianPartsSection.vue](file:///d:/SEP490%28%20d%E1%BB%B1%20%C3%A1n/SEP490/Frontend-FixHome/src/components/TechnicianPartsSection.vue):
  - Giao diện yêu cầu linh kiện trước khi di chuyển (`ACCEPTED`).
  - Ô quét / nhập mã QR Token để nhận linh kiện khi SM đã chuẩn bị xong.
  - Nút phân loại linh kiện thành `USED` hoặc `RETURNED` trong lúc sửa chữa.
  - Form chi phí phát sinh nâng cấp hỗ trợ linh kiện kho FixHome (Pickup/Delivery kèm phí ship) và linh kiện mua ngoài (`EXTERNAL`).

### 7.4. Khách hàng Web
- [CustomerOrderDetailPage.vue](file:///d:/SEP490%28%20d%E1%BB%B1%20%C3%A1n/SEP490/Frontend-FixHome/src/pages/customer/CustomerOrderDetailPage.vue):
  - Hiển thị chi tiết từng hạng mục chi phí phát sinh (Công, Linh kiện FixHome, Linh kiện ngoài, Phí giao hàng).
  - Cảnh báo bảo hành linh kiện ngoài và checkbox bắt buộc xác nhận trước khi nút "Đồng ý" được kích hoạt.

---

## 8. BẢNG TỔNG HỢP KIỂM THỬ (TEST RESULTS)

```
========================================================================================
CI/CD QUALITY GATES VERIFICATION SUMMARY
========================================================================================

FRONTEND (Frontend-FixHome):
✔ ESLint (. --max-warnings=0)    : 0 errors, 0 warnings
✔ Typecheck (vue-tsc -b)         : 0 errors
✔ Unit Tests (vitest run)        : 38 files passed, 330 tests passed (100%)
✔ Production Build (vite build)  : Successfully bundled in dist/ (Exit 0)

BACKEND (Backend-FixHome):
✔ Linter (oxlint src/ test/)     : 0 errors
✔ Typecheck (tsc --noEmit)       : 0 errors
✔ Security Audit (npm audit)     : 0 High/Critical vulnerabilities
✔ Unit Tests (vitest run)        : 79 files passed, 616 tests passed (100%)
✔ Production Build (nest build)  : Successfully compiled in dist/ (Exit 0)
========================================================================================
```

---

## 9. CÁC HẠN CHẾ CÒN LẠI VÀ THIẾT KẾ ĐẶC THÙ (DESIGN LIMITATIONS)

1. **Không theo dõi số lượng tồn vật lý trong kho:** Hệ thống không có bảng `stock_inventory`, không ghi nhận số lượng tồn kho còn lại sau khi xuất linh kiện. Đây là chủ đích thiết kế theo đúng phạm vi Đồ án FixHome đã thống nhất.
2. **Không có phân hệ mua hàng / nhập kho:** Không hỗ trợ Purchase Orders, nhà cung cấp linh kiện và giá vốn kế toán.
3. **Mã QR bàn giao trên Web App:** Trên môi trường máy tính không có camera sau, Kỹ thuật viên sử dụng mã Token text sao chép để xác thực nhận hàng; trên điện thoại có thể quét trực tiếp mã QR.
4. **Dữ liệu linh kiện:** Source code không chứa linh kiện mẫu hard-coded; Admin sẽ trực tiếp nhập dữ liệu linh kiện thật thông qua giao diện Catalog trên môi trường thực tế.
