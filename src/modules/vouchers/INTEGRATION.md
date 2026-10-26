# Voucher V-BE — tích hợp T2 source

Module độc lập trên base `290e2f46e559928083bb0637e8d0e1ab37c9d8b5`.
Phạm vi: `src/modules/vouchers/` và migration cộng thêm chỉ cho voucher
`src/database/migrations/1792994400000-VoucherCore.ts`. Integration đã đăng ký
`VouchersModule` vào AppModule; migration chưa chạy trên shared DEV. Không thay
finance/service-orders/payments. Checkout, settlement và release tiếp tục fail closed;
failure chỉ đọc sự cố đã ghi bền vững từ R-BE.

## Contract hiện có

- Admin: `POST /api/v1/vouchers/campaigns`, `GET /api/v1/vouchers/campaigns`,
  `PATCH /api/v1/vouchers/campaigns/:id/status`. Policy bất biến sau create;
  muốn đổi percent/fixed/cap/minimum/category/service/time/quota thì tạo campaign mới.
  Create DTO thêm `autoCompensation?: boolean` (mặc định false; checkbox Web Sol).
  Chỉ PERSONAL được true; DB unique partial index chỉ cho một campaign
  `autoCompensation=true, active=true`. Muốn đổi policy: tạm dừng campaign cũ rồi
  tạo campaign mới. Admin list trả field này để Console chỉ rõ cấu hình còn thiếu.
- Admin cấp PERSONAL thủ công: `POST /api/v1/vouchers/campaigns/:id/grants`
  `{customerId: uuid-v4, grantId: uuid-v4}`. Chỉ ADMIN; campaign phải PERSONAL và
  đang hoạt động; customer phải active. `grantId` là khóa idempotency cho lần cấp,
  duy nhất xuyên campaign và không đại diện sự cố sửa chữa. Retry cùng campaign,
  customer, grantId trả đúng claim cũ; đổi owner/campaign bị từ chối.
- Customer: `GET /api/v1/vouchers/general`, `GET /api/v1/vouchers/wallet`, `POST /api/v1/vouchers/claim {code}`,
  `POST /api/v1/vouchers/apply {claimId, scopeId, attemptId}`,
  `POST /api/v1/vouchers/reservations/:id/release`. JWT + RolesGuard;
  claim và APPLY có ThrottlerGuard cục bộ 5 lần/phút theo IP, độc lập theo route.
  Không có HTTP issue/redeem.
- `GET /general` chỉ CUSTOMER, trả tối đa 100 campaign GENERAL active trong cửa sổ
  thời gian DB, chưa có claim của chính customer. Mỗi item chỉ có
  `{id,code,name,startsAt,endsAt,policy:{discount,value,capVnd,minimumVnd,categoryIds,serviceIds,components}}`.
  Không trả quota/counter, owner/source hoặc cam kết áp dụng được ở checkout.
  Web/Mobile dùng `code` để gọi `POST /claim`; response theo envelope API hiện có.
- Các list giới hạn 100 bản ghi; pagination chưa có.
  Wallet/claim trả projection CUSTOMER: id, campaignId, status CLAIMED/REDEEMED,
  redeemedAt, policySnapshot với danh sách field tường minh và campaign code/name/kind/start/end/active.
  CLAIMED không có nghĩa là còn eligible. APPLY/release chỉ trả reservation id, campaignId,
  claimId, scopeId, attemptId, state, reservedAt, expiresAt và policySnapshot đã lọc.
  Không trả sourceKey, customerId, checkoutSnapshot, settlementId, provider IDs, counters,
  createdAt/updatedAt hoặc JSON field nội bộ. Adapter issueCompensation/redeemSettled vẫn
  giữ entity nội bộ; không expose qua HTTP. Không có counter remaining giả lập trong response.
  Không suy ra expired
  từ thời điểm thiết bị, không dùng counter client để quyết định quota.
- GENERAL: một claim/customer/campaign, dùng thành công tối đa một lần.
  CLAIM không kiểm tra/trừ quota thanh toán. APPLY kiểm tra `redeemed + RESERVED < quota`.
  `REDEEMED` là số lượt settlement thành công, không phải số claim.
