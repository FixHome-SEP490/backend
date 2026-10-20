# Theo dõi trả linh kiện vật lý, tách khỏi P1 tài chính

Phạm vi owner duyệt 20/10/2026. Chỉ backend, chưa activation, không ghi DB/env,
không commit/push. WEB/Mobile/runtime liên repo: **NOT VERIFIED**.

## Hành vi và tài chính

- `PART_RETURNS_TRACKING_ENABLED` mặc định OFF; độc lập với `P1_CUSTODY_ENABLED`.
  Hai cờ không được cùng ON. P1 cũ giữ tiền công online qua `custody-settlement.ts`
  và hạn chế rút ví theo cash custody, nên **không bật P1 để triển khai tracking**.
- Tracking tái sử dụng ledger `part_custodies`/`part_custody_entries`, với dấu
  `tracking_only` bất biến. Startup từ chối bỏ cờ hoặc đổi chế độ sau khi đã có hàng.
  DB từ chối trộn hai chế độ. Không backfill đơn demo, invoice hay wallet.
- Chỉ enroll linh kiện FIXHOME khi nhận QR hợp lệ, đơn được tạo **sau**
  `part_custody_activation.activated_at`, thời điểm nhận cũng sau mốc này, đơn chưa
  đóng, chưa yêu cầu hoàn tất và chưa có invoice. Đơn đang làm trước mốc vẫn legacy.
- Usage vẫn chỉ khi UNDER_REPAIR. Tracking nhận payload cũ `{usageStatus}` và tự
  ghi số lượng toàn dòng dưới khóa Order, hoặc nhận bộ `usedQty/expectedVersion/
  idempotencyKey` đầy đủ. Chỉ 0 hoặc toàn bộ quantity; partial usage bị từ chối
  vì cách lập invoice legacy tính USED theo toàn dòng. Không sửa số lượng/SKU/giá.
- First quotation vẫn EN_ROUTE sau check-in; không thêm gate usage cho báo giá.
  `assertPartsResolved` vẫn chặn completion/invoice khi usage còn PENDING.
- Khách vẫn PAID/COMPLETED sau các gate hiện có. Tracking không giữ wallet, tiền
  công, commission, invoice, payment, cash settlement hoặc withdrawal. Hai file
  production `wallet/settlement.service.ts` và `wallet/custody-settlement.ts` không đổi.
- Bất kỳ outstanding tracking nào chặn discovery, shortlist, phát invitation,
  Accept/auto-Accept và assignment qua `technicianEligibility`, không phụ thuộc
  tiền mặt/online hay thanh toán chưa. Đơn đang giữ/reschedule vẫn dùng bypass
  `keepingExistingOrder`. Không thu hồi lời mời đã phát từ trước; Accept kiểm lại.
- Phát invitation khóa các User theo ID tăng dần; Accept đã khóa User. QR, usage,
  declare/receipt khóa Order → User → custody. Chưa chứng minh concurrency trên PG.
- Declare không phải physical receipt. SM chỉ accept số lượng **thực nhận đủ điều
  kiện**, không quá phần đã khai. Partial receipt giữ phần thiếu. Missing/damaged
  ghi discrepancy; không tự nhận stock, xóa obligation, waive hay ghi tài chính.
  Chỉ nhận đủ hàng hợp lệ (hoặc khai USED hợp lệ trước khi frozen/declare) mới hết
  outstanding. Không có API miễn trừ nghĩa vụ.

## Hợp đồng cho WEB/Console

Giữ nguyên các route declare/accept và `GET /service-orders/:orderId/part-returns`.
`GET /part-returns/pending` của SM nay gồm mọi outstanding, kể cả chưa khai trả.
Thêm `GET /part-returns/mine` (TECHNICIAN), chỉ hàng của chính người giữ ban đầu,
kể cả đơn đã COMPLETED hoặc đã đổi thợ. Queue tối đa 100 dòng, cũ nhất trước.

Response thêm `trackingOnly`, `blocksNewWork`, `usageRecorded`, `discrepancies`.
`returnStatus`: `outstanding`, `declared`, `partially_received`, `exception`,
`received`, `not_required`. `exception` còn tới khi nhận đủ; thông tin exception
vẫn giữ trong lịch sử sau đó. Client phải hiển thị riêng khỏi status đơn của khách.

SM: `POST /part-requests/:requestId/items/:itemId/return-discrepancy`:

