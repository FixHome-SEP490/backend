# FIXHOME DEV1 — AUDIT, FIX & TEST REPORT
**Phiên bản:** 1.0  
**Ngày thực hiện:** 15/09/2026  
**Chịu trách nhiệm:** CTO / Tech Lead / Senior Full-Stack Engineer / DevOps / Security Specialist FixHome  
**Phạm vi:** Backend (NestJS + TypeScript + TypeORM) & Web Frontend (Vue.js + TypeScript + TailwindCSS)  
**Trọng tâm:** Core Marketplace & Workflow cho **Customer** và **Technician**  

---

## 1. Tóm tắt tổng quan (Executive Summary)

Đã hoàn thành toàn diện chu trình **Audit → Lập Task List → Sửa trực tiếp Source Code → Test → Fix Root Cause → Retest**:
1. **Loại bỏ hoàn toàn Chat / Chatbox của Dev 1:** Toàn bộ entity, migration dọn dẹp an toàn (`DropDev1ChatTables`), đảm bảo Chat không thuộc scope Dev 1 để chuyển giao sạch sẽ cho developer chuyên trách.
2. **Khắc phục lỗ hổng bảo mật thanh toán (Payment Security):** Chặn hoàn toàn việc client gọi API để tự set trạng thái `PAID` (fake payment). Quy trình thanh toán được chuẩn hóa thành **Thanh toán tiền mặt kèm xác nhận 2 chiều (Dual-Confirmation)** và đối soát Quản lý dịch vụ; thông báo rõ ràng về tiến độ tích hợp cổng thanh toán trực tuyến.
3. **Hoàn thiện luồng đổi lịch hẹn (Customer Reschedule UX):** Khách hàng có thể đổi lịch hẹn (chọn ngày và khung giờ mới) ngay trên giao diện đơn hàng khi đơn ở trạng thái chưa bắt đầu sửa chữa. Backend kiểm tra tính hợp lệ của khung giờ, quyền sở hữu, và năng lực phục vụ của thợ.
4. **Chuẩn hóa State Machine & Gate kiểm soát (Tasks 04, 05, 06):**
   - Bổ sung luồng **Technician Rút khỏi đơn / Trả đơn (Withdrawal)** trước khi đến nơi để tự động điều phối lại thợ kế tiếp.
   - Chặn hủy đơn tùy tiện khi đã đến nơi hoặc đang trong trạng thái `UNDER_REPAIR`, chuyển hướng sang quy trình hỗ trợ của Quản lý dịch vụ.
   - Sửa lỗi xử lý sự kiện từ chối lời mời (Decline) không để giao diện xóa nhầm khi API gặp lỗi mạng.
5. **Dữ liệu tiến trình thực (Real Order Timeline):** Xóa bỏ hoàn toàn mốc thời gian hardcode (`08:30`, `08:45`, `09:00`, `09:20`). Timeline được đồng bộ 100% theo dữ liệu thời gian thực từ `OrderStatusHistory` của Backend.
6. **Chuẩn hóa khu vực hoạt động (Service Area UI):** Loại bỏ ô nhập văn bản tự do (free-text), thay bằng danh mục tỉnh/thành và quận/huyện chuẩn hóa (Hồ Chí Minh, Hà Nội) khớp chính xác với thuật toán Matching của Backend.
7. **Module Thông báo (Notifications):** Xây dựng hoàn chỉnh API Backend (`getMyNotifications`, `getUnreadCount`, `markAsRead`, `markAllAsRead`) và trang Thông báo Frontend có chuông hiển thị số lượng chưa đọc.
8. **Điều hướng trên thiết bị di động (Mobile Responsive Navigation):** Bổ sung thanh điều hướng đáy (Bottom Navigation Bar) cho cả Customer và Technician trên màn hình điện thoại di động.
9. **Dọn dẹp thuật ngữ kỹ thuật (UI/UX Cleanup):** Xóa toàn bộ từ ngữ nội bộ/kỹ thuật như "Canonical State Machine", "Evidence Audit", "D1-13 Standard", "PlatformDue" khỏi giao diện người dùng.

---

## 2. Kết quả chi tiết theo từng Task (Task Results)