- PERSONAL: hook nội bộ `issueCompensation(campaignId, incidentId)`;
  adapter đọc receipt `VISIT_DEVICE_REPAIR_FAILED` liên kết đúng support case,
  order, booking và owner, rồi resolve thành `VISIT_GROUP:<uuid>` hoặc `SOLO:<orderId>`.
  Admin grant dùng nguồn `ADMIN_GRANT:<grantId>` độc lập, không tạo fake incident.
  Một nguồn chỉ có một claim trên toàn bộ campaign, không chỉ trong một campaign.
  Nhiều lượt thất bại khác nhau của cùng khách có thể nhận nhiều PERSONAL.
  Khác campaign cho nguồn đã phát trả conflict, không cấp lại.
  Event draft nội bộ `RepairFailureVoucherEvent` chỉ mang type `REPAIR_FAILURE_ELIGIBLE_V1`
  và `incidentId`, vào `handleRepairFailure(campaignId,event)`. Event không mang owner,
  eligibility verdict hoặc source; `VoucherEvidence.failure` phải đọc sự cố persisted,
  kiểm tra đủ điều kiện và chuẩn hóa nguồn. Hai incident/child cùng VisitGroup => một claim;
  SOLO dùng định danh lượt sửa ổn định do repair contract xác minh, không ID lần retry.
  `reportRepairFailed` gọi cấp sau khi transaction sự cố commit, lấy campaign
  PERSONAL active được Admin đánh dấu. Audit receipt nghiêm ngặt là nguồn catch-up:
  background sweep mỗi phút tìm incident chưa có claim theo group/solo và thử lại.
  Thiếu cấu hình hoặc cấp lỗi được ghi warning vận hành, không làm rollback báo cáo
  sửa chữa và không tạo voucher giả. Giới hạn batch 1000 incident/lượt; runtime
  nhiều instance và PostgreSQL thực của luồng này: NOT VERIFIED.
- Snapshot lưu cả LABOR và PARTS, không loại nguồn linh kiện TECHNICIAN.
  Không có phép tính discount/customerDue, allocation hay bút toán tiền trong module.
- APPLY TTL đúng 900.000 ms theo đồng hồ PostgreSQL; retry giữ nguyên ID/deadline/state.
  Đổi checkout phải release thành công, rồi dùng attemptId mới. Attempt terminal không
  được tái sử dụng để tạo hold mới. Một scope chỉ có một voucher RESERVED/REDEEMED;
  đây là giới hạn bảo vệ hiện tại, không phải phê duyệt chính sách stacking tương lai.
- Pause/endsAt chặn claim/issue/APPLY mới; hold đã cấp được giữ nguyên deadline 15 phút,
  không gia hạn theo campaign. Retry trả trạng thái cũ, không khẳng định còn eligible.
- Hết hạn chỉ EXPIRED khi `canRelease(...) === true` từ dữ liệu server trong transaction.
  Payment pending/unknown giữ quota bị chặn, không chuyển thành available; không tự kéo TTL.
  `expireCampaign` là entry point sweep nội bộ, chưa được nối background job.
- `redeemSettled(settlementId)` chỉ đọc proof từ adapter server, kiểm tra reservation,
  customer, scope, immutable snapshot, SETTLED và thời điểm. Callback tới lúc đã hết TTL
  bị chặn kể cả settledAt trước đó: không tự quyết late VNPay. Callback replay đã redeem
  trả cùng reservation; không thêm quota/audit. Release không đảo REDEEMED.

## Migration và expiry strategy

`VoucherCore1792994400000` tạo bốn bảng voucher, không sửa bảng/dữ liệu hiện có.
Đã rehearsal trên PostgreSQL 16 cô lập; chưa apply shared DEV/Supabase hoặc deployment.
Migration tạo các unique/FK/check/index/trigger sau:

- Unique code; GENERAL `(campaign_id,customer_id)`; PERSONAL `(source_kind,source_id)`
  toàn campaign, gồm `ADMIN_GRANT`. SourceKey nội bộ phải khớp chính xác cặp nguồn; `campaign_kind` + FK
  `(campaign_id,campaign_kind)` giữ GENERAL không có nguồn và PERSONAL bắt buộc có nguồn.
- FK users; FK tổng hợp reservation `(claim_id,campaign_id,customer_id)` tới claim;
  unique customer/attempt, live claim/scope và settlement. Không FK sang finance hoặc
  repair incident chưa chốt contract; adapter phải xác minh các tham chiếu đó.
- CHECK policy JSON, time window, quota, state, đúng 15 phút và checkout identity.
  Trigger giữ campaign policy, claim identity và reservation snapshot/deadline bất biến;
  trạng thái terminal không đảo. Audit append-only; không xóa lịch sử voucher.
- Campaign `FOR UPDATE` trong service và insert trigger; reservation chỉ tạo khi còn
  `redeemed + RESERVED < quota`. Deferred constraint trigger kiểm tra cuối transaction:
  counter bằng số REDEEMED thật, claim redeemedAt khớp reservation và tổng hold/paid không
  vượt quota. Counter chỉ đổi cùng claim/reservation/audit; lỗi rollback toàn bộ.
- Index `(campaign_id,state,expires_at)` và `(customer_id,created_at)`; không dùng
  `now()` trong partial index. Tới deadline, hold vẫn chiếm capacity cho tới khi
  `canRelease` xác minh không có payment in-flight; khi chưa rõ phải giữ chặn.
- `expireCampaign` chạy dưới khóa campaign, audit cùng transaction; APPLY gọi cùng
  cleanup trước khi cấp hold. Lead cần nối sweep theo các campaign có RESERVED quá hạn,
  lặp lại các hold còn unknown. Không xóa row/attempt để reclaim quota. Scope có hold
  quá hạn ở campaign khác vẫn bị chặn cho tới khi campaign đó được sweep an toàn.
