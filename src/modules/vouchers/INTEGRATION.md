# Voucher T2.1 — handoff Backend, 27/10/2026

Trạng thái source: **safe-to-integrate YES**, sau review tài chính độc lập và các gate
bên dưới. Trạng thái DEV runtime: **NOT VERIFIED**. Không stage/commit/push/merge/deploy,
không đọc secret, không kết nối hay ghi DEV DB trong lượt implementation này.
Giữ nguyên nền T2 đã dirty/untracked và Toàn AI/T1.

## Contract T2.1 hiện tại

- `GET /vouchers/checkout-preview/:claimId/:scopeId` chỉ đọc; `previewOnly=true`.
  `paymentAvailable` phản ánh schema readiness; `reason=null` khi schema sẵn sàng,
  ngược lại `VOUCHER_FUNDING_NOT_READY`. Preview không giữ quota hay xác nhận thanh toán.
- `POST /vouchers/apply` lấy bằng chứng hóa đơn frozen dưới khóa, kiểm owner, nguồn duyệt,
  thiết bị thành công và không có collection attempt cũ. FAILED/CANCELLED không tự chứng minh
  tiền đã được trả lại; nguồn legacy đang đối soát phải được xử lý trước khi APPLY.
- `POST /finance/funded/solo/:id/{wallet,vnpay,zero-closeout}` dùng **invoice ID**;
  `solo/:id/cash/{declare,confirm}` dùng **service order ID**.
  `POST /finance/funded/visit-groups/:id/{wallet,vnpay,zero-closeout,cash/declare,cash/confirm}`
  dùng **VisitGroup ID**. Body phải có `voucherReservationId`; không nhận discount/customerDue
  do client tự tính. CASH declare thêm `declaredAmount`; confirm thêm `agreed` và lý do dispute
  tùy chọn, không nhận số tiền xác nhận do client tự cung cấp.
- Cả 10 funded route giữ JWT, role, permission và ownership. Guard mới kiểm tra service
  ví/quyết toán có mặt, đúng migration ledger, bảng/cột và quyền SELECT/INSERT thực tế,
  không bị RLS chặn. Thiếu điều kiện trả 503; không chạy migration hoặc cấp quyền tự động.
  Callback khoản đã thu không phụ thuộc guard mở giao dịch mới.
- WALLET trừ đúng customer NET; VNPAY ký đúng NET; CASH chỉ credit đủ subsidy vào ví
  kỹ thuật viên sau khách xác nhận. Credit vẫn giảm được khoản nợ của ví âm. ZERO không
  tạo giao dịch VNPay 0 đồng hoặc trừ ví khách. Journal/quota dùng chung transaction với
  payment/invoice; unique journal và khóa reservation ngăn tác động tiền lặp lại.
- Invoice gross, commission snapshot, PlatformDue và technician entitlement gốc được giữ.
  Chỉ hóa đơn của thiết bị thành công được phân bổ trong VisitGroup.
- Các entry point collection gross cũ chặn scope còn RESERVED dưới khóa hóa đơn. Hai
  đường CASH confirm kiểm lại trong transaction để declaration mới không bị ghi nhầm dispute.
  Manager CASH legacy không được biến funded dispute thành gross settlement thiếu subsidy.
- Hash allocation được canonical hóa theo key trước SHA256 để JSONB round-trip không làm
  hỏng bằng chứng; sửa giá trị tiền vẫn bị từ chối.