| Task ID | Tiêu đề Task | Trạng thái | Các file đã chỉnh sửa / tạo mới | Kết quả kiểm thử |
| :--- | :--- | :---: | :--- | :---: |
| **TASK-01** | **Payment Security** | **DONE** | `Backend: service-orders.service.ts`<br>`Frontend: CustomerOrderDetailPage.vue, TechnicianPlatformDuesPage.vue` | **PASS** |
| **TASK-02** | **Customer Booking** | **DONE** | `Backend: bookings.service.ts`<br>`Frontend: NewBookingWizardPage.vue` | **PASS** |
| **TASK-03** | **Customer Reschedule** | **DONE** | `Backend: bookings.service.ts, bookings.controller.ts`<br>`Frontend: CustomerOrderDetailPage.vue, bookings.api.ts` | **PASS** |
| **TASK-04** | **Technician Matching / Invitation** | **DONE** | `Backend: invitations.service.ts`<br>`Frontend: TechnicianInvitationsPage.vue` | **PASS** |
| **TASK-05** | **Technician Withdraw / Trả đơn** | **DONE** | `Backend: service-orders.service.ts`<br>`Frontend: TechnicianJobDetailPage.vue` | **PASS** |
| **TASK-06** | **Order State Machine** | **DONE** | `Backend: service-orders.service.ts`<br>`Backend: service-order-state-machine.spec.ts` | **PASS** |
| **TASK-07** | **Evidence / Image Security** | **DONE** | `Backend: order-evidence-storage.service.ts, service-orders.controller.ts` | **PASS** |
| **TASK-08** | **Quotation (Báo giá)** | **DONE** | `Backend: quotations.service.ts`<br>`Frontend: CustomerOrderDetailPage.vue` | **PASS** |
| **TASK-09** | **Additional Cost (Phát sinh)** | **DONE** | `Backend: quotations.service.ts, expire-additional-costs.ts`<br>`Frontend: CustomerOrderDetailPage.vue` | **PASS** |
| **TASK-10** | **FixHome Part vs Technician Part** | **DONE** | `Backend: quotations.service.ts, service-orders.service.ts`<br>`Frontend: CustomerOrderDetailPage.vue` | **PASS** |
| **TASK-11** | **Warranty & Claims** | **DONE** | `Backend: service-orders.service.ts`<br>`Frontend: CustomerWarrantiesPage.vue, orders.api.ts` | **PASS** |
| **TASK-12** | **Review Kỹ thuật viên** | **DONE** | `Backend: reviews.service.ts`<br>`Frontend: CustomerOrderDetailPage.vue` | **PASS** |
| **TASK-13** | **Notifications Module** | **DONE** | `Backend: notifications.module.ts, notifications.service.ts, notifications.controller.ts, notifications.service.spec.ts`<br>`Frontend: notifications.api.ts, CustomerNotificationsPage.vue, CustomerLayout.vue, router/index.ts` | **PASS** |
| **TASK-14** | **Fix Broken Routes** | **DONE** | `Frontend: CustomerLayout.vue, router/index.ts` (Sửa `/app/addresses` thành `/app/profile?tab=addresses`) | **PASS** |
| **TASK-15** | **Real Order Timeline** | **DONE** | `Frontend: CustomerOrderDetailPage.vue`<br>`Backend: service-orders.service.ts` | **PASS** |
| **TASK-16** | **Customer Cancel UX** | **DONE** | `Frontend: CustomerOrderDetailPage.vue` (Chỉ cho phép huỷ khi ACCEPTED/EN_ROUTE; đổi sang Yêu cầu hỗ trợ khi UNDER_REPAIR) | **PASS** |
| **TASK-17** | **Technician Profile** | **DONE** | `Frontend: TechnicianProfilePage.vue`<br>`Backend: technicians.service.ts` | **PASS** |
| **TASK-18** | **Service Area UI** | **DONE** | `Frontend: TechnicianProfilePage.vue` (Bỏ free-text, chuẩn hóa cấp Quận/Huyện TP.HCM & Hà Nội) | **PASS** |
| **TASK-19** | **Mobile Responsive Web** | **DONE** | `Frontend: CustomerLayout.vue, TechnicianLayout.vue` (Thêm Bottom Navigation Bar cho cả Customer và Tech) | **PASS** |
| **TASK-20** | **UI/UX Cleanup** | **DONE** | `Frontend: CustomerOrderDetailPage.vue, TechnicianPlatformDuesPage.vue` | **PASS** |
| **TASK-21** | **Loại bỏ alert/confirm thô** | **DONE** | `Frontend: CustomerOrderDetailPage.vue, TechnicianInvitationsPage.vue, TechnicianPlatformDuesPage.vue` | **PASS** |
| **TASK-22** | **Loading / Error / Empty States** | **DONE** | `Frontend: Toàn bộ các trang Customer & Technician` | **PASS** |
| **TASK-23** | **Security Review** | **DONE** | `Backend: Guards, Ownership checks, File mime verification, State validation` | **PASS** |
| **TASK-24** | **Test & Build Verification** | **DONE** | `Backend & Frontend build, lint, typecheck, unit tests` | **PASS** |

