# P1 Phase B — mã cô lập, chưa kích hoạt

`P1_CUSTODY_ENABLED=false` mặc định. Không deploy, chạy migration trên DB dev dùng chung, backfill hay bật tính năng trong đợt này. Migration `1790000000039-PartCustody.ts` chỉ được thực thi trong PostgreSQL dùng một lần khi kiểm thử.

## Phạm vi đã viết

- Bốn bảng cộng thêm: `part_custody_activation`, `part_custodies`, `part_custody_entries`, `part_custody_payouts`. Migration tạo singleton **inactive**, không sửa hóa đơn, ví, trạng thái hay linh kiện cũ. Timestamp kích hoạt do PostgreSQL đặt một lần; custodian, cohort và số lượng cấp không đổi. Ledger chỉ thêm; unique theo item, command key/version và invoice/component.
- Chỉ QR receive thành công sau activation mới enroll item FixHome, cùng transaction bàn giao; không enroll đơn đã đóng, đã yêu cầu hoàn tất hoặc đã có hóa đơn. Không tạo API activation. Chạy migration không tự mở cohort. Timestamp dùng độ chính xác millisecond để khớp `Date` của Node.
- `PartCustodyModule` chỉ đăng ký khi flag bằng đúng chuỗi `true`; activation thiếu/inactive thì API trả 503. Startup từ chối flag OFF nếu đã có cohort, tránh quay về legacy settlement làm mất hold hoặc cộng trùng tiền. DB chưa có migration vẫn khởi động bình thường khi flag OFF.
- Command dùng khóa `ServiceOrder → User của custodian → custody`, unique key và lưu nguyên response để replay. Manager chỉ nhận số dương, không vượt khai báo hay outstanding. Biên nhận lưu actor/time/count; khai báo không giảm outstanding.
- Route usage hiện hữu nhận thêm `usedQty`, `expectedVersion`, `idempotencyKey` cho item P1. Phải gửi đủ ba trường và `usageStatus` phù hợp (`usedQty > 0` là `used`, bằng 0 là `returned`). Giữ nguyên `quantity` gốc và semantics legacy. Hóa đơn mới dùng lượng đã dùng trong từng nguồn phê duyệt; hóa đơn đã tồn tại được giữ nguyên. Usage không đảo ngược và bị khóa khi invoice/completion request/đơn đóng. Không expose command discrepancy/disposition của domain Phase A.
- CASH: `technicianEligibility` được gọi lại sau User lock trong Accept/auto-Accept và các đường assign/override/replace; không dựa danh sách ứng viên hay token. `declareCashSettlement` giữ cùng User lock đến commit. Lệnh rút kiểm tra trong `openAndDebit`, trước wallet lock/debit; không gọi payout khi bị chặn. Bản ghi khai tiền mặt của custodian trên đơn có custody outstanding là đủ, không cần khách xác nhận, kể cả cash đang disputed. `keepingExistingOrder` bỏ qua gate này.
- ONLINE: `SettlementService` khóa Order rồi chọn custody branch trước legacy idempotency. Ledger riêng `NONLABOR` và `NET_LABOR`; key theo invoice/component, reference type `P1_SERVICE_ORDER`. Nonlabor = thu nhập legacy trừ `(laborTotal - commissionAmount)`, không tạo giá/phí mới. Chỉ NET_LABOR bị giữ tới khi toàn bộ custody của đơn hết outstanding. Hóa đơn/đơn PAID/COMPLETED độc lập. Legacy whole-order transaction trên P1 gây deferred conflict, không cộng thêm. Callback đi chung settlement; sweep không loại đơn chỉ vì đã credit nonlabor và bỏ qua khi đủ hai component.
- Khi manager nhận đủ, sweep thực hiện release; instance từng thấy hold có backoff hiện hữu 15 phút, cộng lịch tick. Không cam kết release tức thì qua UI.

## API cho Web

Tất cả dưới `/api/v1`, giữ envelope hiện hữu. GET trả `data` là array; POST trả `data` là record. Không trả PII khách.