- F1 kiểm HMAC, merchant/attempt/amount và PayDate ICT nghiêm ngặt. Thanh toán trong cửa sổ
  hợp lệ có thể nhận callback muộn. Status `01` giữ pending và chờ terminal; status `02`
  chỉ nhả theo danh sách response không thu tiền đã nhận diện. `07`, trạng thái đảo/hoàn tiền,
  dữ liệu mâu thuẫn, thời điểm không hợp lệ hoặc thiếu chứng cứ giữ đối soát, không thu thêm
  phần giảm giá. Tham chiếu: [VNPay 2.1.0](https://sandbox.vnpayment.vn/apis/files/VNPAY%20Payment%20Gateway_Techspec%202.1.0-VN.pdf).
- Reservation chưa có link chỉ release/expire khi chứng minh lại không có collection.
  CASH đã khai hoặc VNPay pending/unknown không được tự nhả chỉ vì hết 15 phút.
- F3 WALLET/ZERO giữ `SupportCase.amount` là **customer NET** và yêu cầu manager duyệt riêng
  `grossRefundVnd`; phân bổ reversal theo invoice và làm tròn từ tổng tích lũy. Chỉ hoàn đủ
  toàn scope mới khôi phục quota/claim một lần. **CASH/VNPAY original-rail refund vẫn bị chặn**:
  credit ví không phải bằng chứng hoàn tiền mặt hoặc hoàn về ngân hàng. Không có refund giả.

## Follow-up TECHNICIAN CASH — contract Web, 27/10/2026

- `GET /finance/funded/solo/:id/cash/reservation`: `id` là **serviceOrderId**.
- `GET /finance/funded/visit-groups/:id/cash/reservation`: `id` là **visitGroupId**.
  Dùng cùng API base `/api/v1` hiện có; không đổi casing của path/field.
- JWT + role `TECHNICIAN` (giá trị enum runtime `technician`) + permission
  `order:read_related`. SOLO phải được phân công active; group phải phụ trách active
  **mọi invoice billable**. Kiểm lại customer/scope/assignment sau khóa invoice.
  Không trả claim, customer, policy hay thông tin riêng tư.
- `200`, `Cache-Control: no-store`, response đúng hai field trong `data`:

  ```json
  {"data":{"voucherReservationId":"<uuid>","customerDueVnd":50000}}
  ```

  Đây là phần `data` của envelope chung có `success`, `statusCode`, `message`;
  interceptor không thêm một lớp `data` nữa.
  Chỉ trả funded khi đúng một reservation `RESERVED`, chưa hết hạn theo giờ DB,
  frozen invoice và quote CASH hợp lệ, chưa có collection evidence. Tiền là số nguyên VND
  server tính; không dùng invoice gross hoặc tự trừ discount ở client.
- NONE dùng sentinel rõ ràng, không có `status` mới:

  ```json
  {"data":{"voucherReservationId":null,"customerDueVnd":null}}
  ```

  Chỉ sentinel này cho phép UI chọn flow CASH gross hiện có. `null` không phải 0 đồng.
  Không có live `RESERVED`/`REDEEMED`, invoice vẫn phải frozen/unpaid và không có attempt
  cần đối soát. GET đọc lại reservation sau khóa để không trả NONE từ snapshot trước Apply.
- `401` thiếu xác thực; `403` sai role/permission; `404` không thuộc công việc hoặc sai scope;
  `409` ambiguous/expired RESERVED/REDEEMED, quote đổi, ZERO hoặc collection đã tồn tại
  (kể cả attempt legacy FAILED/CANCELLED chưa chứng minh hoàn tiền); `503` chưa sẵn sàng.
  **Không fallback sang gross trên bất kỳ lỗi nào.** `409` yêu cầu tải lại trạng thái;
  declaration đã có thì hiển thị trạng thái đó, không hướng dẫn thu lần hai.
- UI đọc GET ngay trước khai tiền; khi funded, gửi nguyên `voucherReservationId` và
  `declaredAmount=customerDueVnd` vào `POST` CASH declare tương ứng ở contract trên.
  POST vẫn tự kiểm lại reservation/amount/ownership; GET không giữ giá, gia hạn voucher,
  ghi declaration hay cho phép bỏ qua xác nhận khách. Nếu khách Apply sau GET NONE,
  gross POST vẫn bị chặn bởi guard RESERVED dưới khóa invoice; tải lại thay vì thu gross.
- ZERO dùng customer zero-closeout, không khai CASH 0 đồng. Subsidy chỉ credit sau khách
  xác nhận đúng một lần. F3 CASH/VNPAY refund giữ fail closed khi thiếu original-rail proof.
- Không đổi migration, env, dependency, refund hoặc POST contract. Lead cập nhật
  `docs/CONTEXT.md` trong PR; Web/Mobile runtime và PostgreSQL locks: **NOT VERIFIED**.

File thay đổi riêng follow-up: `finance/finance.service.ts`, `finance/finance.controller.ts`,
`finance/dto/voucher-funding.dto.ts`, hai test `finance/voucher-cash-reservation.spec.ts`,
`finance/voucher-cash-reservation.controller.spec.ts` và handoff này (đều dưới `src/modules/`).

Kiểm chứng follow-up:

- RED → GREEN cho service/HTTP lookup và race Apply đồng thời SOLO/GROUP.
- Focused + review độc lập: **4 files / 88 tests PASS**; review code **safe-to-integrate YES**.
- `npm test`: **223 files PASS, 1 skipped; 2307 tests PASS, 11 skipped**, exit 0.
- `npm run typecheck`, `npm run build`: **PASS**, exit 0.
- `npm run lint`: **PASS**, 0 errors, giữ nguyên 2 warning cũ ngoài scope.
- Hash 64 file nền: chỉ 4 file hiện hữu nêu trên thay đổi; thêm đúng 2 test mới.
  Migration và các phần nền khác giữ nguyên; không thao tác staging/commit/release/DB.
- HTTP smoke dùng principal test với guard role/permission thật, không chứng minh chữ ký JWT.
  PostgreSQL isolated/e2e, Web/browser và DEV runtime: **NOT VERIFIED** theo phạm vi/waiver.
  Lead restart Backend trước manual E2E; cập nhật Web để dùng lookup contract này.

## Migration và giới hạn release

- Theo handoff owner, `VoucherCore1792994400000` và `RepairFailureRebook1790000000053`
  **đã apply DEV**. Không chạy lại, sửa hoặc đánh dấu lại hai migration đó.
- Migration mới `VoucherFundingLedger1792994400001` **chưa chạy**. Đã review DDL tĩnh;
  phụ thuộc VoucherCore, VisitGroupPayments, wallet/customer-wallet và support_cases.
  Thêm immutable link/journal, gross refund column và REFUNDED; không backfill tiền.
  `down` từ chối rollback để giữ lịch sử, phải dùng forward migration đã review.
- Lead kiểm ledger/pending migrations, apply riêng phần mới đúng một lần bằng quy trình
  release được duyệt, rồi restart Backend và kiểm `/health`. Không dùng readiness để bỏ
  qua schema, không bật synchronize, không nới auth/RLS. Không có dependency/env/image mới.
- Owner đã miễn isolated PostgreSQL tests và tự QA E2E sau deploy. PostgreSQL DDL execution,
  deferred triggers, nhiều instance/row locks/concurrency và Docker/HTTP/provider thật:
  **NOT VERIFIED**. Một số đường khóa group/order và invoice khác thứ tự có thể deadlock
  rồi rollback/retry; test doubles không chứng minh hành vi PostgreSQL.
- Funded querydr chưa có verifier riêng được chứng minh; giữ fail closed, không nhận
  response querydr như IPN đã xác minh. Không tuyên bố fallback/hoàn tiền provider hoạt động.
- Web là writer khác; Web/Mobile parity và browser QA: **NOT VERIFIED**. Web phải đọc lại
  trạng thái server sau callback; không coi browser return/preview là hóa đơn PAID.
- `docs/CONTEXT.md` nằm ngoài scope writer này. Lead phải cập nhật theo section 0 trong
  cùng PR và phối hợp context Web/Mobile/docs trước release.

## Kiểm chứng lượt implementation

- `npm test`: **PASS**, 221 files pass, 1 file skip; 2253 tests pass, 11 tests skip.
- `npm run typecheck`: **PASS**, exit 0.
- `npm run lint`: **PASS**, 0 errors; 2 warning cũ ngoài scope.
- `npm run build`: **PASS**, exit 0.
- `git diff --check`: **PASS**, chỉ cảnh báo LF/CRLF của Git.
- Review độc lập cuối: **PASS**, 19 files / 158 tests, không thấy blocker source mới.
- `npm run test:e2e`, PostgreSQL, Docker, DEV deploy và manual E2E: **NOT VERIFIED**;
  không chạy theo phạm vi/waiver của owner.

## File do writer hoàn thiện trong lượt này

Đường dẫn tương đối từ root; không bao gồm các file nền T2 giữ nguyên từ handoff.

```text
src/modules/finance/finance.controller.ts
src/modules/finance/finance.service.ts
src/modules/finance/funded-finance.controller.spec.ts
src/modules/finance/voucher-collection-exclusion.spec.ts
src/modules/finance/voucher-readiness.spec.ts
src/modules/support-cases/support-cases.service.ts
src/modules/support-cases/support-cases.service.spec.ts
src/modules/support-cases/voucher-cash-resolution.spec.ts
src/modules/vouchers/INTEGRATION.md
src/modules/vouchers/repair-failure-voucher-evidence.ts
src/modules/vouchers/vouchers.service.ts
src/modules/vouchers/voucher-allocation-digest.ts
src/modules/vouchers/voucher-funding-readiness.ts
src/modules/vouchers/voucher-checkout-evidence.spec.ts
src/modules/vouchers/voucher-preview-readiness.spec.ts
src/modules/vouchers/voucher-payment-link.ts
src/modules/vouchers/voucher-refund-commit.ts
src/modules/vouchers/voucher-cash-credit.ts
src/modules/vouchers/voucher-cash-credit.spec.ts
src/modules/vouchers/voucher-settlement-evidence.ts
src/modules/vouchers/voucher-settlement-evidence.spec.ts
src/modules/vouchers/voucher-provider-ledger.ts
src/modules/vouchers/voucher-provider-ledger.spec.ts
src/modules/vouchers/voucher-vnpay-evidence.ts
src/modules/vouchers/voucher-vnpay-evidence.spec.ts
```

## Lịch sử V-BE trước T2.1

Phần bên dưới giữ nguyên để truy vết lane V-BE cũ, **không** đại diện trạng thái release
hiện tại. Các phát biểu fail-closed/migration chưa chạy và checklist cũ bên dưới được
thay thế bởi contract T2.1 và trạng thái migration nêu phía trên.

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
