# Platform-first T3 — kiểm chứng trả linh kiện vật lý

Ngày: 29/10/2026 (UTC+7). Project: `fixhome-sep`, repo Backend.
Baseline: `6ed7f73ddba4a0279b919b4755a067e3c26e25e7` (T1).
Nhánh: `foxonworld/fixhome-platform-first-parts-t3-20261029`.

## Phạm vi và kết luận

**Hoàn thành audit và bổ sung test; chưa hoàn thành AT10 hoặc toàn bộ platform-first.**
Không tìm thấy lỗi cần sửa trong cơ chế trả vật lý của hàng đã enroll ở các ca dưới đây.
Giữ nguyên production code, API, cohort, payment/quote/commission, migrations và cờ runtime.
Test cô lập dùng `PART_RETURNS_TRACKING_ENABLED=true`, `P1_CUSTODY_ENABLED=false`;
không đọc/ghi `.env`, DB chung hoặc production. Không tích hợp WIP của T2.

Đã đọc kế hoạch owner duyệt, checkpoint `FIXHOME_PLATFORM_FIRST_IMPLEMENTATION_CHECKPOINT_20261029_1247.md`,
`PLATFORM-FIRST-T1-BACKEND-CONTRACT.md`, toàn bộ `CONTEXT.md`, technical guide và design system 1.1.0.
Skills thực sự đã đọc: `using-superpowers`, `systematic-debugging`,
`test-driven-development` cùng `writing-good-tests`, `verification-before-completion`.
Không tạo agent khác.

## Bằng chứng source và test

File mới: `src/modules/part-requests/platform-first-parts-audit.spec.ts`.
13 test chạy real services/rules/controller role metadata với storage double có rollback
và transaction tuần tự. Không mock kết quả `reportRepairFailed`, `byOrder`, `command`
hoặc `applyCustodyCommand`. Test guard không thay cho HTTP/JWT runtime.

| Yêu cầu | Kết quả thực tế |
| --- | --- |
| (a) Thợ gốc GET/declare sau CANCELLED, assignment inactive | PASS: gọi real `reportRepairFailed`, xác nhận assignment đã inactive; GET qua controller và declare vẫn được. Thợ thay thế đang active không được đọc/khai custody của thợ gốc. |
| (b) Chỉ SM nhận vật lý full/partial/discrepancy | PASS: cấp 3, khai 3, nhận 1 còn 2; discrepancy quan sát 1 không tự nhận thêm; nhận cuối 2 mới hết nghĩa vụ. Receipt lưu actor/role/timestamp. Admin/customer/technician bị từ chối ở service và `RolesGuard`. |
| (c) Không tự nhận khi failed/released | PASS: real failure và outgoing-release không ghi receipt hoặc tăng `managerAcceptedQty`. Chọn `returned` trong báo sửa không được không phải `declare_return`, càng không phải acceptance. |
| (d) Legacy không được coi là đã trả đủ | FAIL ở yêu cầu sản phẩm: test tái hiện hàng legacy đã nhận nhưng queue/by-order SM trả `[]`; đây là characterization của lỗi còn tồn tại, không phải test khẳng định legacy an toàn. Chi tiết blocker bên dưới. |
| (e) Replay/concurrency/quantity | PASS trong transaction double: hai request cùng key chỉ nhận một lần, replay trả response gốc kể cả sau receipt mới; đổi payload cùng key bị 409; hai SM dùng key khác cùng version chỉ một lệnh thành công, lệnh kia 409; vượt phần còn lại bị chặn. PostgreSQL race NOT VERIFIED. |

Suite hiện có đã kiểm thêm: cấp 3/dùng 1/khai trả 2; actual-use chỉ vào hóa đơn mới;
cohort/cutover và không backfill; usage/invoice freeze; số âm/0/vượt lượng khai;
notification recipient/replay/rollback; source/rule/DTO và payment completion độc lập custody.

## Lifecycle đã đối chiếu

- `part-returns.controller.ts`: JWT + role guards; declare chỉ TECHNICIAN;
  accept/discrepancy chỉ SERVICE_MANAGER. Không cấp quyền nhận cho Admin.