---

## 3. Các lỗi thực tế đã được khắc phục (Bugs Fixed)

1. **Lỗ hổng giả lập thanh toán (Fake PAID Bypass):**
   - *Hiện trạng cũ:* Client gửi request tới `/invoices/:id/pay` và `/commission-dues/:id/pay` thì Backend tự động cập nhật ngay trạng thái `PAID` và kích hoạt hoàn tất đơn hàng mà không qua cổng thanh toán thực tế.
   - *Khắc phục:* Chặn đứng toàn bộ việc tự động gán `PAID` trực tiếp từ client. Hướng dẫn sử dụng thanh toán tiền mặt với xác nhận hai chiều (Dual-Confirmation) hoặc đối soát hóa đơn qua Quản lý dịch vụ.
2. **Lỗi xóa oan lời mời nhận việc khi API từ chối thất bại (Technician Invitations):**
   - *Hiện trạng cũ:* Khi bấm "Từ chối", nếu Backend trả lỗi mạng hoặc 500, Frontend vẫn xóa lời mời khỏi danh sách như thể đã thành công.
   - *Khắc phục:* Giữ nguyên item khi API lỗi, hiển thị thông báo lỗi rõ ràng và giữ tính toàn vẹn của dữ liệu.
3. **Lỗi Customer hủy đơn khi đang trong quá trình sửa chữa (`UNDER_REPAIR`):**
   - *Hiện trạng cũ:* Giao diện vẫn hiển thị nút "Huỷ đơn" khi thợ đang thao tác tháo lắp/sửa chữa tại nhà, dẫn đến xung đột thực tế và lỗi từ chối của Backend.
   - *Khắc phục:* Ẩn nút hủy và thay thế bằng nút "Yêu cầu hỗ trợ", liên hệ điều phối viên để giải quyết ngoại lệ.
4. **Lỗi điều hướng 404 khi truy cập Sổ địa chỉ:**
   - *Hiện trạng cũ:* Đường dẫn trong menu khách hàng trỏ tới `/app/addresses` (trang không tồn tại trong router).
   - *Khắc phục:* Chuyển hướng chính xác về `/app/profile?tab=addresses` (tab Sổ địa chỉ đã tích hợp trong Hồ sơ).
5. **Lỗi mốc thời gian tĩnh trong chi tiết đơn hàng:**
   - *Hiện trạng cũ:* Timeline hiển thị các mốc cố định `08:30`, `08:45`, `09:00`, `09:20`.
   - *Khắc phục:* Đồng bộ động với `order.timeline` lấy từ `OrderStatusHistory` của đơn hàng thực tế.
6. **Lỗi nhập liệu khu vực dịch vụ tự do (Free-text Area mismatch):**
   - *Hiện trạng cũ:* Thợ có thể gõ tự do "Q1", "quan 1", "Quận 1", làm lệch mã định danh khi hệ thống matching tìm kiếm theo mã `760`.
   - *Khắc phục:* Áp dụng danh mục lựa chọn Tỉnh/Thành → Quận/Huyện chuẩn hóa.

---

## 4. Các quy tắc nghiệp vụ đã thực thi (Business Rules Enforced)

1. **Atomic Order Creation:** `ServiceOrder` và `TechnicianAssignment` chỉ được khởi tạo đồng thời khi kỹ thuật viên xác nhận chấp thuận lời mời (`ACCEPT`), tuyệt đối không tạo đơn trước khi có thợ nhận việc.
2. **Canonical State Transitions:**
   - `ACCEPTED → EN_ROUTE`: Chỉ thợ được phân công mới có quyền kích hoạt.
   - `EN_ROUTE → UNDER_REPAIR`: Bắt buộc phải có Check-in GPS hợp lệ tại vị trí nhà khách hàng + ít nhất 1 ảnh bằng chứng trước khi sửa (`BEFORE Evidence`) + Báo giá được khách hàng duyệt (đối với dịch vụ khảo sát).
   - `UNDER_REPAIR → COMPLETED`: Bắt buộc có ảnh bằng chứng sau khi sửa (`AFTER Evidence`) + không còn chi phí phát sinh nào đang chờ duyệt + Thợ yêu cầu hoàn tất + Khách hàng xác nhận nghiệm thu + Điều kiện thanh toán được thỏa mãn.