- `down` khóa các bảng, chỉ cho rollback schema rỗng; có bất kỳ lịch sử voucher thì
  từ chối, yêu cầu forward migration. Không cascade xóa dữ liệu.
- Adapter dùng EntityManager được truyền, không mở transaction riêng/gọi provider
  trong khóa DB. Chuẩn hóa thứ tự khóa với writer tích hợp; deadlock/serialization/unique
  trả conflict, retry cùng attempt. Không đổi auth/RLS hoặc grant quyền DB ở migration.

## Bằng chứng PostgreSQL cô lập

Harness `vouchers.postgres.spec.ts` opt-in bằng `VOUCHER_ISOLATED_PG=1`, mật khẩu chỉ
đọc từ biến tiến trình `VOUCHER_TEST_PASSWORD`, không có giá trị trong repo. Nó xác minh
container `fixhome_t2_qa_pg_20261026`, image `postgres:16-alpine`, binding loopback 55432,
database `fixhome_t2_voucher`, user `t2qa` trước khi reset đúng schema public của DB test.
Không nhận URL ngoài, không đọc `.env`, không kết nối DB `fixhome_t2_rebook`/Supabase,
không dừng/xóa container được owner cung cấp. Chạy bằng:

```text
VOUCHER_ISOLATED_PG=1 VOUCHER_TEST_PASSWORD=<set securely in process> npx vitest run src/modules/vouchers
```

Đã PASS: up/empty-down/up; PID kết nối khác nhau; 99 hold + hai request tranh slot 100/101
chỉ một thắng; claim 101 khách không tăng paid counter; 100 redeem + replay vẫn đúng 100;
TTL 900000ms; claim/apply retry; unique nguồn group khác campaign và SOLO; IDOR và JSON
whitelist; composite FK sai owner; policy/immutability/deferred counter; unknown expiry;
release-vs-settle và checkout khác campaign; audit lỗi rollback; down có dữ liệu bị chặn.
SQL/row lock/transaction là thật. Checkout/failure/settlement evidence là fixture server,
không chứng minh provider/authentic payment hoặc MONEY integration. Baseline chỉ tạo users
UUID fixture; toàn legacy migration chain, rolling deploy và JWT/Web/Mobile E2E: NOT VERIFIED.

## Checklist trước tích hợp

1. Lead review API, source canonical từ repair lane và migration; phối hợp timestamp/order
   với owner migration khác trước merge. ADMIN-only create/pause, customer ownership và
   safe response whitelist đã có test; không thêm quy tắc tenancy riêng giữa các Admin.
2. Focused PostgreSQL gate ở trên đã PASS; rehearsal toàn legacy chain/release compatibility
   còn NOT VERIFIED. Chưa apply migration ngoài đúng database test được owner chỉ định.
3. Failure adapter đã xác minh receipt REPAIR_FAILED và chuẩn hóa group/solo;
   producer sau commit và catch-up từ audit receipt đã nối.
   Còn cần checkout evidence authoritative: owner, finalized gross invoice,
   approved/billable/actual USED, loại failed child.
4. Finance gate riêng: funding theo labor và cả hai nguồn parts, commission, CASH PlatformDue,
   provider pending/late callback, refunds/zero due, stacking và allocation từng child.
   Module này chưa giải quyết các quyết định đó và không sửa gross invoice T1.
5. Settlement/quota/money cần chung transaction hoặc protocol bền vững đã review.
   Hiện `redeemSettled` sở hữu transaction voucher riêng, không phải bảo đảm nguyên tử
   với transaction finance bên ngoài. Không nối live money trực tiếp vào method này.
6. Module đã đăng ký, entity glob hiện có phát hiện metadata mới; synchronize=false,
   không tự tạo schema. Chưa nối sweep, checkout scope/payment evidence hoặc settlement hook.
7. Lead đồng bộ contract Web/Mobile/docs trong PR tích hợp. Hai màn GENERAL browse/claim và
   Admin PERSONAL grant trên Web: **NOT VERIFIED**, chưa được chứng minh đã nối client.
8. Lead review pending migrations rồi chạy `npm run migration:run` trên môi trường DEV được
   duyệt, sau đó restart Backend và kiểm `/health`. Lệnh này chạy **mọi** migration pending,
   gồm `RepairFailureRebook1790000000053` và `VoucherCore1792994400000`; phải kiểm ledger
   trước khi chạy. Shared DEV, signed-in Web/Mobile, JWT thật và full project E2E: **NOT VERIFIED**.
   Không commit/push/deploy từ worktree này.

Review BA/PM: D1–D3 trong domain, D4–D6 ngoài lane. CTO/Senior: module Nest riêng,
không dependency mới hay thay kiến trúc. Security: service kiểm tra lại role/ownership,
DTO từ chối field thừa, không public settle/issue, default fail closed. Tester: fake-clock,
negative/retry/rollback, HTTP guard smoke và PostgreSQL 16 test DB; không thay thế JWT/provider
thật. QA cross-platform: NOT VERIFIED. DevOps: không đổi image/env/config; chưa chạy Backend server.