- `PartCustodyService.byOrder/command`: ownership gắn `technicianId` của custody và
  `originalCustodianTechnicianId` trong snapshot; không yêu cầu active assignment hoặc order chưa terminal.
  Usage khác return: `PartRequestsService.lockRequest/updateItemUsage` và custody rules
  vẫn chặn sửa usage sau terminal/invoice freeze. Không mở lại quyền chi tiết toàn đơn cho thợ cũ.
- `command/execute`: khóa order → technician → custody, kiểm version và fingerprint actor/payload;
  receipt/entry/state/notification cùng transaction. Chỉ `accept_return` tăng accepted quantity.
- `reportRepairFailed`: giữ mọi RECEIVED request và custody, chỉ hủy hàng chưa nhận;
  assignment inactive, service failure/source receipt vẫn độc lập nhận trả vật lý.
- `releaseOutgoingTechnicianPartRequests`: chỉ hủy REQUESTED/READY/DELIVERING.
  Generic `closeOrderPartRequests(cancelled=true)` có thể đổi RECEIVED thành CANCELLED;
  đây là trạng thái request, không phải chứng cứ đã nhận kho; không được suy ra accepted từ nó.
- `part-custody.policy.ts`: tracking và P1 finance riêng; không backfill cohort.
  Outstanding có thể hạn chế việc mới của thợ, không phải gate đặt lại của khách.
  Customer rebook mới của T2 chưa tích hợp trong HEAD này, không tuyên bố kiểm chứng nó.

## Blocker chính xác và việc tiếp theo

### AT10: legacy không có custody chưa có biểu diễn unknown an toàn

Repro tự động `AT10 GAP reproduction`: request có `receivedAt` trước cohort, FixHome quantity 3,
usage RETURNED, không có PartCustody. Sau real failure, request vẫn RECEIVED nhưng:
SM pending/byOrder trả `[]`; thợ gốc inactive GET bị 403, declare trả 404. Không có receipt.
Không thể coi usage RETURNED, order CANCELLED hoặc mảng rỗng là đã nhận vật lý.

Nguyên nhân: `pending` chỉ query PartCustody; `byOrder` chỉ map custody rồi kiểm active assignment
khi không có row. Legacy không được enroll là thiết kế cohort có chủ đích.
Không có ledger vật lý để suy ra số đã nhận hoặc outstanding chính xác cho các item này.

Blocker là schema response liên Backend/Web và consumer đang chỉ được READ ONLY:
`PartCustodyReturnRecord` yêu cầu các số nguyên cụ thể; `PartReturnsQueue.vue` chỉ render
`awaiting` hoặc `undeclared` theo số outstanding/declared, không có nhánh unknown.
Thêm row với số 0 sẽ giấu vấn đề; gán issued quantity làm outstanding sẽ bịa nghĩa vụ;
thêm null/discriminator một phía chưa làm queue hiện đúng. Không trả lỗi toàn queue để che
luôn các custody hợp lệ, không backfill/cấp receipt tổng hợp để lấp khoảng trống.

Bước nhỏ tiếp theo: BE/Web cùng chốt schema additive cho legacy manual-review với quantities
không xác định và không có action nhận tự động. Query ứng viên phải nối đúng
`PartRequestItem.id` không có PartCustody + bằng chứng handover (`receivedAt`/status);
không fuzzy-match tên/SKU/thợ, không suy ra physical receipt từ usage. Web cần một nhóm unknown
riêng kể cả khi awaiting=0, cùng test empty/error/cap 100. Đối soát lịch sử cần chứng cứ SM;
không thay đổi dữ liệu legacy trong task này. AT10 vẫn là release blocker.

### Giới hạn failure/stop cần T2 giữ rõ