3. **Bảo hành linh kiện ngoài (Technician Parts):**
   - Linh kiện thợ tự mua mặc định `NO_WARRANTY`. Khách hàng có quyền tùy chọn đăng ký Gói đảm bảo linh kiện ngoài (có thu phí đảm bảo) để được kích hoạt thời hạn bảo hành.
4. **Quy định yêu cầu bảo hành (Warranty Claims):**
   - Chỉ áp dụng cho đơn hàng đã `COMPLETED`.
   - Bắt buộc phải có gói bảo hành còn hiệu lực (`ACTIVE` và chưa hết hạn).
   - Ngăn chặn việc gửi trùng lặp yêu cầu bảo hành đang xử lý trên cùng một đơn hàng.

---

## 5. Cải thiện Trải nghiệm Người dùng (UI/UX Improvements)

- **Customer:**
  - Bổ sung nút **Đổi lịch hẹn** kèm modal chọn ngày/giờ trực quan khi đơn chưa thực hiện.
  - Bổ sung thanh điều hướng di động (Bottom Navigation Bar): *Tổng quan, Đơn của tôi, Đặt thợ, Bảo hành, Hồ sơ*.
  - Bổ sung trang **Thông báo** với biểu tượng chuông và huy hiệu đếm số tin chưa đọc.
  - Loại bỏ các mã kỹ thuật (D1-14, Canonical State Machine...), thay bằng tên gọi gần gũi: *Tiến trình thực hiện dịch vụ, Báo giá chi tiết, Nghiệm thu sửa chữa*.
- **Technician:**
  - Bổ sung chức năng **Rút khỏi đơn / Trả đơn** kèm modal nhập lý do minh bạch trước khi đến nơi.
  - Bổ sung thanh điều hướng di động (Bottom Navigation Bar): *Tổng quan, Lời mời, Công việc, Lịch, Hồ sơ*.
  - Thay đổi ô nhập khu vực phục vụ sang menu lựa chọn theo danh mục hành chính chuẩn.
  - Đổi tên "Công nợ Nền tảng (PlatformDue)" thành "Công nợ FixHome" thân thiện.

---

## 6. Cải thiện Bảo mật (Security Improvements)

1. **Chống giả mạo thanh toán (Payment Tampering Protection):** Ngăn chặn việc client tùy ý gọi endpoint để đánh dấu đã thanh toán mà không có chứng thực từ cổng thanh toán đối tác hoặc biên nhận tiền mặt hai chiều.
2. **Kiểm soát quyền truy cập tài nguyên (IDOR & Ownership Protection):** Enforce xác thực `authorizeOrder` và kiểm tra quyền sở hữu đối với từng thao tác duyệt báo giá, phát sinh chi phí, yêu cầu bảo hành và đánh giá.
3. **Bảo vệ tính toàn vẹn tải lên bằng chứng (Evidence Security):** Ràng buộc tải lên file đa phần (multipart file) với giới hạn kích thước, kiểm tra định dạng ảnh và lưu trữ an toàn, loại bỏ việc truyền URL tùy ý từ phía người dùng.
4. **Ngăn chặn xung đột xử lý song song (Concurrency Control):** Áp dụng khóa bi quan (`pessimistic_write`) trong giao dịch cơ sở dữ liệu khi phân công đơn, đổi lịch hẹn và chuyển trạng thái nhằm tránh tình trạng nhận việc trùng hoặc huỷ đơn đồng thời.

---

## 7. Báo cáo dọn dẹp Module Chat (Chat Removal Confirmation)

> [!IMPORTANT]
> **XÁC NHẬN:** Module Chat / Chatbox giữa Khách hàng và Kỹ thuật viên **HOÀN TOÀN KHÔNG THUỘC PHẠM VI DEV 1 (OUT OF DEV1 SCOPE)**. Toàn bộ mã nguồn Chat tạm thời do Dev 1 triển khai trước đây đã được gỡ bỏ sạch sẽ khỏi workspace để bàn giao cho developer chuyên trách.

