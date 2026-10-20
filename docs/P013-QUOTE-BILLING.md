# P013 — Báo giá, cấp linh kiện, hóa đơn và xác nhận miễn phí

Task: triển khai backend P013 trong worktree `foxonworld/fixhome-p013-quote-billing-20261020`, base `de64db978a511e0048db47f495967d32d0413a92`. Chỉ source/tests/docs; không commit/push, không ghi DB/env, không chạy provider thật, không sửa hóa đơn lịch sử. Design system 1.1.0; giữ thuật ngữ và thông báo tiếng Việt.

## Hợp đồng cho Web/Mobile

### Xác nhận hóa đơn miễn phí

- `POST /api/v1/invoices/:id/no-charge`, không cần body; `id` phải là UUID.
- JWT, role `customer`, permission `invoice:pay_own`; backend kiểm đúng khách của booking.
- HTTP 200 qua wrapper đang có:

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Success",
  "data": {
    "invoiceId": "<invoice UUID>",
    "paymentStatus": "paid",
    "settlementMethod": "NO_CHARGE"
  }
}
```

Client đọc lại đơn/hóa đơn sau thành công. Trạng thái thanh toán và trạng thái đơn độc lập: khi quản lý đang giữ hoàn tất vì khiếu nại, hóa đơn vẫn PAID nhưng đơn giữ UNDER_REPAIR. Socket invoice/order hiện có tiếp tục thông báo thay đổi.

Backend khóa order trước invoice. Lần đầu phải UNPAID, UNDER_REPAIR, có `completionRequestedAt`, đủ ảnh AFTER, có báo giá duyệt hoặc giá FIXED_PRICE thực sự bằng 0, không còn phê duyệt tài chính chờ xử lý. Mọi tổng snapshot và dòng hóa đơn phải hợp lệ và bằng 0; chi phí duyệt phải khớp nguồn cấp/USED/RETURNED. Linh kiện FixHome dương nhưng đã nhận và RETURNED hợp lệ có thể được loại khỏi tiền phải trả. Thiếu cấp kho/nhận hàng/khai dùng không phải lý do miễn phí. LABOR/TECHNICIAN/phí bảo hành/phí giao còn phải trả dương đều bị chặn.

Lần đầu ghi `INVOICE_NO_CHARGE_CONFIRMED` trong cùng transaction với PAID/hoàn tất, bảo hành và thông báo. Không tạo Payment hoặc cash settlement, không gọi VNPay/payment port, không gọi ví/settlement. Gửi lại chỉ thành công khi đã PAID bằng chính đường này và có audit tương ứng của khách; không ghi lại. Hóa đơn PAID cũ không có audit này trả conflict, không bị sửa.

Lỗi theo wrapper cũ: `OWNERSHIP_DENIED` 403; `NOT_FOUND` 404; `ORDER_INVALID_TRANSITION` 409 khi đơn chưa sẵn sàng; `CONFLICT` 409 khi dữ liệu không khớp/đã trả bằng cách khác; `EVIDENCE_REQUIRED_AFTER` khi thiếu ảnh; `VALIDATION_FAILED` 422 khi số tiền sai định dạng. Không dùng số tiền từ client để quyết định.

### Các kênh thanh toán

| Số phải trả | Kênh |
| --- | --- |
| 0 hợp lệ | Endpoint NO_CHARGE ở trên |
| 1–4.999 ₫ | Ví khách hoặc tiền mặt theo route cũ |
| Từ 5.000 ₫ | VNPay, ví khách hoặc tiền mặt theo điều kiện cũ |

`POST /invoices/:id/vnpay-url` chặn số dưới 5.000 ₫ bằng `VALIDATION_FAILED` 422 trước khi tạo Payment. LIVE/config vẫn là điều kiện riêng của VNPay. Nạp ví giữ tối thiểu 10.000 ₫. Các đường thanh toán tiền thực từ chối hóa đơn 0; callback cũ không được biến hóa đơn 0 lỗi thành PAID.

### Báo giá và yêu cầu linh kiện

- API duyệt báo giá giữ request/response cũ. Duyệt lại báo giá đã APPROVED giữ snapshot, không tự cấp bù cho dữ liệu lịch sử.
- Tạo báo giá và APPROVE kiểm số lượng dưới khóa order. Với mỗi SKU, khi PRE_REPAIR active đủ hàng thì một tập các dòng nguyên vẹn phải khớp số lượng báo giá; ví dụ một dòng 3 không thể duyệt 2, nhưng các dòng 3 + 2 có thể dùng dòng 2 và trả dòng 3. Nếu hàng ít hơn số lượng duyệt, phần thiếu vẫn cấp mới đúng số lượng. Lệch số lượng trả `CONFLICT` 409 trước khi lưu/supersede báo giá hoặc đổi snapshot duyệt, hướng dẫn chỉnh số lượng hoặc hủy yêu cầu còn REQUESTED trước khi lập lại báo giá. Không bật usage một phần.
- Khi APPROVE lần đầu dưới khóa order: cộng số lượng FixHome theo catalog SKU; trừ nguồn PRE_REPAIR còn REQUESTED/READY/DELIVERING/RECEIVED của đúng kỹ thuật viên đang phụ trách, loại dòng RETURNED và yêu cầu CANCELLED. ADDITIONAL không được tái dùng cho báo giá gốc.
- Chỉ phần thiếu tạo một `PartRequest` mới: `requestType: 'quotation'`, `quotationId`, `additionalCostId: null`, `fulfillmentMethod: 'pickup'`, `shippingFee: 0`. Tên/giá lấy từ snapshot khách duyệt; catalog được kiểm còn active khi cần cấp thêm. Không đổi giá theo catalog hiện hành, không tự xuất tồn kho.
- Dòng SKU lặp được gộp khi tính phần thiếu. Phần thiếu lớn được chia thành các dòng tối đa 100 theo giới hạn custody hiện có.
- GET danh sách/chi tiết yêu cầu kho trả thêm loại/link này; các route READY/QR/receive/usage/cancel giữ nguyên. QR và quyền chủ thể vẫn kiểm như trước; tracking-only enroll được QUOTATION và không bật finance P1.
- Chỉ UNDER_REPAIR + RECEIVED mới được USED/RETURNED. USED FixHome phải có nguồn duyệt tương ứng, tổng theo SKU không vượt số lượng đã duyệt; thêm tiền phải đi qua chi phí phát sinh riêng.
- Khi tạo hóa đơn mới, chỉ nguồn của kỹ thuật viên đang phụ trách được tính. PRE_REPAIR và QUOTATION đúng báo giá chung pool gốc; ADDITIONAL chỉ dùng pool của chính `additionalCostId`. Mỗi số lượng USED chỉ tiêu thụ một lần qua các dòng SKU lặp; RETURNED không tính tiền. Thiếu nguồn hàng hoặc over-usage chặn trước insert hóa đơn, kể cả khi còn tiền công dương.
- Hóa đơn đã tồn tại được trả nguyên snapshot, không tính lại. Dưới khóa order, cấm kỹ thuật viên/quản lý hủy QUOTATION liên kết với báo giá APPROVED và PRE_REPAIR chứa SKU FixHome mà báo giá đó đang tái dùng: `CONFLICT` 409, giữ trạng thái/QR. Hướng dẫn tiếp tục nhận hàng hoặc liên hệ quản lý để hủy đơn theo luồng riêng. PRE_REPAIR không liên quan, báo giá chưa duyệt và ADDITIONAL giữ luật hủy cũ. Không tự tạo lại yêu cầu đã hủy từ trước hoặc đổi snapshot khách đã duyệt.

## Migration và release

`1790000000044-QuotationPartRequests.ts` thêm enum `quotation`, cột/FK `quotation_id`, unique một yêu cầu mỗi báo giá và CHECK độc quyền nguồn; không backfill/update hóa đơn hay stock. Unique PRE_REPAIR và ADDITIONAL cũ giữ nguyên.

PostgreSQL 17 không cho dùng giá trị enum vừa ADD VALUE trước commit ([ALTER TYPE](https://www.postgresql.org/docs/17/sql-altertype.html)). Migration dùng so sánh `request_type::text` trong CHECK để không cast literal mới thành enum trong transaction. Đây là thiết kế đã review source, chưa phải bằng chứng rehearsal PG17. Rollback khóa bảng và từ chối khi còn bất kỳ yêu cầu QUOTATION nào; không xóa dữ liệu hoặc bỏ liên kết lịch sử, không cố xóa enum label.

Lead cần rehearsal upgrade/down/re-up trên PostgreSQL 17 cô lập, kiểm enum/CHECK/FK/unique/custody, rollback khi có dữ liệu, cạnh tranh APPROVE/USED/no-charge/payment và rollback khi audit lỗi trước release. Migration phải chạy qua quy trình release riêng trước restart backend mới. Không chạy Compose/start server trên shared-dev trong task này vì tác vụ nền có thể ghi DB.

## Phạm vi và review

- BA/PM: B01–B07; giữ phần Web của writer Web, không mở rộng mobile/admin/AI hoặc sửa dữ liệu demo.
- CTO/Tech Lead: giữ controller → service → TypeORM, state machine, lock order order → request/invoice; unique DB bảo vệ replay nguồn kho. Concurrency/transaction thực trên PostgreSQL: NOT VERIFIED.
- Senior Developer/Security: kiểm chủ thể JWT/RBAC/booking/assignment, QR, nguồn phê duyệt, snapshot tiền, idempotency và không tự tính lại hóa đơn cũ; không thêm dependency/env/config mới.
- Tester/QA/QC: test logic/service dùng database doubles và provider test config, không thay thế HTTP/JWT/PG/socket/browser thật. Independent review của Lead: NOT VERIFIED, cần trước release.
- DevOps: chưa migrate/deploy/restart, chưa thay flag P1 hoặc return tracking; không cần nâng dependency/image. Cần restart backend sau khi migration/release được duyệt.
- Web source đã đối chiếu API invoice/VNPay và fallback parts total tại worktree P013; không ghi repo Web. Workspace mobile hiện không có checkout để đối chiếu; Web/Mobile/browser/device parity: NOT VERIFIED. Consumer cần dùng một nguồn tổng theo giai đoạn, không fallback từ số tiền 0 đã chốt sang báo giá dương.

## File thay đổi

- `src/shared/enums/part-request-type.enum.ts`.
- `src/database/migrations/1790000000044-QuotationPartRequests.ts`.
- `src/modules/quotations/quotations.service.ts`, `quotation-parts.spec.ts`.
- `src/modules/part-requests/entities/part-request.entity.ts`, `part-request-lifecycle.ts`, `part-requests.service.ts`, `part-requests.service.spec.ts`.
- `src/modules/part-requests/part-custody.rules.ts`, `part-custody.types.ts`, `part-custody.service.ts`, `part-custody.service.spec.ts`.
- `src/modules/service-orders/service-orders.service.ts`, `parts-billing.spec.ts`.
- `src/modules/finance/finance.service.ts`, `customer-wallet.controller.ts`, `dto/finance.dto.ts`, `finance-contract.spec.ts`, `no-charge.spec.ts`.
- `docs/CONTEXT.md`, tài liệu này.

## Kết quả kiểm tra

Chạy trên Windows, Node `v24.15.0` (repo pin Node 20.19.5; chưa kiểm riêng trên bản pin). Cài dependency từ lockfile bằng `npm ci --ignore-scripts --no-audit --no-fund`: exit 0, 612 packages; không đổi dependency/lockfile.

| Gate | Kết quả | Bằng chứng |
| --- | --- | --- |
| Focused Vitest | PASS | 22 file, 219 test, exit 0; lệnh dưới đây |
| `npm run typecheck` | PASS | exit 0 |
| `npm run lint` | PASS | exit 0, 0 error; một warning có sẵn ở `1790000000022-ResetUnfundedTechnicianWallets.ts:40`, không sửa ngoài scope |
| `npm run build` | PASS | exit 0 |
| `git diff --check` | PASS | exit 0; Git chỉ cảnh báo chuyển LF/CRLF trên host |
| Full unit suite / E2E | NOT VERIFIED | Chủ task chỉ cho focused tests, không broad/full E2E |
| PostgreSQL 17 migration, multi-instance race/rollback | NOT VERIFIED | Không ghi DB trong task này; unit dùng doubles không chứng minh DB lock/constraint |
| Docker `/health`, HTTP/JWT/QR/socket/provider thật | NOT VERIFIED | Không khởi động backend nối shared DB hoặc gọi provider |
| Web/Mobile/browser/device runtime và Node bản pin | NOT VERIFIED | Chưa chạy; mobile không có checkout trong workspace |

Lệnh test thực thi (prefix shell qua `rtk proxy`):

```powershell
npx --no-install vitest run src/modules/quotations src/modules/part-requests src/modules/finance src/modules/service-orders/parts-billing.spec.ts src/modules/service-orders/order-steps.spec.ts src/modules/service-orders/service-order-state-machine.spec.ts src/modules/service-orders/order-completion-effects.spec.ts src/modules/service-orders/service-orders.controller.spec.ts src/modules/wallet/custody-settlement.spec.ts test/migrations/part-requests-and-lifecycle.migration.spec.ts test/context-doc.spec.ts
```

Vitest có warning cấu hình native-loader hiện có; không đổi config ngoài scope. Lỗi context ban đầu do thêm dòng thứ 41 trong nhật ký đã sửa theo mục 0 (giữ 40 dòng mới nhất), không nới test. Fixture invoice/custody cũ được bổ sung dữ liệu duyệt/nguồn hợp lệ cho gate mới; thiếu nguồn có test từ chối riêng.

| Kịch bản | Bằng chứng unit |
| --- | --- |
| B01 | APPROVE → một QUOTATION request phần thiếu → READY/QR nhận → USED → hóa đơn; SKU lặp không tính hai lần; phối hợp FIXHOME/TECHNICIAN/LABOR, 10% chỉ LABOR; số lượng lớn chia đúng giới hạn custody |
| B02 | Tái dùng PRE_REPAIR ở bốn trạng thái active; không đổi hàng cũ; loại người giữ cũ/cancelled/returned; thiếu hoặc đủ nguồn có kết quả riêng |
| B03 | ADDITIONAL giữ nguồn riêng, duyệt lại không cấp hai lần, không lấy QUOTATION để tính chi phí phát sinh |
| B04 | Reject/replay không tạo kho; APPROVED snapshot bất biến, không backfill quote lịch sử |
| B05 | REQUESTED/PENDING hoặc thiếu nguồn bị chặn trước insert; USED/RETURNED hợp lệ tạo hóa đơn; chặn USED chưa duyệt/vượt tổng theo nguồn |
| B06 | Free 0 xác nhận một lần; no-charge không provider/Payment/ví; giữ hold hoàn tất; chặn hóa đơn 0 sai/chi phí còn dương/ảnh thiếu/approval pending/khác chủ; cho RETURNED hợp lệ |
| B07 | VNPay chặn 0/1/4999/âm, nhận 5000; wallet/CASH nhận 1/4999; wallet retry không trừ lần hai; nạp ví chặn 9999, nhận 10000 |

Kết luận: source/backend và focused gates hoàn tất cho Lead review, chưa đủ bằng chứng phát hành. Việc còn lại nhỏ nhất là review độc lập và rehearsal PostgreSQL 17 cô lập trong phạm vi được phép ghi test DB, rồi release migration trước restart backend/QA. Không tự sửa đơn hoặc hóa đơn demo đang lỗi.

## Handoff sửa hai HIGH sau review (20/10/2026)

- Phạm vi: chỉ chặn sớm số lượng không biểu diễn được bằng nguyên dòng và hủy nguồn kho cần thiết sau duyệt. Không đổi settlement, commission, ví/payout, custody tracking-only, migration hoặc hóa đơn cũ; không commit/push/DB writes.
- File của lần sửa này: `src/modules/part-requests/part-requests.service.ts`, `src/modules/quotations/quotations.service.ts`, `src/modules/quotations/quotation-parts.spec.ts`, `src/modules/part-requests/part-return-workflow.spec.ts` (bổ sung dependency thật trong fixture), `docs/CONTEXT.md`, `docs/P013-QUOTE-BILLING.md`.
- RED: `npx --no-install vitest run src/modules/quotations/quotation-parts.spec.ts`: 10 failed / 20 passed trước production fix, lỗi do vẫn cho phép quote/cancel bị cấm. GREEN sau sửa: focused matrix cùng lệnh 22 file ở trên, kết quả cuối ghi bên dưới.
- BA/PM: khớp hai HIGH và đường thoát yêu cầu REQUESTED trước báo giá. CTO/Tech Lead/Senior Developer: dùng service hiện có, khóa order trước đọc lại allocation/approval; subset nguyên dòng không dùng một dòng hai lần. Security: giữ quyền/ownership, quyết định từ dữ liệu server. Tester/QA/QC: thêm kiểm 3/2 tại tạo và duyệt, 1/1 + SKU mới, SKU lặp, subset hợp lệ, cancel cả hai vai trò và REQUESTED/READY/DELIVERING, QR không đổi, nguồn không liên quan/ADDITIONAL không bị chặn. Đây là các góc nhìn tự review, không phải review độc lập mới.
- Đã đọc source Web P013 `TechnicianPartsSection.vue` và `user-facing-error.ts`: usage vẫn gửi nguyên dòng, giữ thông báo tiếng Việt từ server. Mobile checkout không có trong workspace; Web/Mobile/browser/HTTP/QR thực, PostgreSQL/concurrency và Docker `/health`: NOT VERIFIED. Không khởi động server hay chạy E2E vì task cấm DB writes. Full suite không chạy theo prompt.
- Lead đã báo rehearsal PG17 DEV `BEGIN DDL ROLLBACK` ở prompt; lần sửa này không tự kiểm lại, không coi đó là rehearsal cô lập/concurrency PASS. Cần restart backend sau migration/release được duyệt trước runtime QA.

| Gate lần sửa HIGH | Kết quả | Bằng chứng |
| --- | --- | --- |
| Focused Vitest (lệnh 22 file ở trên) | PASS | 241/241 test, 22/22 file, exit 0; thêm 22 test so với baseline 219 |
| `npm run typecheck` | PASS | exit 0 |
| `npm run lint` | PASS | exit 0, 0 error, chỉ còn warning cũ `queryRunner` tại migration #0022:40 |
| `npm run build` | PASS | exit 0 |
| `git diff --check` | PASS | exit 0 |
| Full suite / E2E / DB / browser-runtime | NOT VERIFIED | Không chạy theo phạm vi prompt và lệnh cấm DB writes |