Hai test mới chứng minh request cấp 3/dùng 1/còn trả 2 không thể đóng bằng contract objective
failure hiện tại: outcome `installed` yêu cầu toàn lượng USED; `returned` yêu cầu used=0.
Cả hai trả 422, giữ order/assignment/custody, không giả vờ đã kết thúc hay đã trả.
Không hạ usedQty về 0 để vượt guard. T2 phải xử lý disposition/stop contract riêng,
giữ partial usage đã ghi và không gọi cleanup/accept ngầm. Không sửa call path này ở T3.

### Liên kết và consumer

Đã đọc Web worktree T5 ở commit `b2c8ae36863383f0a796c373638175a74840a28b`:
`PartReturnsQueue.vue`, `TechnicianPartsSection.vue`, `TechnicianJobDetailPage.vue`,
`part-requests.api.ts`. Queue có link `orderId` → `/console/orders/:id`; không có UI
gọi discrepancy trong component đã đọc. Job đọc ledger từng child và tổng số từ `[]`
có thể thành zero; không chứng minh tất cả hàng legacy đã trả. Queue chỉ tối đa 100 row.
Link trực tiếp incident↔return chưa có; không chọn một SupportCase tùy ý làm nguồn authority.
Web writer cần nối navigation/context theo incident hợp lệ mà không coi case RESOLVED là receipt.
Mobile source không tìm thấy part-return integration trong `TechnicianOrderDetailScreen.tsx`;
không sửa Mobile. Rendered Web/Mobile, keyboard, responsive, JWT/runtime: NOT VERIFIED.

## Technical validation và review

Các lệnh được chạy trong worktree này, không phải số liệu kế thừa từ T1:

- `npm ci --no-audit --no-fund`: PASS. Lần focused đầu trước cài deps không khởi động
  vì thiếu `vitest/config`; cài đúng lockfile, không đổi dependency/lockfile.
- Baseline `npx vitest run src/modules/part-requests --maxWorkers=4`: PASS, 8 files / 120 tests
  (107 test cũ cộng 13 test audit mới). Không có test skipped/expected-fail trong file mới.
- `npm test` (full suite): PASS, 243 files passed / 3 skipped; 2468 tests passed / 21 skipped.
  Lần chạy đầu chỉ FAIL duy nhất `test/context-doc.spec.ts` vì WIP thêm dòng nhật ký thứ 41 vào
  `docs/CONTEXT.md`; đã bỏ dòng cũ nhất đúng quy tắc mục 0 rồi chạy lại toàn bộ, không sửa test
  và không đổi hành vi sản phẩm.
- `npm run lint`: PASS, 0 error; còn 2 warning có sẵn ở file ngoài phạm vi T3
  (`kyc-storage.service.spec.ts`, migration 0022), không thêm warning mới.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS, không có whitespace error.
- `git status`/`git diff` xác nhận chỉ có `docs/CONTEXT.md`, audit doc mới và spec mới;
  không sửa production code, API, migration, cohort hay cờ runtime.
- PostgreSQL/RLS/unique-index/lock race, `npm run test:e2e`, HTTP/JWT, Docker app `/health`,
  provider, authenticated DEV và browser: NOT VERIFIED. Không thay production/schema/runtime;
  không chạy full-app E2E có thể dùng cấu hình DB ngoài phạm vi. Docker daemon có phản hồi
  nhưng không tạo container hoặc chạy migration; không viện lý do Docker unavailable.
- Chỉ commit local sau khi các gate trên xanh. Không push, PR, merge, deploy hoặc ghi DB chung.

Review là tự review, không phải review độc lập: BA/PM giữ manual SM lock và AT10 chưa đạt;
CTO/Senior giữ Nest module, không tạo WMS/API mới; Security kiểm original ownership,
Admin deny và replay; Tester/QA phân biệt characterization lỗi với acceptance PASS;
DevOps không đổi image/dependencies/env/migration. Không ghi runtime artifacts để ép kết quả.

Không có production patch cần restart/hard-refresh từ T3. Khi tích hợp backend T2/T3 sau này,
restart backend rồi kiểm `/health` và authenticated flow; chỉ hard-refresh Web khi Web được cập nhật.
Không push, PR, merge hoặc deploy. Commit local chỉ sau các gate source/test đạt.