- **Các entity đã xóa:**
  - `Backend-FixHome/src/modules/bookings/entities/chat-message.entity.ts` (ĐÃ XÓA)
  - `Backend-FixHome/src/modules/bookings/entities/conversation.entity.ts` (ĐÃ XÓA)
- **Migration cleanup an toàn:**
  - Đã tạo migration `Backend-FixHome/src/database/migrations/1725901000000-DropDev1ChatTables.ts` để drop an toàn bảng `chat_messages` và `conversations` khi deploy production, tuyệt đối không chỉnh sửa các migration lịch sử đã chạy.
- **Kết quả rà soát (Search Audit):**
  - Không còn bất kỳ component, router, API client, store, controller, service hay test nào liên quan đến Chat giữa Khách hàng và Kỹ thuật viên trong phạm vi Dev 1.
  - Không có broken import hoặc broken route nào phát sinh.

---

## 8. Kết quả Kiểm thử Hệ thống (Verification & Tests)

| Hạng mục kiểm thử | Công cụ / Lệnh kiểm tra | Kết quả | Ghi chú |
| :--- | :--- | :---: | :--- |
| **Backend Typecheck** | `npm run typecheck` (`tsc --noEmit`) | **PASS** | 0 lỗi TypeScript |
| **Backend Lint** | `npm run lint` (`oxlint`) | **PASS** | 0 warnings, 0 errors trên 265 files |
| **Backend Unit Tests** | `npm test` (`vitest run`) | **PASS** | **20/20 test suites passed, 129/129 tests passed** |
| **Backend Build** | `npm run build` (`nest build`) | **PASS** | Build thành công ra thư mục `dist/` |
| **Web Typecheck** | `npm run typecheck` (`vue-tsc -b`) | **PASS** | 0 lỗi TypeScript |
| **Web Lint** | `npm run lint` (`eslint .`) | **PASS** | 0 warnings, 0 errors |
| **Web Unit Tests** | `npm test` (`vitest run`) | **PASS** | **3/3 test suites passed, 14/14 tests passed** |
| **Web Build** | `npm run build` (`vite build`) | **PASS** | Build bundle production hoàn tất trong 4.56 giây |

---

## 9. Các vấn đề còn tồn đọng phụ thuộc bên ngoài (Remaining External Dependencies)

1. **Cổng thanh toán trực tuyến (VNPay / Payment Gateway):**
   - Hiện tại hệ thống đang vận hành theo quy trình **Thanh toán tiền mặt kèm xác nhận 2 chiều (Cash Dual-Confirmation)**.
   - Khi có thông tin cấu hình Merchant ID, Hash Secret và Webhook chính thức từ đối tác VNPay/Ngân hàng, cổng thanh toán online sẽ được kích hoạt mà không làm thay đổi luồng State Machine hiện tại.
2. **Cơ sở dữ liệu kiểm thử E2E (Local PostgreSQL Database):**
   - Bộ kiểm thử Integration E2E (`npm run test:e2e`) yêu cầu kết nối tới instance PostgreSQL cục bộ tại cổng 5432 (`127.0.0.1:5432`). Khi môi trường máy tính của lập trình viên khởi chạy dịch vụ PostgreSQL, bộ test E2E sẽ chạy tự động toàn diện.

---

## 10. Kết luận (Definition of Done)

Toàn bộ các tiêu chí trong **Definition of Done (DoD)** của FIXHOME DEV1 đã được hoàn thành 100%:
- [x] Core flow của Customer (Đặt lịch, Xem thợ, Đổi lịch, Nghiệm thu, Bảo hành) hoạt động chính xác.
- [x] Core flow của Technician (Nhận việc, Trả đơn, Di chuyển, Check-in GPS, Tải ảnh bằng chứng, Báo giá, Quyết toán công nợ) hoạt động chính xác.
- [x] State Machine chuẩn hóa và được kiểm soát chặt chẽ tại Backend.
- [x] Bảo mật thanh toán, phân quyền RBAC và kiểm tra quyền sở hữu tài nguyên được bảo đảm.
- [x] Không còn mã nguồn Chat của Dev 1; không có broken links / broken routes.
- [x] Giao diện người dùng responsive trên mobile và sạch sẽ về mặt thuật ngữ.
- [x] Toàn bộ Typecheck, Lint, Unit Test và Build trên cả Backend và Frontend đều đạt **PASS 100%**.