```json
{
  "declaredQty": 3,
  "observedQty": 0,
  "expectedVersion": 2,
  "idempotencyKey": "receipt-discrepancy-01",
  "reason": "Linh kiện bị hỏng, chưa nhận vào kho"
}
```

`observedQty` là số hàng tốt quan sát được, phải nhỏ hơn `declaredQty` đang chờ.
Discrepancy không tạo receipt; dùng accept-return riêng cho hàng tốt thực nhận.
Quantity 1–100 (observed có thể 0), version ≥0, key 8–128, reason 5–300 ký tự.
JWT + role và original ownership được giữ. Replay cùng key/body/actor trả kết quả
cũ; đổi nội dung/actor hoặc stale version bị từ chối. Không lưu raw reason vào
response/ledger, chỉ fingerprint và dấu có lý do.

Migration 038 đã có trigger `part_requests` cho READY/RECEIVED. Migration 043 bổ
sung trigger `part_request_items` (lookup `service_order_id` qua parent request)
và `part_custodies`; cùng channel `fixhome_changes`. Listener phát
`order:updated` với `kinds: ['part']` tới customer/current tech và original
custodian khi custody đổi. Không đổi socket event name, không truyền ledger/QR.
Console queue dùng REST refresh; chưa thêm socket broadcast riêng cho SM.

Đã đối chiếu nguồn WEB: usage gửi status-only; declare/accept đã gửi version/key.
Không sửa WEB; banner/exception rendering và việc refetch của client vẫn cần
consumer tích hợp. Mobile không có worktree khả dụng: NOT VERIFIED.

## Activation trong đợt phát hành riêng

Các bước sau là hướng dẫn, **chưa thực thi**:

1. Review/rehearsal migration 042 + 043 trên PG cô lập; giữ migration 039 trước đó.
   Không chỉ chạy 042/043 trên DB thiếu các migration nền. Kiểm tra activation còn
   `enabled=false`, `activated_at IS NULL`, custody/payout đều rỗng. Nếu đã có cohort
   P1 hoặc mốc activation cũ, dừng: cần kế hoạch cutover riêng, không reset ledger.
2. Deploy code đồng nhất các instance, không rolling cutover lẫn code cũ. Giữ
   `P1_CUSTODY_ENABLED=false`, cấu hình `PART_RETURNS_TRACKING_ENABLED=true` rồi
   restart backend có kiểm soát. Chưa ghi vào bất kỳ `.env` nào trong task này.
3. Trong release được phép, chuyển **chỉ** singleton
   `part_custody_activation.enabled` sang true. Trigger 039 tự ghi thời gian
   activation bằng đồng hồ DB; không tự điền hay sửa `activated_at`.
4. Tạo đơn mới sau activation, dùng QR bàn giao thật: kiểm USED/RETURNED, payment,
   customer completion, tech bị chặn việc mới, partial/damaged/missing và SM receipt
   đầy đủ/idempotent gỡ chặn. Kiểm cash và online; đối chiếu legacy wallet keys/sums.
   Hard-refresh client sau bản WEB tương ứng; xác minh manager queue qua REST.
5. Muốn dừng cohort mới: tắt DB `enabled`, giữ tracking flag ON để xem/trả/nhận
   nghĩa vụ đã ghi. Không tắt tracking flag hay bật P1 sau enrollment; startup sẽ
   từ chối. Down 042 khóa bảng và từ chối khi đã có tracking/discrepancy, không xóa
   dữ liệu để rollback. 043 chỉ gỡ trigger mới, giữ trigger/function 038.

Không thêm dependency hoặc đổi image/port. Docker chỉ cần rebuild trong đợt phát
hành thực tế khi chạy code mới; task này không chạy Compose hay restart preview.

## Kiểm chứng và giới hạn

Test units dùng storage giả: cohort/flag, whole-line usage và replay, permissions,
completion/first quote, receipt/exception, queue, eligibility, settlement cash/online,
listener batching và migration DDL contract. Typecheck/build chạy riêng.
Unit/DDL test không chứng minh trigger, DB locks, QR HTTP hoặc realtime socket thật.
Không chạy full suite/E2E, không dùng DB theo scope owner. PG migrations/rollback,
concurrency nhiều instance, Docker, browser và Web/Mobile parity: **NOT VERIFIED**.
Catalog paging/SKU/price source không sửa; số 792 hiện tại không được đọc lại từ DB.

Kết quả kiểm tra 20/10/2026:

| Kiểm tra | Kết quả |
| --- | --- |
| Targeted Vitest: 20 files, 184 tests, gồm context và migration DDL | PASS |
| `npm run typecheck` | PASS |
| `npm run lint`: 0 errors, 1 warning cũ ở migration 0022 | PASS |
| `npm run build -- --path <relative-temporary-tsconfig>`; có emitted `main.js` | PASS |
| `git diff --check` | PASS |
| PostgreSQL/HTTP/socket/browser, Docker, Web/Mobile parity | NOT VERIFIED |

Build dùng config tạm kế thừa `tsconfig.build.json`, chỉ đổi `outDir` sang TEMP;
không xóa `dist` hoặc ảnh hưởng preview đang chạy. Nest trên Windows không tìm
được config khi truyền absolute path; chạy lại bằng relative path đã PASS.
Context gate ban đầu phát hiện 41 log entries; đã bỏ entry cũ nhất theo section 0,
giữ 40, không sửa test. Đã loại import thừa do thay đổi này; warning migration 0022
được giữ ngoài phạm vi.

Lệnh targeted chính xác:

```powershell
npx vitest run src/config/env.validation.spec.ts src/modules/part-requests src/modules/bookings/technician-eligibility.spec.ts src/modules/bookings/activate-next-invitation.spec.ts src/modules/bookings/invitations-concurrent-accept.spec.ts src/modules/bookings/invitations-auto-accept.spec.ts src/modules/messaging/realtime-change.listener.spec.ts src/modules/wallet/custody-settlement.spec.ts src/modules/wallet/settlement.service.spec.ts src/modules/service-orders/parts-billing.spec.ts src/modules/service-orders/order-booking-lifecycle.spec.ts src/modules/service-orders/order-completion-effects.spec.ts src/modules/quotations/quotations.service.spec.ts test/migrations/part-returns-tracking.migration.spec.ts test/context-doc.spec.ts
```

Review nguồn: BA/PM đối chiếu scope mới/legacy và payment; CTO/Tech Lead kiểm
module/service/state machine và chế độ tài chính; Senior/Security kiểm ownership,
quantity/version/replay và ledger bất biến; Tester/QA đối chiếu các test trên;
DevOps kiểm migration dormant và build tạm. Đây là các góc nhìn tự review,
không phải review độc lập hoặc chứng nhận runtime. Trạng thái: implementation
backend hoàn tất trong scope, activation và runtime chưa thực hiện.

## Tệp thay đổi chính xác

Production:

- `src/config/env.validation.ts`
- `src/modules/bookings/activate-next-invitation.ts`
- `src/modules/bookings/technician-eligibility.ts`
- `src/modules/messaging/realtime-change.listener.ts`
- `src/modules/part-requests/dto/part-return.dto.ts`
- `src/modules/part-requests/entities/part-custody.entity.ts`
- `src/modules/part-requests/part-custody.policy.ts`
- `src/modules/part-requests/part-custody.service.ts`
- `src/modules/part-requests/part-requests.module.ts`
- `src/modules/part-requests/part-requests.service.ts`
- `src/modules/part-requests/part-returns.controller.ts`
- `src/database/migrations/1790000000042-PartReturnsTracking.ts`
- `src/database/migrations/1790000000043-PartItemRealtime.ts`

Tests:

- `src/config/env.validation.spec.ts`
- `src/modules/bookings/activate-next-invitation.spec.ts`
- `src/modules/messaging/realtime-change.listener.spec.ts`
- `src/modules/part-requests/part-custody.policy.spec.ts`
- `src/modules/part-requests/part-custody.service.spec.ts`
- `src/modules/part-requests/part-return-workflow.spec.ts`
- `src/modules/wallet/custody-settlement.spec.ts`
- `test/migrations/part-returns-tracking.migration.spec.ts`

Documentation:

- `docs/CONTEXT.md`
- `docs/PART-RETURNS-TRACKING.md`


## DEV VPS activation note (20/10/2026)

The `dev` deploy workflow uses `docker-compose.part-returns.dev.yml` as a
non-secret override alongside the VPS `docker-compose.prod.yml`, forcing
`PART_RETURNS_TRACKING_ENABLED=true` and `P1_CUSTODY_ENABLED=false`.
Do not use the production Compose file alone for a manual restart once tracking
rows exist: that would omit the opt-in and fail the custody startup check.
This deployment switch does NOT activate the DB singleton/cohort by itself.
