# Hợp đồng Backend P0/P1: dừng sửa, đổi thợ, đặt lại

Nguồn quyết định: `FIXHOME_REPLACEMENT_CANCEL_REBOOK_P0_P1_REVIEWED_EXECUTION_PLAN_20261028.md` (Owner duyệt 28/10/2026). Trạng thái: đang triển khai trên nhánh Backend; chỉ các route có trong source tại commit bàn giao mới được coi là khả dụng. Mọi đường dẫn dưới đây có tiền tố `/api/v1`.

## Quy tắc chung

- `ServiceOrder` của một child trong `VisitGroup` không được chuyển trực tiếp sang thợ khác. Hành động quản lý tác động đúng một child; các sibling, hoá đơn và người phụ trách của chúng giữ nguyên.
- `interrupted` là kết quả quản trị do quản lý đóng công việc chưa hoàn tất; `failed` chỉ là kết quả thợ báo thực sự không sửa được qua `report-repair-failed`. Hai nguồn đặt lại khác nhau.
- Lệnh đổi thợ/đóng đơn bị chặn khi đã duyệt báo giá, có invoice, payment/cash/group payment đang chờ hoặc đã thanh toán, voucher đã reserve/fund, linh kiện còn nghĩa vụ, hoặc dữ liệu thiếu/không rõ. Riêng đóng đơn còn chặn báo giá DRAFT/SENT. Trả `409` với lý do tường minh; không tự hoàn tiền, xóa báo giá/hóa đơn hay chuyển quyền lợi tài chính.
- Client phải hiển thị kết quả thật từ server; `replacement-options` chỉ là gợi ý đọc, POST kiểm lại toàn bộ dưới khóa.

## Customer

`POST /service-orders/:id/stop-replace-request` — JWT `customer`, đúng chủ Booking, order `under_repair`, chưa yêu cầu hoàn tất. Body `{ "reason": string }` (10–2000 ký tự). Trả `200` `{ data: SupportCaseDetail }`; gửi trùng khi còn `open`/`in_review` trả cùng case. Case có `caseType: "mid_job_interruption"`, `requestIntent: "stop_or_replace"`, `holdCompletion: true`, `serviceOrderId` là child mục tiêu. Đây là yêu cầu quản lý xử lý, chưa phải hủy đơn hoặc cam kết thợ mới. `GET /support/cases/mine/:id` và `/mine` trả `requestIntent` và trạng thái cho khách. Vai trò khác: `403`.

## Service Manager

`GET /support/cases/:id/replacement-options` — JWT `service_manager`, quyền `support:resolve`. Trả `{ data: { caseId, caseStatus, caseVersion, serviceOrderId, visitGroupId, requestIntent, flags, actions } }`. `flags`: `approvedQuote`, `openQuote`, `invoice`, `payment`, `voucher`, `parts`, `incompleteSiblings`, `assignmentChanged`; mỗi action có `allowed` và `reasons` (mã ổn định). Ba action: `DIRECT_REASSIGN_SOLO`, `CLOSE_FOR_REBOOK`, `REJECT_REQUEST`.

`POST /support/cases/:id/resolve-interruption` — JWT `service_manager`, quyền `support:resolve`. Body `{ "commandId": UUID, "expectedCaseVersion": number, "action": "DIRECT_REASSIGN_SOLO" | "CLOSE_FOR_REBOOK" | "REJECT_REQUEST", "reason": string, "technicianId"?: UUID }`. `reason` 10–2000 ký tự. `technicianId` chỉ dùng cho `DIRECT_REASSIGN_SOLO`. Trả `{ data: { case: { id, status, workflowVersion, requestIntent, resolutionCode, resolutionReason, serviceOrderId, holdCompletion }, order: { id, status }, nextAction: "none" | "interruption_rebook" } }`. Cùng `commandId` và cùng body trả lại kết quả, không ghi lần hai; cùng mã khác body trả `409`. Version/case thay đổi trả `409` để client tải lại. `CLOSE_FOR_REBOOK` đóng child `under_repair` chưa có ràng buộc tài chính/linh kiện, ghi outcome `interrupted` cho group, kết thúc assignment, resolve case và lưu audit/notification trong một transaction. `DIRECT_REASSIGN_SOLO` chỉ cho solo trước báo giá được duyệt/invoice, với thợ mới đủ điều kiện; về `accepted` để check-in mới. `REJECT_REQUEST` kết thúc case và bỏ hold, không đổi order.

Các route cũ `POST /service-orders/:id/replace-technician` và `POST /service-orders/:id/assign` trả 4xx khi là child của `VisitGroup`; client quản lý dùng lệnh SupportCase ở trên cho xử lý giữa ca. `POST /support/cases/:id/resolve` không chuyển assignment hoặc hủy order và không được dùng thay lệnh exception.

## Đặt lại sau gián đoạn

`GET /bookings/:id/interruption-draft` — JWT `customer`, `:id` là Booking của child đã bị quản lý đóng. Trả `{ data: { sourceVisitGroupId, targetKind: "booking" | "visit_group", address: { id, text }, customerNote, items: [{ sourceBookingId, sourceOrderId, sourceCaseId, serviceId, deviceLabel, selectedVariantCode, description, deviceAttributes, quantity: 1, photos: [], previousTechnicianId }], requiresNewSchedule: true, requiresPricingRevalidation: true, confirmation: { available: true, path } } }`. Nếu nhiều child cùng group đã `interrupted`, draft gom các child đó vào một lượt mới. Không đưa báo giá/giá cũ, voucher, ảnh riêng tư hay upload token sang booking mới.

`POST /bookings/:id/interruption-rebook` — JWT `customer`. Body `{ "idempotencyKey": string(8..128), "addressId": UUID, "date": "YYYY-MM-DD", "slot": "morning" | "afternoon" | "evening", "customerNote"?: string, "items": [{ "sourceBookingId": UUID, "sourceCaseId": UUID, "selectedVariantCode"?: string | null, "description"?: string, "deviceAttributes"?: object | null, "photoUploadIds"?: UUID[] }] }`. `items` phải khớp đúng toàn bộ source trong draft. Trả `201` `{ data: { targetKind, bookingId: UUID | null, visitGroupId: UUID | null, items: [{ sourceBookingId, sourceCaseId, bookingId }] } }`. Xác nhận tạo booking mới qua validation/giá hiện tại; không tự gửi lời mời. Idempotency key cùng payload trả cùng receipt, key đổi không được tạo lại từ source đã dùng. Thợ cũ bị loại ở matching/shortlist/accept của booking mới.

`POST /bookings/:id/rebook` trả lỗi có `draftPath` khi nguồn `interrupted`, tránh mời lại thợ cũ. Nguồn `failed` dùng `/bookings/:id/repair-failure-draft` và `/repair-failure-rebook` hiện có. Booking thường đã hoàn thành/hủy thường giữ `/bookings/:id/rebook`.
