# T11 — Ghi nhận xác minh vật lý linh kiện legacy

Phạm vi Backend, dựa trên `d3c885f`; chỉ Service Manager (SM) ghi/đọc observation.
Không migration, không chạy DB, không thay đổi Web/Mobile.

Handoff T11 ngày 29/10/2026, `foxonworld`, nhánh `foxonworld/fixhome-platform-first-legacy-parts-t11-20261029`: owner yêu cầu giữ nguyên CONTEXT cùng 40 mục lịch sử chính thức; addendum và hợp đồng T11 nằm tại tài liệu này. Mục T3b trong CONTEXT mô tả baseline trước T11; phần dưới bổ sung POST và readback, không thay nghĩa UNKNOWN.

## Hợp đồng

- `POST /api/v1/part-returns/legacy-manual-review/:itemId`: JWT + role `service_manager`; HTTP 200 `{ data }` theo envelope hiện hành.
- Body: `commandId` UUID, `expectedVersion` (bắt đầu 0), `status` thuộc `INVESTIGATING|PHYSICALLY_VERIFIED|DISCREPANCY_RECORDED`, `reason` 5–300 ký tự sau trim.
- `evidenceReferenceId` tùy chọn, chỉ UUID nội bộ; bắt buộc khi `PHYSICALLY_VERIFIED`. Không nhận URL bằng chứng. `observedQty` tùy chọn, số nguyên 0–100, chỉ nhận khi có tham chiếu bằng chứng và trạng thái khác `INVESTIGATING`. Đây là observation do SM chịu trách nhiệm, không phải biên nhận kho; Backend không tự chứng thực nội dung chứng từ từ UUID.
- Đính chính kết luận đã ghi phải dùng command mới, version hiện tại, `correctsEventId` trỏ đúng event cuối và `correctionReason` 5–300 ký tự. Không cập nhật/xóa event cũ. Ghi chú chỉ chứa lý do nghiệp vụ, không PII; validation chặn URL HTTP, email và chuỗi số điện thoại thông dụng.
- UUID command/evidence/correction không phân biệt hoa thường; item path dùng `ParseUUIDPipe`, service chuẩn hóa lowercase.
- GET danh sách hiện có giữ nguyên phân trang/anti-join và luôn trả `receiptState: UNKNOWN`; thêm `manualReviewState` (mặc định `UNKNOWN`) và `lastManualReview` (mặc định `null`). Event gồm id, command/version, status/reason, actor/role/time, order/technician/request/item và observation/evidence/correction nếu có.
- Chỉ đọc event qua API SM. Admin audit list loại action này; tra trực tiếp audit id trả không tìm thấy. Không bổ sung dữ liệu này vào API khách/thợ.

## Bằng chứng nguồn và tính bất biến

Item phải tồn tại, nguồn FIXHOME, liên kết đúng request/order tồn tại; request ở RECEIVED/COMPLETED/CANCELLED có `received_at` bền vững và hợp lệ; item chưa có PartCustody. Không tin receivedAt/số nhận kho do client gửi. SM có quyền toàn cục như các route trả linh kiện hiện hữu, không giả thêm người quản lý được phân công.

Transaction khóa request gốc rồi item bằng `pessimistic_write`, đọc AuditLog sau khóa và chèn action `SM_LEGACY_PARTS_MANUAL_REVIEW`. Khóa request dùng chung đường QR enrollment; khóa parent tồn tại ngay cả khi chưa có audit, nên hai lệnh cho cùng item không cùng quan sát lịch sử rỗng ở PostgreSQL READ COMMITTED mặc định. Audit append-only, không cần bảng/index/migration mới. Audit insert lỗi thì command lỗi, không thành công giả.

Replay cùng item/command/actor/nội dung chuẩn hóa trả event cũ, kể cả sau event mới; khác nội dung/actor hoặc version cạnh tranh trả 409. Kiểm tra nguồn/actor/version của lịch sử trước khi dùng; audit không khớp nguồn bị từ chối. Không ghi vào request, item, PartCustody, kho, hóa đơn, payment, PlatformDue, hoàn tiền, assignment hay booking. Đơn đã STOP/deassign vẫn cho SM ghi observation; không thêm gate đặt lại của khách.

`issuedQty` chỉ giữ số lượng lịch sử của item. Không có `managerAcceptedQty`, accepted/declared/outstanding/used quantity trong kết quả legacy. Khi chưa xác minh được số thực tế, bỏ `observedQty` và giữ `UNKNOWN`; ngay cả `PHYSICALLY_VERIFIED` cũng không đồng nghĩa kho đã nhận.

## Kiểm chứng và giới hạn

- PASS: `npx vitest run src/modules/part-requests/platform-first-parts-audit.spec.ts src/modules/audit-log/audit-log.service.spec.ts` — 2 specs, 64 tests. RED trước triển khai, GREEN sau triển khai.
- PASS: `npm run typecheck`; `git diff --check`.
- PASS: `npx vitest run test/context-doc.spec.ts` — 2 tests, CONTEXT giữ nguyên lịch sử đội dự án.
- Kiểm tra storage giả cô lập: SM-only service/route RBAC, replay, competing version, correction, nguồn sai/thiếu custody proof, validation giới hạn, audit rollback, official GET vẫn UNKNOWN, Admin không đọc được event và STOP không làm đổi booking/tiền/assignment. Serialization của fixture không chứng minh khóa PostgreSQL.
- NOT VERIFIED: PostgreSQL/SQL thực/race/RLS, HTTP JWT runtime, customer rebook E2E, shared DEV, Docker, Web/Mobile, browser, CI, full suites, lint và build. Không chạy PG/DEV/browser/E2E hoặc full suite theo timebox của owner; không push/merge/deploy.
- Cần restart Backend trước runtime QA. Web/Mobile chưa được sửa/kiểm chứng contract mới; không coi observation là workflow nhận kho hoàn chỉnh.