| Method/path | Quyền | Body |
| --- | --- | --- |
| `GET /service-orders/:orderId/part-returns` | Custodian gốc hoặc Service Manager | — |
| `POST /part-requests/:requestId/items/:itemId/declare-return` | Custodian gốc | `{quantity, expectedVersion, idempotencyKey}` |
| `POST /part-requests/:requestId/items/:itemId/accept-return` | Chỉ Service Manager | `{quantity, expectedVersion, idempotencyKey}` |
| `GET /part-returns/pending` | Chỉ Service Manager | — |

Record gồm `id`, `orderId`, `partRequestId`, `partRequestItemId`, `technicianId`, `partNameSnapshot`, `issuedQty`, `usedQty`, `declaredQty`, `managerAcceptedQty`, `outstandingQty`, `version`, `returnStatus`, `cohortActivatedAt`, `handedOverAt`, `receipts[{quantity,actorUserId,acceptedAt}]`. `returnStatus`: `outstanding`, `declared`, `partially_received`, `received`, `not_required`. `quantity` là lượng tăng thêm cho mỗi khai báo/biên nhận, không phải tổng lũy kế; `usedQty` là tổng đã dùng. Queue chỉ có dòng đã khai nhưng chưa nhận đủ, cũ trước, tối đa 100 dòng. Cùng key/body/actor trả response gốc; đổi body/key dùng lại hoặc stale version trả 409. Body thêm field bị 400; actor lấy từ JWT và vai trò hiện tại trong DB.

## Gate còn chặn activation

Giữ flag OFF. Các test PostgreSQL cô lập kiểm đường chính, không phải chứng nhận production:

1. Cần kiểm hết ma trận deadlock/retry nhiều instance: Accept thay thế có thể lấy `Booking → User → ServiceOrder`; QR/receipt/cash lấy `ServiceOrder → ... → User`; một số callback/chi trả ví khách lấy Invoice trước Order. Đợt này không viết lại toàn bộ finance/assignment lock order. Test race hiện tại chứng minh tranh User lock cho cash declaration/Accept/withdraw, chưa chứng minh mọi thứ tự khóa và mọi đường override/replace.
2. Finance test gọi boundary thật `markInvoicePaidOnline`, settlement và `sweepPaidOrders`; không gọi VNPay/payOS, chưa chứng minh toàn bộ adapter IPN/querydr/network retry. Chưa kiểm rolling deployment với instance legacy còn chạy; **không được có mixed-version writer khi cutover**. Không hot-toggle flag; startup guard chỉ bảo vệ tiến trình mới.
3. Chưa có phối hợp triển khai Web/Mobile/docs repo, browser QA, Docker app rebuild/health với cấu hình sandbox đầy đủ. Không chạy Docker Compose của repo vì đọc `.env` và có thể nối DB/provider dùng chung.

## Kiểm thử lặp lại an toàn

`test/p1-custody-isolated.e2e-spec.ts` chỉ nhận port qua `P1_DISPOSABLE_POSTGRES_PORT`, dùng host local cố định và tài khoản/DB/password giả cố định trong test. Không import AppModule, dotenv hay project data-source. Test phải chạy trên container PostgreSQL 16 **mới**, DB `fixhome_p1_disposable`, user `fixhome_p1_test`; không tái dùng DB đã kích hoạt. Không đổi test để dùng credential môi trường.

Sau `npm run build`, đặt port container rồi chạy `npx vitest run --config vitest.config.e2e.ts test/p1-custody-isolated.e2e-spec.ts`. Không đặt port thì suite này skip. Stop/remove đúng container đã tạo sau khi chạy, kể cả test lỗi. Unit suite: `npm test`; gate khác: lint/typecheck/build. Full `npm run test:e2e` chưa chạy trong workspace này vì các suite cũ import AppModule có thể đọc `.env`; không trỏ chúng vào DB chung.

## Migration / rollback sau này

Chỉ sau review concurrency, đồng bộ consumer và phê duyệt riêng mới xem xét migration/cutover ở môi trường được phép. Không có lệnh activation cho dev dùng chung trong bàn giao này. Deployment cần dừng writer legacy, migration kiểm tra trạng thái inactive, rồi một cutover timestamp duy nhất trước khi QR mới enroll. Không backfill hàng đã bàn giao; đối chiếu cũ làm thủ công riêng. `down` chỉ cho schema chưa kích hoạt và chưa có dữ liệu; sau cutover từ chối rollback mất audit/earnings. Không đổi hóa đơn hay trừ ví để xử lý linh kiện thiếu/hỏng.
