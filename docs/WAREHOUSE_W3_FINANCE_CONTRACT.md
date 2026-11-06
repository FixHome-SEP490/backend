# W3 DELIVERY — hợp đồng tài chính và operational zero-fee slice (chưa release)

Ngày: 04/11/2026. Nguồn: official dev `ba703298`, owner order W3 04/11/2026.
Trạng thái hiện hành: **SOURCE ZERO-FEE OPERATIONS; KHÔNG PHẢI ACTIVATED DEV/FINANCE**.
Mục 1–16 là checkpoint scaffold trước đây; mục 17 mô tả capability mới và giới hạn hiện hành.
Team Finance phải review độc lập
trước release. Không apply migration, đổi ENV hay ghi shared DB trong task này.

## 1. Quyết định và ranh giới

Owner đã duyệt khách 70%, kỹ thuật viên 30% cho DELIVERY linh kiện FIXHOME mới.
Team Finance spec, seller-of-record, hóa đơn thuế, trách nhiệm courier, điều khoản
đồng thuận và cách xử lý khoản không thu được chưa được duyệt. Không tự quyết các mục đó.
PICKUP giữ phí 0 và W2 QR; PartRequest/invoice lịch sử giữ LEGACY 100/0.
Warranty và linh kiện TECHNICIAN lịch sử giữ nguyên. Không tự tạo nguồn linh kiện mới.

Không được dùng một ENV flag làm đủ thẩm quyền chuyển tiền sang W3. Trong bản scaffold,
không có API nào phát hành invoice 70/30 hay đặt courier; không có switch kích hoạt.
Snapshot W3 chưa được hỗ trợ xuyên suốt phải bị từ chối trước tác động tài chính.
Không đổi giới hạn IP của webhook provider đã ký.

## 2. Số nguyên VND và bất biến ledger

Các giá trị phải là số nguyên VND không âm, trong miền safe integer JavaScript;
mọi phép cộng/nhân dùng số nguyên kiểm tra tràn. Không dùng floating point tính tỷ lệ.
Với từng delivery: `S = courier actual approved`, `c = floor((7*S+5)/10)`
(round half up), `t = S-c`. Ví dụ S=1 → c=1,t=0; S=5 → c=4,t=1.
Không chia lại trên tổng nhóm: làm tròn từng snapshot rồi cộng, `c+t=S` luôn đúng.

Ký hiệu L=tiền công, C=commission đã snapshot, F=linh kiện FIXHOME,
T=linh kiện TECHNICIAN lịch sử, W=phí bảo hành ngoài tiền công,
D=các khấu trừ tiền công khác đã biết và được duyệt.

| Thành phần                  | LEGACY_100_0         | W3_70_30_V1          |
| --------------------------- | -------------------- | -------------------- |
| Courier payable             | S                    | S                    |
| Customer shipping           | S                    | c                    |
| Technician shipping         | 0                    | t                    |
| Customer gross / grandTotal | L+F+T+W+S            | L+F+T+W+c            |
| CASH PlatformDue            | C+F+S                | C+F+**FULL S**       |
| ONLINE payout trước D       | gross-C-F-**FULL S** | gross-C-F-**FULL S** |
| NET_LABOR sau D             | L-C-D                | L-C-t-D              |
| NONLABOR                    | T+W                  | T+W                  |
| Payout sau D                | NET_LABOR+NONLABOR   | NET_LABOR+NONLABOR   |

Phải `L-C-t-D >= 0`; không clamp, không đẩy t vào NONLABOR, không tạo nợ/âm ví.
D không được tự cộng vào PlatformDue hoặc trừ ví nếu chưa có ledger được Finance duyệt.
`knownLaborDeductions` trong pure helper chỉ mô hình hóa khả năng chi trả. Không có API
nhận D hoặc consumer payout áp dụng D trong bản này. D>0 cần ledger đích cho debit/funding
riêng được duyệt và đối soát, nếu không phải fail closed trước active payout 70/30.
CASH customer giao gross giảm cho kỹ thuật viên; platform vẫn thu full courier S.
Do đó `gross-PlatformDue-D = ONLINE payout sau D`.

Ví dụ L=100000,C=10000,F=T=W=D=0,S=20000:
legacy gross=120000, platformDue=30000, netLabor=90000;
W3 c=14000,t=6000,gross=114000,platformDue=30000,netLabor=84000.
Thêm F=50000,T=12000,W=3000,D=1000: gross W3=179000,
platformDue=80000, netLabor=83000, NONLABOR=15000,payout=98000.
L-C=5000,S=20000 phải từ chối. Không dùng voucher bù thiếu tiền công.

Voucher/credit dùng snapshot funding hiện có: gross không giảm; customer trả
net=gross-credit; platform cấp funding credit đúng một lần, cash offset/online funding
theo ledger F4. Ví dụ credit=10000 trên gross114000: khách trả104000,
payout vẫn84000; credit không phải commission discount, không tăng khả năng chịu t.
Cashback là khoản funding riêng, không được trừ NET_LABOR. Chưa có quyết định funding
mới thì không hỗ trợ W3 voucher/cashback live. Không tính lại tỷ lệ trên net sau voucher.

Nhóm child A S=1, child B S=1: tổng c=2,t=0 (không chia 70/30 tổng S=2).
Child A gross114000/netLabor84000; child B legacy gross120000/netLabor90000:
group gross234000,payout174000; refund child phải giữ policy và allocation của child.

## 3. Snapshot bất biến và migration

Invoice: `shippingPolicyVersion`, `customerShippingShare`, `technicianShippingShare`;
`shippingFee` vẫn là **full courier cost**, không đổi nghĩa thành 70%.
Legacy historical không backfill tiền/giá trị đã duyệt. Shares NULL chỉ hợp lệ khi
policy LEGACY; reader suy ra c=shippingFee,t=0. Snapshot mới ghi đủ ba trường.
W3 không được thiếu share, sai tổng, khác policy, mismatch nguồn chi phí đã duyệt.
Migration tiến `1793466000004-WarehouseDeliverySplit` sau W2, giữ historical default
LEGACY, CHECK và trigger chống sửa snapshot tiền. Không chạy migration trong task này.
`ck_invoice_shipping_cutover_closed` chỉ cho lưu LEGACY kể cả payload có đủ share W3.
Code guard cũng không có ENV/config override. Mở W3 cần forward migration + code review
riêng sau toàn bộ consumer và ledger được duyệt; schema preparation không phải activation.
Sau invoice W3 đầu tiên, disable chỉ dừng enrollment mới; không downgrade binary/schema
hay đổi policy của invoice cũ. Forward fix và compensating ledger có review.

## 4. Web API đề xuất — chưa có endpoint W3 hoạt động

Đây là hợp đồng để Web companion lập kế hoạch, **không phải API đã phát hành**.
Mọi command cần JWT+RBAC+ownership, UUID commandId, expectedVersion, khóa order rồi
request/allocation, fingerprint payload và receipt cùng transaction. Retry cùng command
và payload trả receipt cũ; khác payload trả 409. Client không được gửi verdict/paid/netLabor.

| Route dự kiến dưới `/api/v1/part-requests/:id/delivery` | Actor                                      | Dữ liệu                                                         |
| ------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| GET `/`                                                 | khách sở hữu, thợ active, SM kho được gán  | policy, quote version, S,c,t, trạng thái đồng thuận             |
| POST `/proposal`                                        | đúng SM active của kho                     | commandId, expectedVersion, courier quote/evidence reference, S |
| POST `/consent`                                         | đúng khách hoặc đúng thợ, tách hai receipt | commandId, expectedVersion, proposalId, explicit accepted=true  |
| POST `/actual`                                          | đúng SM kho                                | commandId, expectedVersion, actual S, evidence reference        |
| POST `/dispatch`                                        | đúng SM kho                                | commandId, expectedVersion, manual booking reference/evidence   |

Không có role mới, không gọi API courier, không bịa bảng giá/km/thời gian.
Enrollment chỉ cho DELIVERY mới gồm FIXHOME đã reserve đủ từ một kho và có approved
Quotation/AdditionalCost hiện có. Proposal chỉ là đề xuất, không phải consent.
Customer approve cost phải bind proposal/version/S/c; technician riêng phải bind
proposal/version/S/t và server kiểm tổng t mọi delivery trên order <= net labor sau D.
Không dùng consent prose, flag client hoặc approve quote cũ làm consent 70/30.

State đề xuất: PROPOSED → AWAITING_DUAL_CONSENT → CONSENTED → ACTUAL_VERIFIED
→ DISPATCHED → RECEIVED; CANCELLED chỉ trước dispatch. Mỗi lần actual thay đổi tạo
version mới. Actual tăng quá approved total: AWAITING_DUAL_CONSENT, vô hiệu cả hai
consent cũ, không booking trước khi approved cost + cả hai consent khớp version mới.
Actual giảm cũng cần snapshot cuối rõ ràng; không tự sửa hóa đơn đã phát hành.
Dispatch kiểm lại role/SM assignment, order chưa terminal, approved cost, dual consent,
actual evidence, net labor và không có invoice/payment/cancel race trong cùng transaction.
Physical ISSUE/receive phải nối W2 stock/custody bằng chứng, không giả tech nhận là SM giao.

**Blocker đã xác minh ở official W2:** `WarehouseFulfillmentService.enroll()` và `reserve()`
chỉ nhận `FulfillmentMethod.PICKUP`; create DELIVERY không enroll allocation.
Vì vậy W3 DELIVERY hiện **không có one-warehouse reservation hoặc dispatch stock proof**.
Không đổi PICKUP sang DELIVERY, không sửa điều kiện W2, không tuyên bố đã nối courier.
Phải review riêng allocation DELIVERY, reserve toàn SKU, physical ISSUE và custody admission
trước thực hiện các API dự kiến ở trên. Bản scaffold không sửa PartRequests/W2/Warranty.

## 5. Hủy, hoàn tiền và idempotency

Trước dispatch: nhả reserve đúng một lần, không debit courier giả. Sau dispatch:
không đảo tồn vật lý hoặc tự hoàn full S; cần bằng chứng courier và Finance policy.
Refund phải theo invoice/child policy và payment allocation bất biến, tối đa số tiền
đã thu/funded chưa hoàn, idempotency theo provider + refund command. Không tính lại
70/30 từ số refund; không tự thu lại thợ/âm ví. Uncollectible chỉ ghi case bằng chứng
và chờ khoản FixHome chịu theo quyết định Finance, không tự chuyển nợ khách/thợ.
Signed IPN duplicate giữ receipt/payment/funding duy nhất, không phát payout/refund lần hai.

## 6. Gate bàn giao và kích hoạt

Trước live: team Finance ký ledger CASH/WALLET/VNPAY/CUSTODY/VOUCHER/CREDIT/CASHBACK,
seller-of-record/tax/consent được duyệt; reviewer tài chính độc lập; PG CI migration,
immutability/RBAC/race/replay/refund/cancel/group child tests; Web consent runtime;
deployment compatibility/activation và vận hành manual courier được Lead duyệt.
Không áp schema shared DEV hoặc đổi custody flags theo bản scaffold.

Consumer wiring và kết quả test thực tế được ghi trong handover cuối task; test pure
không chứng minh provider/PG/Web runtime. Mọi đường chưa nối đầy đủ là release blocker.

## 7. Phạm vi source scaffold bàn giao

| Consumer | Source đã nối | W3 live |
| --- | --- | --- |
| Invoice generation | Pure helper, ghi rõ LEGACY + shares 100/0 cho invoice mới; trả nguyên invoice đã có | Chặn |
| Finance payment/VNPay URL/wallet, paid-online, confirmed-cash, dues, no-charge | Guard snapshot/cutover trước financial mutation chính; công thức legacy giữ full S | Chặn |
| SettlementService / custody | Guard trước wallet; payout và hold/release legacy giữ nguyên | Chặn; NET_LABOR trừ t mới ở pure model |
| VisitGroup checkout | Guard từng invoice trước tạo allocation | Chặn |
| Voucher frozen facts | Guard ngay đầu, trước suy ra funding | Chặn |
| Funded support refund | Guard invoice reference trước đọc funding/reversal | Chặn |
| Quotation / AdditionalCost approval | Không đổi nguồn duyệt và giá legacy | Chưa nối snapshot/dual consent W3 |
| DELIVERY reserve / actual courier / dispatch / receive | Không sửa W2 PICKUP hoặc PartRequests | Chưa triển khai |
| Warranty / ordinary refund / cancellation | Không đổi hành vi; không có invoice W3 hợp lệ để dùng | Chưa chứng minh ledger W3 |

BA/PM: scope giữ bốn role, courier thủ công và chưa phát hành API mới. Tech Lead/Senior:
không thêm dependency/module, chỉ helper thuần, snapshot additive và guard vào consumer
hiện có. Security: không ENV override, không cho snapshot lạ thành LEGACY, không sửa receipt,
payment idempotency hoặc signed provider throttling. QA: RED→GREEN cho arithmetic/snapshot/
cutover, kiểm regression toàn suite; PostgreSQL thật chỉ có harness CI được soạn.
Đây là tự review theo vai trò; **independent Finance review chưa thực hiện**.

Migration phải được Lead duyệt và rehearsal trước khi chạy binary có ba cột Invoice mới.
Không deploy binary này lên schema cũ. Không chạy Docker/health trong task scaffold vì có thể
kết nối shared DB. Sau release được phép, restart Backend trước runtime QA.

## 8. Kết quả kiểm chứng scaffold — 04/11/2026

Node `20.19.5`; không đổi dependency, cấu hình runtime hoặc flags.

| Lệnh / gate | Kết quả thực chạy |
| --- | --- |
| Focused Vitest: `w3-cutover`, `voucher-frozen-invoice`, `voucher-refund-commit`, `shipping-finance.policy`, `invoice-shipping-snapshot`, `context-doc` với `--maxWorkers=4` | PASS — 6 spec, 54 test |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors, 4 warnings có sẵn ngoài phạm vi |
| `npm run build` | PASS |
| `npm test -- --maxWorkers=4` — lần cuối sau sửa voucher/refund guards | PASS — 289 files passed, 5 skipped; 3358 tests passed, 58 skipped; 0 failed |
| `git diff --check` | PASS |
| PostgreSQL migration/trigger/rollback, authenticated/provider/Web runtime, independent Finance review | NOT VERIFIED |

Các vòng RED đã thấy lỗi thiếu arithmetic/snapshot/cutover; full suite trước bản sửa hai
voucher/refund guards có 2 failed, đã sửa consumer thật và giữ nguyên assertions.
Full suite cuối PASS không thay bằng chứng PostgreSQL hoặc payout W3 live.
`test/warehouse-w3-finance.e2e-spec.ts` đã soạn cho PostgreSQL ephemeral CI hiện có;
không chạy DB tại máy writer. Không gọi courier hoặc chạy thử hành động DELIVERY.

**READY_FOR_LEAD_REVIEW — source scaffold, NOT DEPLOYABLE / NOT ACTIVATED W3.**
Lead giữ quyền commit/push/PR/migration/release; Finance/pháp lý, DELIVERY stock coupling,
dual consent và toàn bộ payment/refund ledger vẫn là gate bắt buộc.

## 9. Phase A — versioned dual-consent domain (source only)

Checkpoint 04/11/2026, tiếp nối scaffold trên cùng nhánh. Chỉ thêm
`src/modules/part-requests/delivery-consent.policy.ts` và spec tương ứng; không có
consumer live, API, module registration, migration, ENV hoặc kích hoạt W3 mới.
Các kết quả full suite ở mục 8 thuộc scaffold trước Phase A, không phải lần chạy lại
cho phase này. W2 PICKUP, DELIVERY lịch sử, LEGACY 100/0 và finance guards giữ nguyên.

### Giá trị, version và chuyển trạng thái

- Hai hàm thuần: `createDeliveryProposal(scope, command, actor)` và
  `applyDeliveryCommand(state, command, actor)`. Không dùng clock, random, I/O hay DB.
  Output sao chép đầu vào cần thiết và đóng băng đệ quy; không mutate/freeze object của caller.
- Scope cố định gồm `partRequestId`, `serviceOrderId`, `customerId`, `technicianId`,
  `responsibleServiceManagerId`; ba actor ID phải khác nhau. Đây là dữ kiện phải được
  server đọc/xác minh ở Phase B, không phải quyền từ payload client.
- `version` là revision CAS, bắt đầu 1 và tăng sau mỗi command được chấp nhận.
  `quoteVersion` chỉ tăng khi `REVISE`, kể cả cùng S nhưng sửa evidence, approved cost,
  budget hoặc chủ động mở version mới. Initial `PROPOSE` đòi `expectedVersion=0`.
- Command hợp lệ: `PROPOSE`, `REVISE`, `CONSENT`, `RECORD_ACTUAL`. Đúng SM đã bind mới
  propose/revise/record actual. Đúng khách/thợ đã bind mới consent cho phần của mình.
  Không có Admin override, role mới, lệnh dispatch, receive, payment hoặc terminal.
- State chỉ có `AWAITING_DUAL_CONSENT` → `CONSENTED` → `ACTUAL_RECORDED`.
  `REVISE` quay về awaiting, xóa cả hai consent và actual hiện hành nhưng giữ receipt cũ.
  **ACTUAL_RECORDED không có nghĩa courier đã được xác minh ngoài đời, đã booking,
  warehouse đã reserve/ISSUE, READY_FOR_DISPATCH hoặc được phép thanh toán.**

### Ràng buộc consent và actual

Quote/actual đều gọi `calculateShippingShares(S, 'W3_70_30_V1')` hiện có, không sao chép
công thức ratio. Quote fingerprint SHA-256 bind scope, quoteVersion, S/c/t, budget,
evidence và approved-cost reference. Consent cần `accepted=true`, đúng quote fingerprint,
quoteVersion/S và đúng c hoặc t; receipt giữ actor/role, UUID v4 command ID, evidence ref
và content fingerprint. Không auto-consent kể cả S=0; không dùng approval cũ thay consent.
Các ID/evidence reference là opaque ASCII reference tối đa 256 ký tự; command ID là
UUID v4 lowercase. Chỉ kiểm cú pháp reference, không chứng minh tồn tại hoặc nội dung.

Actual chỉ được ghi sau cả hai consent cùng quote. Nếu actual > approved S,
`RENEWED_DUAL_CONSENT_REQUIRED`: không thay state; phải `REVISE` quote mới với approved-cost
và evidence mới được server xác minh, xin lại CẢ HAI consent rồi ghi actual. Exact replay
consent v1 sau REVISE chỉ trả state mới, không phục hồi consent v1.

Actual <= approved ceiling được đóng băng riêng cùng `approvedCeilingTotal`, quoteVersion,
actual S/c/t, evidence và actor SM; giữ nguyên quote/consent và không sửa Invoice.
Đây là quy tắc cụ thể của Phase A theo owner order mới nhất, bổ sung ngoại lệ actual dưới
trần cho đề xuất sơ bộ ở mục 4. Không được ghi đè actual đã lưu: sửa actual/evidence cần
REVISE và renewed dual consent, hoặc replay chính xác command đã ghi.

Budget chỉ nhận L/C/D số nguyên không âm, kiểm bằng BigInt `L-C-D-t >= 0`; không clamp.
`D>0` vẫn có thể biểu diễn khả năng chi trả trong mô hình nhưng luôn trả
`payoutBlockReason=KNOWN_DEDUCTIONS_LEDGER_REQUIRED`; D=0 vẫn là
`FINANCIAL_CUTOVER_CLOSED`. Không tạo debit, payout hoặc ledger đích cho D.

### Replay, tính toàn vẹn và giới hạn

Fingerprint command bind scope + actor/role + toàn bộ command canonical, gồm
`expectedVersion`. Cùng key/payload đã commit replay trước CAS, không thêm receipt/version
và không rewind state mới. Cùng key khác payload/actor hoặc đổi expectedVersion sau commit
trả `COMMAND_CONFLICT`. Command mới phải đúng revision hiện tại; duplicate consent bằng
key khác bị từ chối. Command lỗi không tạo receipt. Payload thừa/thiếu cũng bị từ chối.

State được kiểm lại bằng replay lịch sử receipt đầy đủ và đối chiếu snapshot dẫn xuất;
không tin một cờ CONSENTED hoặc các consent ghép từ hai nhánh race độc lập. Hash là
content identity, **không phải chữ ký hay bằng chứng persisted**. Caller không được gửi
state/receipt/evidence verdict làm thẩm quyền. Không prune lịch sử receipt của domain này.
Replay có chi phí theo lịch sử; đây chưa phải thiết kế storage hiệu năng cho production.

Pure functions không khóa DB, không chống được hai writer cùng đọc version cũ và cùng
tạo nhánh revision mới. Unit test race chỉ chứng minh quy tắc CAS/replay trên giá trị;
không chứng minh transaction, concurrency nhiều process, JWT/RBAC/IDOR hoặc courier thật.

### Phase B bắt buộc trước integration

Storage/version/receipt append-only, unique `(partRequestId, commandId)` và CAS/transaction
cùng audit; xác thực JWT + quyền hiện tại/ownership/assignment/SM kho trước cả replay;
resolve approved-cost và evidence thật, khóa order để kiểm tổng t của mọi delivery không
vượt net labor còn lại sau commission/các deduction được duyệt. Không dùng lại cùng một
budget cho nhiều request như thể mỗi request có toàn bộ tiền công riêng.

Phải thiết kế và review warehouse DELIVERY reservation đủ SKU ở đúng một kho, physical
ISSUE/courier dispatch proof/custody admission và vòng đời hủy; W2 hiện chỉ nhận PICKUP.
Không gọi hàm mới từ luồng live trước phase riêng được duyệt. Finance/team/pháp lý vẫn
phải duyệt ledger D, invoice actual-vs-ceiling, seller-of-record/tax/consent và tất cả
payment/refund/payout consumers. Phase A không mở bất kỳ gate phát hành nào.

### Kiểm chứng Phase A — Node 20.19.5

- RED ban đầu: 50 failed/10 passed do domain chưa được triển khai; sửa fixture undefined
  để thực sự gửi undefined thay vì default test helper. Regression mutable serialized replay
  cũng đã được kiểm RED trước khi khôi phục immutable output.
- Focused Vitest PASS: 5 spec, 108 test, 0 failed/0 skipped; gồm 62 test domain mới,
  `shipping-finance.policy`, `invoice-shipping-snapshot`, `w3-cutover` và `context-doc`.
- `npm run typecheck`: PASS sau sửa type narrowing, không dùng cast để bỏ qua lỗi đó.
- `npm run lint`: PASS, 0 errors/4 warnings có sẵn ngoài allowlist.
- Full suite/build, PostgreSQL, auth/API/concurrency/runtime và independent Finance review:
  NOT VERIFIED trong Phase A; không chạy lại full suite hoặc tạo artifact runtime.
- Review source theo scope: chỉ hai file domain/spec mới và hai tài liệu allowlist;
  không live consumer, financial activation, DB/ENV write, commit/push/PR update/deploy.

**READY_FOR_LEAD_REVIEW — Phase A source only; Phase B cần storage + transactional auth +
warehouse DELIVERY integration và Finance/team approval.**

## 10. Phase B1 — inert consent persistence, SOURCE ONLY (04/11/2026)

B1 bổ sung migration tiến `1793466000005-DeliveryConsentState`, ba entity và
`DeliveryConsentStoreService` nội bộ. Không đăng ký provider/module/controller/route;
không gọi từ PartRequestsService, W2 hay bất kỳ consumer tiền nào. Entity/migration có thể
được glob TypeORM phát hiện khi build, nhưng không chạy migration hoặc synchronize trong
phase này. B1 không tạo API, consent đăng nhập, dispatch, stock/custody movement, Invoice,
ledger, notification hoặc cờ mở cutover. CHECK W3 của migration 0004 giữ nguyên.

### Storage và scope integrity

- `delivery_consent_sessions`: một root/PartRequest, revision CAS và quoteVersion tách biệt,
  projection Phase A không chứa receipt; identity bất biến gồm order/customer/technician,
  assignment ID, SM đề xuất, source quotation hoặc AdditionalCost; warehouse bắt buộc NULL.
- `delivery_consent_commands`: append-only command UUID theo request, unique
  `(part_request_id,command_id)` và `(part_request_id,result_version)`; immutable command
  body/fingerprint, actor/role, source snapshot/digest/version, projection và proposal receipt
  liên kết cùng request. Mỗi quote chỉ một proposal, một consent mỗi vai trò và một actual.
- `delivery_evidence_records`: append-only metadata riêng tư trước khi session tồn tại;
  FK scope request/order/uploader, purpose/quoteVersion, digest/MIME/size, retention nullable.
  `cloudinary://evidence/fixhome/evidence/<order>/<uploader>/<UUID>` là định dạng reference
  của scaffold B1, **chưa có resolver/upload adapter được triển khai**. Không nhận URL public.
  NULL retention không cho phép tự xóa file. Metadata không chứng minh bytes/object tồn tại,
  quyền truy cập provider hay tính xác thực hóa đơn/quote courier.

FK đơn lẻ không đủ: INSERT/UPDATE trigger kiểm PartRequest thực sự thuộc đúng order và
technician, Booking của order có đúng customer, assignment ID đúng order/technician và đang
active, các actor còn active/đúng role; source trực tiếp approved đúng order/technician và
AdditionalCost do đúng customer duyệt. **B1 luôn giữ warehouse NULL**, có CHECK
`ck_delivery_b1_no_warehouse` và scope guard; store không đọc/copy allocation hoặc warehouse
W2 ở bất kỳ status nào, kể cả `released` còn giữ warehouse/SM ID. W2 PICKUP đã issued/released
không chứng minh W3 DELIVERY reservation hoặc authority. Sự tồn tại hay thay đổi allocation W2
không khiến B1 session bị từ chối hoặc được gán kho. SM chỉ là người đề xuất đã được trusted
adapter cung cấp, **không phải bằng chứng được phân công kho**. Khi có authoritative allocation
riêng cho DELIVERY, cần forward migration/gate được review riêng; B1 không tự tạo/chuyển allocation.

Không thêm trigger vào bảng W2/assignment đang chạy: reassignment hợp lệ vẫn được phép.
Scope cũ khiến command mới và replay bị chặn. Maintenance nội bộ
`invalidateIfScopeChanged` ghi một lần `SCOPE_CHANGED` khi identity/assignment không còn
khớp; giữ nguyên revision/projection/journal, audit actor NULL để không giả mạo hành động SM.
Không thể reset/uninvalidate root hoặc sửa identity để tái sử dụng consent cũ. Historical read
vẫn có thể rebuild; B2 phải tự kiểm quyền đọc hiện tại trước khi gọi store.

Các số tiền dùng bigint SQL trong miền JS safe integer; CHECK dùng numeric cho phép nhân
và trừ trung gian, `c=floor((7*S+5)/10)`, `t=S-c`, `netLabor=L-C-D-t>=0`.
Actual thấp hơn trần lưu S/c/t riêng, không sửa quote hay Invoice. D>0 chỉ lưu blocker
`KNOWN_DEDUCTIONS_LEDGER_REQUIRED`; D=0 luôn `FINANCIAL_CUTOVER_CLOSED`.
UPDATE/DELETE commands/evidence và TRUNCATE ba bảng bị chặn. Deferred constraint đòi
journal liên tục/đủ root revision và head snapshot khớp, không commit root thiếu receipt.
Down chỉ cho schema rỗng; có bất kỳ history/evidence nào phải từ chối, không tự xóa dữ liệu.
RLS bật không có policy; REVOKE tables/functions khỏi PUBLIC và các API roles hiện hữu,
không tự GRANT. Table owner/superuser vẫn có quyền theo PostgreSQL; B2 cần review role/grants.

### Caller transaction, replay và giới hạn authority

Store yêu cầu EntityManager có transaction đang active; không mở/commit transaction riêng.
Lấy lock Order → Technician → PartRequest → Session, derive scope từ DB, recheck active
actor/source, replay journal bằng domain Phase A và so từng projection/fingerprint.
Command mới phải đúng expectedVersion; root CAS + immutable receipt + AuditLog cùng manager.
Lỗi SQL, audit hoặc deferred constraint phải làm caller rollback toàn bộ; caller không được
nuốt lỗi rồi commit. Exact replay trả state hiện tại và receipt gốc, không tăng revision hay
phục hồi consent cũ; cùng key khác body/actor xung đột. Replay sau Invoice vẫn có thể đọc
receipt hợp lệ, không tạo command mới; scope/actor/source bị thu hồi thì từ chối.

Source FK/reference chỉ chứng minh source parts/labor approved có thật. Quotation không có
shipping approval, AdditionalCost đã approved không được sửa ngầm. B1 không chứng nhận
nguồn đó đã có chấp thuận phí 70/30, không lấy laborDelta làm net labor toàn order. Budget
vẫn là input **chỉ từ trusted server adapter tương lai**; B1 không có JWT/session và không
thể phân biệt actor struct thật/giả từ client. Không được expose store làm API trực tiếp.
SHA-256 là content identity, không phải chữ ký/HMAC hay chống DB owner cố ý sửa schema.

Global lock matrix chưa được chứng minh với cancellation/group/quotation (có luồng Booking
hoặc VisitGroup trước Order); B2 phải review trước mounting. Aggregate ngân sách của nhiều
delivery cùng order/technician hoặc nhiều child, per-delivery rounding so với invoice aggregate
CHECK (hai S=1 cho c=2 nhưng round tổng S=2 cho c=1), group cap5, repeat order, seller-of-record,
tax, consent wording, D ledger, source shipping approval, evidence retention/provider và DELIVERY
reservation/ISSUE/courier/custody vẫn là release blockers. Không claim physical DELIVERY ready.

### Kiểm chứng và bước tiếp

- Genuine RED store: 22 failed/1 passed; regression metadata thừa `createdAt` cũng RED
  (1 failed/28 passed) trước khi thêm exact key validation. GREEN trước review-fix: store 29/29,
  Phase A 62/62 và context 2/2, **93 passed/0 failed** trong 3 spec, Node 20.19.5.
- Unit persistence double chứng minh replay/CAS/scope checks của service; không chứng minh
  rollback/row locking/RLS hoặc SQL trigger trên PostgreSQL.
- `test/delivery-consent-storage.e2e-spec.ts` dùng **chỉ** PostgreSQL CI ephemeral hiện có,
  schema UUID riêng, không đọc dotenv/DATABASE_*; yêu cầu CI + GitHub Actions. Bao phủ
  migration, scope sai, bigint/micro-VND, append-only, deferred completeness, replay/races,
  rollback, reassignment/invalidation và down guard. Local collection: **22 skipped**;
  actual PostgreSQL execution: **NOT_RUN**; không suy ra SQL syntax/constraint PASS từ build.
- `npm run typecheck`, `npm run build`, `npm run lint`: PASS; lint 0 errors/4 warnings có sẵn.
  Allowlist đúng 9 file, `git diff --check` PASS; Phase A/finance/W2/module/config không sửa.
  Full suite không chạy theo scope. SQL runtime/migration rehearsal, HTTP/JWT/provider,
  warehouse DELIVERY authority, Web/Mobile và Finance/legal: **NOT VERIFIED**.

Review-fix-01 (source only): regression 6 status W2 + static migration contract đã RED
7 failed/29 passed, GREEN store **36 passed/0 failed** sau khi bỏ toàn bộ dependency đọc/lock W2,
buộc warehouse NULL. Static assertion chỉ kiểm SQL được emit, không chứng minh PostgreSQL
thực thi CHECK/trigger. PG spec giữ 22 case, kiểm tên/định nghĩa CHECK và direct INSERT
warehouse khác NULL bị chặn; runtime DB vẫn **NOT_RUN**, local collection **22 skipped** vì
harness chỉ chạy khi cả CI và GitHub Actions. Các cross-identity check không giảm.
Focused cuối Node 20.19.5: **100 passed/0 failed** (store 36, Phase A 62, context 2);
typecheck/build/lint PASS, lint 0 errors/4 warnings cũ. Không chạy full suite, DB hoặc HTTP.
Entry T8 2026-10-29 16:02 được khôi phục nguyên văn từ HEAD 79f5078; checkpoint B1 gộp vào
Phase A gần nhất theo Lead, giữ đủ nội dung và tối đa 40 entry, không xóa event lịch sử khác.

**B1 SOURCE ONLY — chờ independent schema/security review. SAFE_TO_APPLY_DB=NO;
SAFE_TO_ACTIVATE_FINANCE=NO.** B2 tiếp theo cần trusted facts + transactional JWT/RBAC/IDOR,
approved shipping source, evidence resolver và lock matrix review; B3 warehouse DELIVERY cần
phase riêng được duyệt. Không apply shared DEV, commit/push/PR update/merge/deploy trong B1.

## 11. Phase B2a — trusted facts preview, SOURCE ONLY (05/11/2026)

`DeliveryConsentFactsService` là plain internal class không đăng ký provider, module hoặc
route. `preview(manager, requestId, principal)` chỉ đọc; không gọi B1 store/domain command,
không mở transaction/lock, không ghi DB/audit/notification, không gọi provider hoặc API.
Không đọc bảng B1 chưa apply migration 0005, evidence, W2 allocation/warehouse, payment hay
wallet. W2 PICKUP và historical DELIVERY không được đổi policy hoặc nâng thành W3 authority.

`delivery-consent-access.policy.ts` chỉ parse cấu trúc principal và so scope do server đọc,
**không xác thực JWT**. Future trusted guard phải cấp cả actor ID và role, không lấy từ body.
User được reload với ID/role/isActive/status; phải còn active và khớp principal. SM/Admin bị
`NOT_FOUND_OR_DENIED` trước khi đọc PartRequest; không có SM wide-read, consent hoặc proposal
permission. B1 warehouse luôn NULL nên B2a không thể chứng minh assigned SM authority.

Owner preview chỉ cho đúng Booking customer hoặc technician của chính PartRequest có active
assignment trên cùng Order, với technician User còn active/đúng role. So lại quan hệ
PartRequest → Order → Booking và assignment(order,technician), không ghép facts khác đơn.
Đây là gate bảo thủ cho preview W3: thiếu/revoke assignment cũng từ chối customer preview;
không thay quyền đọc lịch sử đang có của API khác. Missing resource, sai owner/role/status
user hoặc scope thiếu/khác đều có một error `NOT_FOUND_OR_DENIED`, không kèm ID, state hoặc
lý do riêng tư. Lỗi infrastructure được propagate, không giả thành verdict quyền; wrapper
HTTP tương lai phải dùng cơ chế redaction/error handling hiện có.

Sau ownership check mới đọc source và kiểm **invoice existence only** bằng `existsBy`.
Mọi query dùng select tối thiểu; không đọc/return shippingFee, labor, commission, invoice detail,
QR, private object/evidence ref, source note hoặc profile người khác. Output chỉ có actor hiện
tại, own request/order ID, enum trạng thái quan sát, trạng thái parts/labor source và blockers.
Source Quotation approved/version/decidedAt đúng order/technician, hoặc AdditionalCost approved
do đúng Booking customer quyết định, chỉ mang nhãn `VERIFIED_APPROVED` cho **parts/labor**.
Source chưa duyệt hoặc binding thiếu/sai không được coi là verified. Không coi Quotation có
shipping approval; approved AdditionalCost một mình cũng chưa chứng minh W3 split approval.

Output luôn `mode=NON_EXECUTABLE_PREVIEW`, `consistency=NON_ATOMIC`, bốn action newConsent,
proposal, dispatch và payout luôn `BLOCKED`; luôn có cả năm blocker:

- `SHIPPING_APPROVAL_SOURCE_UNVERIFIED`
- `WAREHOUSE_DELIVERY_ALLOCATION_MISSING`
- `COURIER_PROOF_UNVERIFIED`
- `FINANCE_CUTOVER_CLOSED`
- `TOTAL_ORDER_LABOR_BUDGET_UNVERIFIED`

Các blocker này biểu diễn authority chưa chứng minh, không claim đã kiểm file/courier hoặc
đã query allocation và thấy rỗng. Owner có thể xem blocker cụ thể cho order đóng/completion
intent/invoiced, request đã delivering/received/closed, Warranty/PRE_REPAIR/PICKUP, source
chưa approved hoặc binding sai; đây không phải permission tạo consent. Không tính S/c/t/net
labor, không suy budget từ source hoặc input khách. Multi-delivery/child budget, D ledger,
rounding, seller-of-record/tax và consent wording vẫn cần Finance/team/legal.

Preview có thể stale/race giữa các read, không giữ snapshot/lock và không chứng minh toàn
bộ global lock order. Không dùng output hoặc cache preview để authorize mutation, ký consent,
dispatch, payout hoặc activation. B2b còn cần JWT/RBAC/IDOR wrapper, authority SM/approved
shipping source/evidence, re-read scope trong transaction đã review cùng replay/CAS và
negative/race tests. B2a không tạo DTO/controller/module hoặc ENV/grant/override để mở gate.

Kiểm chứng B2a: genuine RED 60 failed khi chưa triển khai; regression malformed ownership
facts RED 1 failed/66 passed trước khi chuẩn hóa denial. Focused GREEN **174 passed/0 failed**
(67 B2a, 62 Phase A, 36 B1, 7 cutover, 2 context), Node 20.19.5. Test dùng mocked EntityManager;
không chứng minh JWT/HTTP hoặc PostgreSQL. PG 22 case cũ vẫn **NOT_VERIFIED**, không chạy DB
hoặc full suite. Typecheck/lint/build/diff và preservation check ghi theo thực chạy ở handover.
Gate local cuối: typecheck/build/lint PASS (0 errors/4 warning cũ), diff/allowlist PASS đúng
6 file; context vẫn 40 entry và giữ toàn bộ event trước. Không sửa B1/Phase A/Finance/W2/auth/module.

**B2a INERT — READY_FOR_LEAD_REVIEW, chờ independent review. SAFE_TO_APPLY_DB=NO;
SAFE_TO_ACTIVATE_FINANCE=NO.** Không commit/push/PR update/merge/deploy/migration/shared DB.

## 12. Admin delivery operating policy — INERT foundation (05/11/2026)

`system-config/w3-delivery-policy.ts` và `w3-delivery-policy-preview.ts` là domain thuần,
không provider/controller/route/entity hoặc migration. Không ghi `system_configs`, thêm
config key/cache/service song song, đăng ký vào AppModule hoặc sửa AdminConfig hiện tại.
Không có live activation adapter. Không tác động finance, W2 PICKUP, Warranty, historical
DELIVERY, B1 consent store, ví, payment, invoice hoặc proposal/consent hiện có.

### Snapshot và lifecycle mô phỏng

- Policy snapshot `W3_DELIVERY_OPERATING_POLICY_V1` có identity, content `version`, toàn bộ
  parameters và SHA-256 fingerprint canonical. Fingerprint chỉ nhận diện nội dung, không
  phải chữ ký, chứng nhận pháp lý, approval hoặc bằng chứng đã lưu DB.
- State có lifecycle `revision` riêng để kiểm expected revision. Tạo ban đầu là DRAFT;
  mỗi revise tạo snapshot version mới và DRAFT mới, kể cả parameters không đổi. Có thể
  đề xuất revision từ ACTIVE mô phỏng; bản ACTIVE cũ và các preview cũ không bị sửa.
- `simulateW3DeliveryPolicyTransition` chỉ mô phỏng DRAFT → ACTIVE/RETIRED hoặc ACTIVE →
  RETIRED. Không quay lại DRAFT, không same-state hoặc phục hồi RETIRED. ACTIVE **chỉ là
  trạng thái giả định**, không effective policy, không enrollment hay permission runtime.
- Mọi state/assessment/preview luôn `mode=NON_EXECUTABLE_PREVIEW` và
  `financialExecution=BLOCKED`, kể cả caller gửi đủ bốn gate VERIFIED. Không có export
  activation live, ENV override, thời điểm cutover, ledger hoặc quyền Admin mới.
- Output được copy và freeze toàn bộ phần lồng nhau; không freeze/mutate input của caller.
  Expected revision và version có kiểm safe integer/overflow. Đây là quy tắc trên giá trị,
  không phải CAS/unique version/audit giữa nhiều writer; persistence tương lai phải thiết
  kế transaction, append-only audit và kiểm quyền Admin hiện tại trước cả replay.

### Parameters đề xuất, không có giá trị mặc định

| Parameter | Kiểu/ý nghĩa trong preview |
| --- | --- |
| `feeCeilingVnd` | Số nguyên VND không âm, không vượt JS safe integer; trần review đề xuất, không phải bảng giá hoặc courier quote |
| `proposalReviewAfterMinutes` | Số phút nguyên không âm; tuổi proposal >= ngưỡng thì đánh dấu cần review |
| `courierEvidenceReviewAfterMinutes` | Số phút nguyên không âm; tuổi evidence >= ngưỡng thì đánh dấu cần review |

Mọi parameter bắt buộc khai rõ; không fallback thành 0, không parse string/fraction/NaN/
Infinity hoặc nhận field thừa. Giá trị 0 là input chủ động, không auto-consent hoặc miễn
gate. Các ngưỡng chỉ phục vụ what-if review, không tự expire consent, hủy, dispatch, thu
phí, chạy job hoặc xác lập SLA/pháp lý. Tên/ngữ nghĩa ngưỡng là schema đề xuất cho phase
inert này; giá trị vận hành và phạm vi dùng thật cần review riêng trước integration.

### Gate và impact preview

Assessment giữ riêng `LEGAL_UNVERIFIED`, `ACCOUNTING_UNVERIFIED`, `WAREHOUSE_UNVERIFIED`,
`COURIER_UNVERIFIED`. Chỉ evidence cấu trúc chính xác, status VERIFIED và reference hợp lệ,
bind cùng policy ID/version/fingerprint mới bỏ blocker tương ứng trong mô hình. Thiếu,
UNKNOWN, STALE, REJECTED, sai kiểu, sai binding hoặc shape đều fail closed. Revise đổi
fingerprint/version nên gate evidence cũ không dùng lại. Evidence ở đây là **input giả
định**, không resolver hay approval thực tế; không được nhận từ client làm authority.
Thiếu bất kỳ gate nào thì mô phỏng chuyển ACTIVE cũng bị chặn.

`FINANCIAL_CUTOVER_CLOSED` luôn còn kể cả bốn gate giả định đều VERIFIED. Shipping approval,
dual consent, shared order labor budget, aggregate rounding, D ledger, tax/seller-of-record,
signed provider/refund/funding/custody và release review vẫn chưa được giải quyết bởi policy.
Admin không thể dùng policy, gate report hoặc preview này để mở tài chính.

Impact preview nhận các sample giả định với `proposalId`, `proposalVersion` riêng và phí
courier do caller khai rõ. Mỗi proposal preview giữ **full immutable policy snapshot**,
content version/fingerprint và số tiền/shares; không dùng policy version thay proposal
version. Không tạo hoặc sửa proposal thật, không tạo consent và không tự chuyển những
consent cũ sang snapshot mới. Revised policy chỉ thay kết quả lần preview mới; không viết
lại order/invoice/proposal lịch sử. Duplicate proposal ID trong một batch bị từ chối để
không cộng lặp hai revision. Việc bind/revise proposal thật vẫn cần phase adapter riêng.

Tái dùng `calculateShippingShares` hiện có cho từng sample. Tổng S/c/t cộng bằng BigInt,
chỉ trả number sau kiểm safe integer; không round lại tổng. Hai sample S=1 cho tổng c=2,
t=0; không dùng kết quả này để vượt Invoice CHECK hiện đang giữ cutover đóng. Phí vượt
trần chỉ có `aboveFeeCeiling=true`, không clamp hoặc bịa giá thay thế. Evidence age NULL
giữ review-due NULL, không coi như tuổi 0 hoặc evidence verified. Preview không tính payout,
không phân bổ shared labor hoặc dùng phí/trần để suy ra khả năng thanh toán.

### Giới hạn và bàn giao

Chỉ code/spec mới trong allowlist và tài liệu này được sửa. `docs/CONTEXT.md` không thuộc
allowlist task; Lead cần cập nhật mục 3/8/9 theo section 0 trong đợt tích hợp được phép,
trước PR/release. Không sửa test context để bỏ gate. Web/Mobile/AI không được sửa hoặc
tuyên bố đồng bộ; PostgreSQL/HTTP/JWT/provider/browser/runtime và Finance/legal signoff
**NOT VERIFIED**. Không chạy migration, server hoặc shared DEV. Không commit/push/PR/
merge/deploy. Sau integration/release được duyệt, restart Backend trước runtime QA.

### Kiểm chứng thực chạy của phase này

- RED lifecycle: **93 failed/18 passed** với các hàm chưa triển khai; RED preview:
  **62 failed/0 passed**. GREEN mới: **173 passed/0 failed** trong hai spec.
- Node **20.19.5** theo `.nvmrc`. Focused regression với `system-config`,
  `part-requests/delivery-consent`, `shipping-finance.policy`, `invoice-shipping-snapshot`,
  `w3-cutover`, `context-doc` và `--maxWorkers=4`: **13 files, 423 passed, 0 failed**.
- Full `npm test -- --maxWorkers=4`, TZ UTC trong process test: **295 files passed,
  5 files skipped; 3748 tests passed, 58 skipped, 0 failed**.
- `npm run typecheck`, `npm run build`: **PASS**. `npm run lint`: **PASS**, 0 errors,
  4 warning có sẵn ngoài allowlist. Prettier check cho bốn file mới: **PASS**.
- Review độc lập chỉ đọc: không có finding cần chặn trong scope inert; reviewer chạy lại
  hai spec trên Node 20.19.5, **173 passed/0 failed**, diff check PASS. Đây là code/security
  review, không phải Finance/legal signoff. Malformed state/accessor/symbol và content
  version MAX có thể bổ sung coverage; chưa có lỗi thực tế được chứng minh ở các nhánh đó.
- Kiểm source caller: chỉ helper preview và specs import domain mới, không live consumer.
  Không stage/commit/push hoặc sửa ba local commit trước. Không migration mới hoặc DB run.
  PostgreSQL/HTTP/JWT/provider/Web/Mobile/runtime: **NOT VERIFIED**; các số PASS phía trên
  không thay bằng chứng integration, concurrency hoặc thẩm quyền activation.

**INERT FOUNDATION — READY_FOR_LEAD_REVIEW. SAFE_TO_APPLY_DB=NO;
SAFE_TO_ACTIVATE_FINANCE=NO.** Cần Lead cập nhật context ngoài allowlist trước tích hợp.

## 13. Phase B2b — JWT owner preview endpoint, SOURCE ONLY (05/11/2026)

Source đăng ký `DeliveryConsentPreviewController` và `DeliveryConsentPreviewService` trong
`PartRequestsModule`. GET `/api/v1/part-requests/:id/delivery-consent/preview` dùng
`ParseUUIDPipe`, `JwtAuthGuard`, `RolesGuard`, chỉ CUSTOMER/TECHNICIAN; response
`Cache-Control: no-store`. Không nhận DTO/query/body actor, approved source, fee hoặc verdict.
Controller chỉ chuyển `{id, role}` từ `req.user`; JWT strategy hiện có đọc role/status/isActive
thật từ User thay vì tin role trong payload JWT. Không đổi guard/auth hoặc cấu hình.

Adapter dùng nguyên `DeliveryConsentFactsService.preview` B2a với DataSource.manager hiện có;
đọc lại active DB actor và scope/owner/assignment như mục 11. Trả `{data: preview}` qua global
envelope hiện có. UUID sai trả 400, JWT lỗi theo guard hiện có trả 401, SM/Admin bị RolesGuard
chặn 403 trước đọc resource. Missing/foreign/revoked scope hoặc actor không còn đúng role
trong facts check cùng trả `NotFoundException` 404 với câu “Không tìm thấy yêu cầu.”, không lộ
request có tồn tại hay lý do riêng. Lỗi infrastructure propagate; adapter đánh dấu lỗi read
riêng để ngay cả lỗi DB mang message `NOT_FOUND_OR_DENIED` cũng không bị đổi thành 404.

Facts service vẫn plain internal class, adapter tự khởi tạo không I/O; không đăng ký B1 store,
entity hoặc migration mới. Chỉ cấp `findOne` và `existsBy` cho facts, không cấp write/transaction/
lock API; không đọc bảng consent B1 chưa apply, không gọi courier, audit hoặc notification.
Entity glob và startup custody assertion hiện có không đổi. Source mounting này không thêm
startup query B1; production bootstrap/schema compatibility thực tế vẫn **NOT VERIFIED**.
Không dùng API này authorize bất kỳ command nào. Output giữ `NON_EXECUTABLE_PREVIEW`,
`NON_ATOMIC`, năm blocker và bốn action BLOCKED của B2a, bao gồm `FINANCE_CUTOVER_CLOSED`.
Parts/labor source approved không phải shipping approval; không nhận source approval từ client.

Phạm vi mới: controller/service và hai focused spec, module wiring, context và mục 13 này.
Giữ nguyên 103 dòng mục 12 cùng bốn file Admin policy pre-dirty; không stage hoặc sửa chúng.
Source B2b không thay API cũ, W2 PICKUP, Warranty, tiền, migration, dependency hoặc ENV.
Web/Mobile consumer adoption/runtime **NOT VERIFIED**, không sửa repo khác. Mục 4/9/10/11
giữ lịch sử và đề xuất mutation; riêng JWT preview wrapper đã được thêm ở source trong mục này.

Kiểm chứng: RED với implementation stub **20 failed/3 passed**, sau implementation **28 passed**
trong hai spec (thêm DI và JWT validate units). Unit dùng mocked read dependencies, không giả
backend/database hoặc tuyên bố HTTP integration PASS. Bao phủ owner customer/technician,
IDOR, inactive/stale role, assignment revoked, missing request, SM/Admin, actor thừa authority,
UUID/role route metadata và propagate DB error cả sentinel trùng. Nest DI unit resolve
controller/service mà không có B1 provider; JWT validation unit dùng role DB, từ chối account
missing/disabled. Không chứng minh chữ ký/expiry JWT qua HTTP hoặc truy vấn PostgreSQL thật.

Node **20.19.5**: focused **425 passed/0 failed** (12 spec preview/access/facts/storage/domain,
Admin policy, shipping/snapshot/cutover và context); `typecheck`, `lint`, `build` PASS,
lint 0 errors/4 warning cũ. Full `npm test -- --maxWorkers=4`, TZ UTC trong process test:
**297 files passed/5 skipped; 3776 tests passed/58 skipped/0 failed**.
Review độc lập chỉ đọc không phát hiện lỗi chặn; reviewer chạy 4 spec **108 passed/0 failed**
trên Node 24.15.0. Không phải Finance/legal signoff. SHA-256 prefix toàn bộ contract trước
task và bốn file policy khớp baseline; `git diff --check` PASS, không có file staged.
HTTP/JWT signature/expiry, PostgreSQL/race/production
startup, Docker/health, Web/Mobile/provider và Finance/legal: **NOT VERIFIED**.

**SOURCE ONLY — READY_FOR_LEAD_REVIEW, NOT DEPLOYABLE. SAFE_TO_APPLY_DB=NO;
SAFE_TO_ACTIVATE_FINANCE=NO.** Không commit/push/PR/merge/deploy/migrate/seed hoặc shared DB.
Lead giữ final diff/review/release; sau integration được duyệt phải restart Backend trước QA.

**B2b follow-up 05/11/2026 (CI-only extension):** Lead thêm bốn nhóm E2E vào
`test/app.e2e-spec.ts`, chạy trên **PostgreSQL 16 của GitHub Actions trong schema ngẫu nhiên**
và qua HTTP Nest/JWT thật: CUSTOMER chủ đơn, TECHNICIAN đang active, outsider/SM/Admin,
malformed UUID, đồng nhất denial 404, stale assignment/DB locked account và xác nhận
GET không tạo consent command/evidence/invoice; POST consent vẫn không tồn tại.
Local `typecheck`/`lint`/`build` và 30 focused unit PASS, `git diff --check` PASS.
**Các E2E vừa thêm chưa có kết quả CI tại lúc viết; không coi là HTTP/JWT/PG PASS**
cho đến khi GitHub Actions chạy xong. Các kết quả CI trước đó chỉ chứng minh migration
0004/0005/0006, B1/B3a harness trên database cô lập; không chứng minh shared DEV.
Không sửa binary B2b, không thêm command/mutation, không mở finance hoặc dùng source
parts/labor approval như shipping approval.

## 14. Phase B3a — Admin DRAFT persistence, SOURCE ONLY (05/11/2026)

Mục 12 là checkpoint foundation lịch sử; B3a bổ sung persistence/API trong module
`system-config` hiện có và Database/DataSource hiện có. Không backend/database riêng,
không ghi key vào `system_configs`, không thêm consumer vào finance, PartRequests hoặc W2.
Generic AdminConfig không có đường đọc/kích hoạt bảng này. **Không effective policy**;
chỉ lưu DRAFT, không API activate/retire/delete, thời điểm hiệu lực hoặc ENV override.
Ba local commit và chín file code pre-dirty được giữ nguyên byte/hash; hai tài liệu chỉ
cập nhật/append. Mục 12–13 và toàn bộ prefix contract trước B3a giữ nguyên.

### Hợp đồng Admin (dưới `/api/v1/admin/w3-delivery-policy`)

| Method/path | Permission | Input và kết quả |
| --- | --- | --- |
| GET `/current` | `config:read` | `data.draft=null` khi chưa có draft; còn lại `{id,state,createdAt}` của revision cao nhất |
| GET `/history` | `config:read` | Query `beforeRevision?`, `limit?` (1–100, mặc định 20); `data.drafts` giảm dần theo revision |
| POST `/drafts` | `config:update` | `{expectedRevision:0,parameters}`; tạo initial DRAFT một lần, HTTP 201 |
| PATCH `/drafts/:id` | `config:update` | `{expectedRevision,parameters}` thay toàn bộ parameters; id UUIDv4 phải là head hiện tại; trả snapshot UUID mới, HTTP 200 |
| POST `/preview` | `config:read` | `{draftId,expectedRevision,samples}`; HTTP 200, hypothetical-only với snapshot chính xác kể cả revision lịch sử |

Mọi route cần JWT → RolesGuard (ADMIN) → PermissionGuard → raw-input guard, no-store,
envelope chuẩn. Trong transaction đọc lại User active/role và permission DB không qua cache,
khóa SHARE để không dùng quyền đã revoke giữa kiểm tra và ghi. Đây là global Admin policy,
không mở quyền cho SM/customer/technician hoặc nhận actor từ body/query.
Raw-input guard từ chối `__proto__`/`constructor` trước global ValidationPipe loại chúng;
DTO/service từ chối field thừa, gate VERIFIED giả, inherited/accessor/symbol input và số sai.

Parameters giữ đúng ba field mục 12, không mặc định phí; số nguyên không âm <= JS safe integer,
không ép string/fraction/null thành tiền. `expectedRevision` là integer 0 chỉ cho create,
1–2147483647 cho revise/preview; không tăng vượt giới hạn SQL integer.
Samples tối đa 100, mỗi item giữ đúng năm field của pure impact preview ở mục 12.
Tuổi courier evidence phải khai rõ integer hoặc NULL; không default thành đã xác minh.
Không đọc invoice/order/proposal thật, không sinh consent, dispatch, phí hoặc payout.

Mọi response có `mode=NON_EXECUTABLE_PREVIEW`, `financialExecution=BLOCKED`,
`effectivePolicy=null` và typed blockers luôn đầy đủ:
`LEGAL_UNVERIFIED`, `ACCOUNTING_UNVERIFIED`, `WAREHOUSE_UNVERIFIED`, `COURIER_UNVERIFIED`,
`SHIPPING_APPROVAL_SOURCE_UNVERIFIED`, `FINANCE_CUTOVER_CLOSED`.
Tên FINANCE ở API B3a không sửa enum FINANCIAL của pure foundation lịch sử.

### Transaction và schema chưa áp dụng

Migration tiến `1793466000006-W3DeliveryOperatingPolicy` thêm duy nhất bảng
`w3_delivery_policy_versions`, không backfill hoặc sửa bảng/hóa đơn/proposal cũ.
Một chain policy server-defined; content version và lifecycle revision là hai cột riêng,
cùng tăng trong B3a vì chỉ hỗ trợ revise DRAFT. Unique theo policy/revision và
policy/contentVersion; trạng thái chỉ DRAFT. Snapshot/fingerprint đầy đủ bất biến.
Head là revision cao nhất, không phụ thuộc clock/cache/TTL hoặc mutable active pointer.

READ COMMITTED + advisory transaction lock cố định serialize create/revise giữa instance;
sau lock đọc head và kiểm UUID+CAS. PATCH mới thêm row và strict `logWithManagerStrict`
before/after cùng EntityManager. Lỗi audit/SQL/deferred constraint rollback toàn transaction.
Create trùng hoặc retry/stale PATCH trả 409, không tự rebase/ghi lần hai; client đọc lại
current/history khi response chưa rõ. Không tuyên bố receipt replay idempotent thành công.

DB INSERT guard kiểm actor Admin/permission, revision liên tục, safe integer, exact snapshot
và canonical SHA-256 (content identity, không chữ ký). Deferred trigger đòi exact audit
actor/resource/before/after; UPDATE/DELETE/TRUNCATE history bị chặn. Giờ ghi do DB đặt và
không quyết định thứ tự. RLS không policy; REVOKE PUBLIC/API roles, không tự GRANT Backend.
DB owner vẫn có quyền PostgreSQL; Lead phải kiểm role/grants thật trước release.
Missing schema, snapshot hỏng hoặc audit/DB lỗi trả 503, không fallback config/default/PASS.
Down chỉ cho bảng rỗng, từ chối xóa lịch sử. **Migration chưa chạy, kể cả local.**

### Kiểm chứng và handoff

- RED mới: 35 service + 15 controller failed khi implementation còn stub; GREEN 50.
  Review raw-key regression RED 2 rồi GREEN; hiện hai spec **53 PASS** trên Node 20.19.5,
  gồm real guard/ValidationPipe và Nest DI units. Independent read-only reviewer chạy lại
  **53 PASS**, finding raw-key đã sửa. Review không phải Finance/legal signoff.
- Transaction double chỉ serialize khi production phát advisory lock; kiểm CAS concurrent,
  strict audit insert lỗi bằng AuditLogService thật và snapshot immutability. Không thay bằng
  chứng PostgreSQL multi-instance/rollback/RLS hoặc JWT/HTTP thật.
- `w3-delivery-policy-store.e2e-spec.ts`: **18 skipped**, actual PostgreSQL **NOT_RUN**.
  Chỉ dùng ephemeral CI hiện có + schema UUID; không dotenv/DATABASE_* hoặc shared DB.
  Có create/PATCH race, append-only, invalid snapshot/hash/money, audit rollback, down guard,
  RLS/PUBLIC ACL; nhánh API-role grants chỉ kiểm khi role tồn tại, vắng role vẫn NOT VERIFIED.
- Typecheck/build ban đầu **FAIL** do TS4053 ở hai B2b preview controller/service: `SourceFacts` chưa export, không phải lỗi B3a. Lead sau khi B3a hoàn thành đã export interface này (thay đổi type-only, không đổi runtime), và chạy lại `npm run typecheck` **PASS**, `npm run build` **PASS** cùng 136 targeted tests **PASS**. Không hạ compiler gate.
- Focused cuối: **16 files, 487 PASS** (system-config, delivery-consent, shipping snapshot,
  cutover, context); full `npm test -- --maxWorkers=4` với TZ UTC: **299 files passed/5 skipped,
  3829 tests passed/58 skipped/0 failed**. `npm run lint`: **PASS**, 0 errors/4 warning cũ.
  Context 2 test và Prettier file mới PASS; diff/preservation/allowlist PASS, staged NONE.
  Chín file code pre-dirty giữ SHA-256 gốc, contract giữ toàn bộ byte prefix; tất cả event
  context cũ giữ nguyên văn (gộp hai checkpoint cuối một dòng để giữ tối đa 40 entry).
  HTTP/PG/Docker/health/Web/Mobile/provider và Finance/legal **NOT VERIFIED**.

File B3a: `w3-delivery-policy-admin.controller.ts`, `.controller.spec.ts`, `.dto.ts`,
`.service.ts`, `.service.spec.ts`, `w3-delivery-policy-store.service.ts`, `.e2e-spec.ts`
trong `src/modules/system-config`; entity `entities/w3-delivery-policy-version.entity.ts`;
migration `1793466000006-W3DeliveryOperatingPolicy.ts`; wiring `system-config.module.ts`;
hai tài liệu CONTEXT và contract này. Tổng 12 file của B3a, không mở rộng allowlist.

**B3a SOURCE ONLY — NOT_DEPLOYABLE. SAFE_TO_APPLY_DB=NO; SAFE_TO_ACTIVATE_FINANCE=NO.**
Build/typecheck đã được Lead sửa và xác nhận PASS bằng type-only export. Vẫn phải kiểm CI PostgreSQL/schema/security và phối hợp Web trước release; không dùng B3a làm shipping approval hoặc financial activation.
Không stage/commit/push/PR/merge/deploy/migrate/seed/shared DB. Sau integration/schema/release
được duyệt phải restart Backend trước runtime QA.

## 15. B3a Admin JWT/HTTP/PostgreSQL verification extension (05/11/2026)

Trong schema cô lập hiện hữu của GitHub Actions, `test/app.e2e-spec.ts` bổ sung
7 test HTTP thật qua Nest, JwtStrategy, RolesGuard, PermissionGuard, ValidationPipe,
PostgreSQL và AuditLogService strict. Phạm vi: JWT thiếu 401, Customer/Technician 403,
JWT role giả không được nâng quyền, Admin bị khóa 401, current/history chỉ Draft và
không có effective policy, create đúng một DRAFT kèm audit trong transaction, dữ
liệu nguy hiểm `__proto__` và các tham số sai trả 400, conflict/expectedRevision 409,
hai PATCH cùng CAS chỉ một thành công, history bất biến, impact preview của phiên
bản cũ chỉ là hypothetical không phát sinh tiền, thu hồi `config:update` chặn mutation
dù RBAC guard có cache. Không mở activate/retire hoặc fee approval.

Chỉ dùng PostgreSQL CI hiện có trong schema ngẫu nhiên, không dùng shared DEV.
Local `typecheck`/`lint`/`build`/`git diff --check` PASS. GitHub CI
`42060181287` trên commit `44a6a76` hoàn thành **SUCCESS**: 3836 unit
PASS/58 skipped, 198 PostgreSQL integration PASS/39 skipped, trong đó
`test/app.e2e-spec.ts` 128 PASS (7 Admin HTTP mới); lint, typecheck,
security và build đều PASS. CI trước `42058256895` FAIL do hai lỗi test
fixture: TypeORM DELETE RETURNING trả `[rows, affected]`; legacy replay
cố rollback W3 append-only history sau khi Admin test đã ghi Draft. Đã sửa
đọc đúng tuple và chạy suite Admin **sau** legacy migration replay, tái tạo
RBAC/actor JWT chỉ trong CI schema. Không xóa Draft hay nới immutability.
Kết quả CI **không** chứng minh Supabase shared DEV, legal signoff, kho,
courier hoặc W3 settlement; giữ mọi financial/physical execution gate đóng.

## 16. Physical DELIVERY technical slice — CLOSED (06/11/2026)

Đây là implementation kỹ thuật trong Backend hiện có, **không phải W3 physical đã
hoạt động**. Không ghi shared DEV, không seed kho, không gọi courier, không sửa W2
PICKUP/QR, Mobile, AI hoặc financial consumers. CHECK invoice 0004 giữ nguyên.
Không suy ra shipping approval từ parts/labor approval, Admin DRAFT hoặc B1 status.

### Phần đã có code

- `warehouse-delivery.policy.ts`: canonical cộng SKU trùng, chọn đúng một kho đủ
  toàn quantity hoặc trả INELIGIBLE/PENDING_ASSISTANCE, không chia/giữ một phần.
  Legacy/not-delivery/frozen/unapproved/third-party/malformed items bị loại; thiếu
  shipping approval/dual consent giữ pending, không trả warehouse/quantities đã giữ.
- State domain: RESERVED → ISSUED_TO_COURIER → DISPATCH_RECORDED →
  TECHNICIAN_RECEIVED. ISSUE_TO_COURIER, COURIER_DISPATCH, TECHNICIAN_RECEIPT cần
  metadata riêng từng bước: courierReference, opaque evidenceRef, SHA-256 contentDigest.
  Reference phải khớp xuyên chain, không dùng lại evidenceRef; không auto-evidence.
  Chỉ nhãn RECORDED_NOT_EXTERNALLY_VERIFIED, không phải upload/external verification,
  actual approved courier cost hay đã thanh toán. RELEASE chỉ trước ISSUE.
- `WarehouseDeliveryStore` internal, không đăng ký Nest: caller phải xác thực actor và
  giữ transaction/rollback. `enrollNew` chỉ nhận requested DELIVERY quotation/additional
  trong chính transaction INSERT request; DB kiểm xmin + server creation time, không
  client flag/cutoff timestamp. API legacy hiện có không gọi enrollment, không backfill.
  `execute(RESERVE)` hiện chỉ ghi blocked assessment, không stock. Recheck DB role/active
  assignment, source order/tech/customer approval, exact canonical source SKU/quantity;
  deficit/legacy source không đủ binding vẫn unverified. Không nhận approval từ payload.
- Receipt append-only bind request/actor/role/commandId UUIDv4/kind/expectedVersion bằng
  fingerprint. Same command/payload trả ORIGINAL snapshot, payload khác trả conflict;
  lệnh mới cần CAS head. Khóa Order → Technician → Request → Cohort, receipt unique theo
  request/command và request/resultVersion. Lỗi phải rollback toàn transaction caller.
  Đây là journal/receipt của command, không ghi tiền hoặc audit log có raw metadata.
- `WarehouseDeliveryStock` dormant: chỉ tiêu thụ persisted event dưới DB gate; khóa
  Order → Technician → Request → Cohort → Warehouse/SM → stock SKU tăng dần; kiểm
  canonical quantity/state chain và attributable reservation của chính request.
  Khóa/kiểm đủ mọi SKU trước UPDATE đầu tiên, cập nhật stock + movement cùng manager;
  ISSUE trừ onHand và reserved, RELEASE chỉ reserved. Replay yêu cầu đủ journal SKU.
  Không expose method HTTP, không có caller production, không tạo PartCustody/QR/Invoice.

### API có thể gọi an toàn

`GET /api/v1/part-requests/:id/delivery-physical/preview` dùng JWT/RolesGuard,
chỉ CUSTOMER sở hữu hoặc TECHNICIAN đang active. Param DTO kiểm UUID; actor chỉ từ
req.user. Tái dùng B2b owner/source facts trước và sau đọc projection; denial giữ 404,
SM/Admin vẫn 403. Không thêm quyền broad SM khi chưa có warehouse binding.

Envelope `{data: ...}` và no-store. Output luôn NON_EXECUTABLE_PREVIEW/NON_ATOMIC;
eligibility INELIGIBLE hoặc PENDING_ASSISTANCE, historical lastAssessment riêng;
physicalExecution/financialExecution và mọi action BLOCKED. Không trả private metadata,
warehouse ID/stock quantity, S/c/t hoặc payer. actualCourierCost=null,
courierPayment=NOT_RECORDED; không dùng null như 0. Không đọc B1 tables.
Thiếu schema/physical read lỗi trả 503. GET không enroll/lock/ghi DB.

**Không có POST/PATCH reserve, issue, dispatch hoặc ACK.** Internal physical commands
khác RESERVE ném PHYSICAL_ACTIVATION_CLOSED trước persistence. RESERVE không có
nguồn shipping approval/dual consent nên chỉ lưu pending/ineligible, không giữ tồn.

### Migration và activation

`1793466000007-WarehouseDeliveryPhysical`: bốn bảng additive gate/cohort/event/movement;
không seed cohort/stock. Gate singleton có CHECK NOT enabled; history chống
UPDATE/DELETE/TRUNCATE, RLS không policy và REVOKE PUBLIC/API roles. Event trigger chỉ
admit blocked RESERVE snapshot không warehouse/quantity/courier evidence; movement
INSERT bị chặn. Guard request đã enroll ngăn legacy QR/status giả physical handoff,
giữ cancellation trước issue; request ngoài cohort tiếp tục legacy. Down từ chối nếu có
cohort/history. Migration CHƯA APPLY, không tự GRANT runtime role.

Chỉ đổi boolean gate không kích hoạt được. Muốn mở cần forward migration + code review
cho shipping approval source, authenticated dual consent + aggregate labor, new intake,
persistent physical command admission/actor SM binding/receipt, custody và lifecycle
release/cancellation/assignment race, private evidence existence/retention và Web runtime.
Domain states và dormant stock processor **không phải bằng chứng chain đã persist ngoài đời**.
Finance/legal/seller/tax/payee/refund/D ledger, courier actual và invoice70/30 còn CLOSED.
Không thể tuyên bố physical vertical slice đầy đủ hoặc sẵn sàng self-UAT DELIVERY trên DEV.

### Kiểm chứng và review

RED đã quan sát cho domain, store và preview khi chưa có implementation; GREEN mới
42 tests ở bốn spec. Reviewer độc lập chỉ đọc đã phát hiện source/eligibility/reservation
proof cần siết; writer sửa và giữ negative tests, reviewer chạy checkpoint 38/38 PASS.
Review cuối đã đọc migration/harness/HTTP extension và source/doc, không còn finding
chặn trong CLOSED scope; chạy độc lập 42 W3 + 2 context tests PASS. Không phải Finance
signoff. BA/PM giữ giới hạn khi thiếu approval; architecture review giữ Nest module và
không provider/caller stock mới; Security giữ owner denial/code+DB gates; QA phân biệt
domain/dormant unit với PostgreSQL và physical runtime. Không đổi dependency/ENV/Docker.

Kiểm chứng writer trên Node **24.15.0** (Node 20.19.5 theo `.nvmrc` chưa chạy tại lượt này):

| Gate | Kết quả |
| --- | --- |
| `npx vitest run warehouse-delivery test/context-doc.spec.ts` | PASS — 5 files, 44 tests |
| `npm test -- --maxWorkers=4`, TZ UTC | PASS — 303 files; 3871 tests passed, 58 skipped, 0 failed |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors, 4 warning có sẵn |
| `npm run build` | PASS |
| PG harness mới qua config E2E | 16 skipped, PostgreSQL NOT VERIFIED |
| HTTP/JWT thật, full `npm run test:e2e`, Docker/health, shared DEV/Web/Mobile | NOT VERIFIED |

`test/app.e2e-spec.ts` thêm một bundled HTTP/JWT/PG case cho owner/role/UUID/denial,
mọi mutation route 404 và GET không tạo cohort/event. Legacy replay cập nhật exact
protected migrations 0007→0006→0005 để down các EMPTY schemas trước TRUNCATE fixture;
không tắt trigger hoặc xóa lịch sử đã enroll. Case HTTP và replay mới chưa thực chạy CI.
Đây là source-only handoff, chưa thể self-UAT physical trên DEV. Sau schema/integration
và release được Lead duyệt phải restart Backend trước runtime QA.

Harness `test/warehouse-delivery-physical.e2e-spec.ts` dùng PostgreSQL 16 ephemeral của
GitHub Actions hiện có trong schema UUID, compiled entities/store và real migrations;
không dotenv/DATABASE_* hoặc shared DB option. Có enrollment/legacy, pending/replay,
CAS/same-command race, assignment/customer denial, rollback, code/DB physical gate,
JSON types, immutable journal/RLS/ACL và down guard. Local skip không phải PG PASS.
Không push để kích CI trong task writer. SAFE_TO_APPLY_DB=NO;
SAFE_TO_ACTIVATE_PHYSICAL=NO; SAFE_TO_ACTIVATE_FINANCE=NO.

**PostgreSQL CI security finding 06/11/2026:** Run #42071519421: 214 PG tests PASS, one FAIL where a forged nonempty `quantities` array passed the database trigger: JSONB containment `@> []` is true even for nonempty arrays. Updated migration `0007` to require exact JSONB empty `quantities` and `evidence` arrays and exact null fields for warehouse/SM/courier, adding an adversarial evidence case. CI after fix remains NOT VERIFIED until next run, shared DEV remains unchanged.


## 17. Operational zero-fee vertical slice — source writer 06/11/2026

Đã triển khai code ghi thật, không chỉ preview. **Chưa apply schema, deploy hoặc kích hoạt DEV.**
Lead giữ release; các mục 1–16 mô tả checkpoint trước đây, không phải trạng thái route mới.
Không có commit/push/merge, đổi ENV, provider booking hoặc ghi shared DEV trong task này.

### Inventory nguồn thẩm quyền và blocker

| Nguồn thực tế | Đủ thẩm quyền cho việc gì | Phần còn thiếu |
| --- | --- | --- |
| AdditionalCost APPROVED, customer quyết định, delivery, shippingFee riêng | Nguồn phí được duyệt độc lập với parts/labor; không tự thành đồng thuận chia phí | Chỉ phí 0 được admit; source phải chứa đúng toàn SKU request, không deficit/reused stock |
| Quotation APPROVED | Parts/labor đã duyệt | Không có shipping approval riêng; không admit quotation/PRE_REPAIR/Warranty |
| B1 domain/store/0005 | Version/CAS, hai actor/receipt, revise xóa consent/actual hiện hành, append-only audit | Adapter mới xác thực principal/DB role/owner/assignment và evidence, không dùng B1 metadata như proof bytes |
| W2 PICKUP allocation | Quyền và stock PICKUP | Không dùng cho DELIVERY; cohort/warehouse proposal/journal riêng |
| Admin policy DRAFT/0006 | Preview cấu hình giả định | Không phải phí được khách/thợ chấp thuận hoặc quyền mở gate |
| Finance 0004 và các consumer | Legacy snapshot và cutover CLOSED | Chưa có approved courier payable/recipient/D ledger, seller-of-record/tax/refund/funding; không bịa quyết định |

`CURRENT_STATE` handoff chưa tìm thấy trong backend worktree hoặc đường dẫn FixHome khả dụng;
không coi các checkpoint cũ là owner/Finance signoff. Web companion được kiểm source tại
`src/api/w3-delivery-physical.api.ts`: hiện chỉ gọi preview; chưa hỗ trợ các command mới.
Mobile/AI không sửa; cross-repository runtime/parity **NOT VERIFIED**.

### Capability và API đã mount trong Backend hiện có

Base `/api/v1/part-requests/:id/delivery`, JWT + RolesGuard, reload active DB role/ownership,
no-store và response envelope hiện có. Không nhận actor/source verdict/stock quantity từ client.
Machine blocker trả qua `error.code=CONFLICT`, `error.details.blocker`.

| Method/path | Actor | Input |
| --- | --- | --- |
| GET `/` | Customer owner, active Technician, SM của kho proposal | Trạng thái/version hiện tại; invalidated khi source/lifecycle/scope đổi |
| POST `/evidence` | SM; Technician chỉ cho TECHNICIAN_RECEIPT | Multipart file JPEG/PNG/WebP ≤10MB, warehouseId, purpose, quoteVersion |
| GET `/evidence/:evidenceId` | Đúng scope hiện tại | URL private ngắn hạn; không trả object path |
| POST `/proposal` | Active SM của warehouse được chọn | commandId UUIDv4, expectedVersion, warehouseId, evidenceId QUOTE, courierReference, totalShippingFee=0 |
| POST `/consent` | Đúng Customer hoặc đúng active Technician | commandId, expectedVersion, quoteVersion, quoteFingerprint, totalShippingFee, shippingShare, accepted=true |
| POST `/actual` | SM của warehouse proposal | commandId, expectedVersion, quoteVersion, totalShippingFee=0, evidenceId ACTUAL |
| POST `/reserve`, `/release` | Technician / current SM tương ứng | commandId, expectedVersion của physical journal |
| POST `/issue-to-courier`, `/dispatch`, `/receipt` | SM, SM, Technician tương ứng | commandId, expectedVersion physical, evidenceId đúng stage/proposal/warehouse/uploader |

Hai namespace revision khác nhau: consent version tăng qua proposal/consent/actual;
physical version tăng riêng qua reserve/issue/dispatch/receipt/release. Client phải GET đọc lại
sau conflict hoặc kết quả chưa rõ, giữ commandId/payload cho retry; không tự rebase retry.
Exact replay kiểm quyền hiện hành trước khi trả receipt, không áp delta hay audit lần hai.

Nguồn phải là ADDITIONAL DELIVERY mới, full-source và có shippingFee **được duyệt bằng 0**.
Ceiling/actual dương trả `FINANCE_LEDGER_SOURCE_REQUIRED` trước hiệu ứng tiền/kho. Không dùng
actual giảm từ ceiling dương để lách. Không suy phí 0 từ thiếu dữ liệu hoặc trần config.
Không hỗ trợ positive-fee proposal/consent trong slice này; đây là blocker cụ thể, không phải
Finance đã hoàn tất. Cần ledger nguồn, aggregate labor/D, legal/tax và review consumer trước mở.

Zero-spending budget nội bộ `{0,0,0}` chỉ để tái dùng domain với t=0; **không phải** khẳng định
tiền công/commission/D của order bằng 0. Public quote chỉ trả policy/version/fingerprint/S/c/t,
`laborBudget=UNVERIFIED`; không trả sentinel budget/netLabor hoặc receipt của người khác.
Phí 0 vẫn bắt buộc khách và kỹ thuật viên tự consent riêng đúng fingerprint/version/S/share.
Revise thay chứng từ/proposal tạo quote version mới, cả hai consent và actual hiện hành hết hiệu lực.

Upload dùng private OrderEvidenceStorage hiện có, sniff bytes/MIME/size, provider upload thành công
rồi mới lưu digest SHA-256 do server tính; recheck scope sau upload, rollback thì cleanup file chưa
được tham chiếu. Không nhận URL/ref/digest do client tự khai làm proof. Record bất biến bind request,
order, warehouse, uploader, stage và quote version. Chứng từ thủ công vẫn cần người vận hành kiểm:
`UPLOADED_BYTES_NOT_COURIER_VERIFIED` / `RECORDED_NOT_EXTERNALLY_VERIFIED`; không phải courier
đã xác minh, đã trả tiền hoặc proof-of-payment. Không dùng lại cùng bytes cho hai physical stage.

### Tồn kho, journal và vòng đời an toàn

Enrollment cùng transaction tạo request, sau khi lưu mọi item, chỉ full-source ADDITIONAL DELIVERY;
không tự enroll request đã commit hoặc chuyển legacy/deficit. Request phí dương full-source vẫn
vào cohort để fail closed, không rơi về billing/QR 100/0; không quảng bá thành positive live.

Kho được SM chọn và bind chứng từ/proposal. RESERVE kiểm source, scope, actual0 và cả hai consent
trong transaction, khóa toàn SKU có thứ tự; thiếu bất kỳ SKU thì PENDING_ASSISTANCE, giữ 0 SKU.
RESERVED → ISSUED_TO_COURIER → DISPATCH_RECORDED → TECHNICIAN_RECEIVED là bốn sự thật riêng.
ISSUE trừ on_hand/reserved đúng quantity; dispatch/receipt không trừ thêm. RELEASE chỉ từ RESERVED,
giải phóng đúng reservation attribution một lần, không đòi consent còn mới hoặc SM cũ còn active.

Migration tiến 0008 thêm hai bảng append-only/RLS và scoped admission mới; không sửa 0004–0007,
không bật global gate, không cấp grants. Movement INSERT trigger kiểm current+delta và tự UPDATE
stock trong cùng transaction; deferred constraint đòi đủ movement mỗi SKU. Không thể tạo receipt
giữ/issue chỉ bằng after=current mà không có delta. Source/items snapshot freeze sau proposal;
item/usage của cohort không được sửa/thêm/xóa; assignment/kho không được mất authority khi đang
có issued obligation. Down chỉ cho hai bảng mới rỗng, có history thì từ chối; không xóa history.

Technician receipt **không** tự đổi PartRequest thành legacy RECEIVED hoặc gán custody ở lúc SM
issue. Usage, Invoice/legacy billing, completion và financial consumers của cohort chưa hủy vẫn
chặn. Trước issue: RELEASE rồi cancel request trước khi đóng order. Sau issue/receipt: không đảo
tồn hoặc xóa nghĩa vụ; custody/usage/return/financial resolution cần contract và owner decision
riêng. Warehouse/assignment có thể tiếp tục bị khóa cả sau TECHNICIAN_RECEIVED vì chưa có path
giải quyết nghĩa vụ này. Đây là giới hạn vận hành có chủ đích cần Lead hiểu trước release.

### Kiểm chứng và release boundary

Reviewer độc lập chỉ đọc đã tìm và yêu cầu sửa actor revoke race, giả movement không đổi tồn,
evidence sai kho, source/item/assignment drift, replay sau reserve và sentinel budget lộ ra API.
Các fix có trong source. Reviewer chạy lại **6 spec / 109 tests PASS**, diff check PASS;
đây là code/security review, **không phải Finance/legal signoff**.

Unit của service dùng real consent domain/store + stock writer với transaction/provider double;
không chứng minh PostgreSQL locking hoặc provider thật. Harness PostgreSQL cô lập hiện có thêm
3 case: production intake → full physical chain + lifecycle guards, concurrent CAS, và direct SQL
forged movement/incomplete journal phải rollback. Provider của harness là double, không gọi thật.
Docker daemon không hoạt động cả sau kiểm tra quyền ngoài sandbox; không có local PostgreSQL tools.
PG harness local skip, DDL/trigger/races/full `test:e2e`/HTTP JWT/provider/shared DEV/Web/Mobile runtime
**NOT VERIFIED**. Không dùng shared DEV thay môi trường test. Gate cuối theo kết quả bàn giao.

Gate cuối thực chạy trên Node **24.15.0** (Node 20.19.5 của `.nvmrc`: NOT VERIFIED):

| Lệnh/gate | Kết quả |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors, 4 warning cũ ngoài scope |
| `npm run build` | PASS |
| `npm test -- --maxWorkers=4 --silent` | PASS — 305 files, 3897 tests passed, 58 skipped, 0 failed |
| Focused service/controller/stock/context sau fix cuối | PASS — 4 files, 35 tests |
| `npx vitest run --config vitest.config.e2e.ts test/warehouse-delivery-physical.e2e-spec.ts` | 19 skipped; actual PostgreSQL NOT VERIFIED |
| `git diff --check` | PASS |
| Full `npm run test:e2e`, Docker/health, HTTP/provider/Web/Mobile/shared DEV | NOT VERIFIED — không có PostgreSQL cô lập, không dùng shared DEV |

RED→GREEN đã ghi nhận cho adapter admission, stock DB-owned delta và malformed approved fee
(null không được biến thành 0). Full suite cuối chạy sau các fix, không thay bằng chứng SQL runtime.

Lead phải kiểm PostgreSQL/HTTP thật, schema/grants/security, consumer và operator recovery trước
quyết định release; apply forward schema đã duyệt rồi restart Backend trước runtime QA. Không chạy
Docker Compose hoặc `/health` có thể nối shared DEV trong task writer.

**IMPLEMENTED SAFE SOURCE SLICE; DEV NOT ACTIVATED. SAFE_TO_APPLY_DB=NO;
SAFE_TO_ACTIVATE_FINANCE=NO.** Không tuyên bố hoàn thành positive shipping hoặc full W3.

## 18. Finance snapshot validation — source writer, 06/11/2026

Phạm vi worktree `fixhome-w3-finance-ledger-20261106`, base `0b0cf5b`:
chỉ Finance, voucher frozen facts/spec tương ứng và mục này. Không sửa PartRequests,
Wallet, migration 0008, CI hoặc client. Lead giữ integration và cập nhật
`docs/CONTEXT.md` theo section 0 trong cùng PR; context nằm ngoài allowlist writer.

`finance/invoice-financial-snapshot.ts` bổ sung reader thuần, output bất biến, kiểm
số nguyên VND/canonical bigint driver strings và phép cộng/trừ bằng BigInt:

- Gross dùng `L+F+T+W+c`; PlatformDue giữ `C+F+FULL S`.
- `technicianPayout=gross-C-F-FULL S`, `netLabor=L-C-t`, `nonlabor=T+W`.
- Đây là các giá trị **trước D**, không mặc định mọi invoice có D=0 và không áp
  deduction hoặc tạo ledger đích. Thiếu ledger D và full accounting vẫn chặn activation.
- Từ chối snapshot W3 thiếu/sai share, gross/subtotal xung đột, tràn số hoặc net labor
  âm, kể cả khi linh kiện thợ có thể che phần âm trong tổng payout. Không clamp hoặc
  dùng voucher để bù ngân sách. Legacy 100/0 giữ quy tắc reader cũ, gồm pre-migration shape.

`readInvoiceShippingSnapshot` nhận thêm danh sách shipment tùy chọn để kiểm tổng
snapshot invoice từ **từng** shipping snapshot đã hợp lệ; tổng dùng BigInt, không chia
lại trên tổng S. Hai shipment S=1 cho c=2,t=0. Danh sách phải không rỗng, cùng policy
invoice và khớp full S/c/t; thiếu/sai dòng bị từ chối. Invoice không có danh sách vẫn
phải qua quy tắc single-shipment cũ. Một invoice không trộn policy; group phải đọc từng
child theo policy riêng, không gom courier cost rồi tính lại tỷ lệ.

Đây chỉ là kiểm số học: danh sách không có shipment identity/source binding, nên **không**
chứng minh đủ shipment, uniqueness, approved actual, dual consent hay assignment.
Không có caller live cung cấp danh sách này. Adapter tương lai phải đọc immutable
shipment facts đúng invoice/order và kiểm completeness/uniqueness trong transaction;
không nhận danh sách hoặc verdict từ client. Schema CHECK hiện tại chưa hỗ trợ aggregate
rounding W3; cần forward migration do writer/Lead khác review trước activation.

`FinanceService.ensureFinancialDues` và `frozenVoucherInvoiceFacts` dùng chung monetary
reader, giữ amount caps/commission/source-item checks tương ứng. Cả hai vẫn gọi
`assertShippingFinancialCutoverAllowed` trước xử lý tiền; không mở W3 voucher/funding.
Các guard payment/settlement/group/refund và DB cutover không bị gỡ hoặc thêm override.

**Custody wiring chưa sửa:** `wallet/custody-settlement.ts` nằm ngoài allowlist; vẫn
giữ công thức legacy L-C sau guard đóng. Lead phải nối monetary reader ở đó trước khi
mở W3, dùng netLabor/nonlabor đã kiểm và đối soát ledger hold/release/idempotency.
Wallet CASH legacy còn `allowNegative:true`; task này không thay quy tắc đó. Test guard
chứng minh W3 bị chặn trước wallet/ledger bằng doubles, **không** chứng minh live W3
không âm ví hoặc đã reconcile tiền thật.

BA/PM: không tự quyết seller/tax/refund hoặc giới hạn demo. Tech Lead/Senior: helper
trong module hiện hữu, không dependency/schema/ENV mới. Security: snapshot fail closed,
guard không đổi, không auth bypass. QA/QC: kiểm số học và consumer guard tách biệt với
PostgreSQL/provider/JWT/runtime. Đây là tự review, không phải Finance signoff độc lập.

PostgreSQL E2E, shared DEV, Docker/health, provider và Web/Mobile runtime:
**NOT VERIFIED** trong task này; không chạy server, migration hoặc ghi DB dùng chung.
Sau integration/release được Lead duyệt phải restart Backend trước runtime QA.
**SAFE_TO_ACTIVATE_FINANCE=NO**; kết quả gate local ghi trong handoff writer.

Kiểm chứng trên Node **20.19.5**: hai regression consumer đã RED (dues nhận commission
vượt labor; voucher ép false thành 0). Mutation kiểm hai lỗi cũ (bỏ trừ t, chia lại tổng
shipment) làm **5/30 test helper FAIL**; khôi phục implementation rồi chạy focused
shipping/financial snapshot, shipping policy, dues, cutover, voucher và context:
**7 files/97 tests PASS**. Full `npm test -- --maxWorkers=4` với TZ UTC:
**304 files passed/5 skipped; 3904 tests passed/58 skipped/0 failed**.
`npm run typecheck`, `npm run build`, `npm run lint`, `git diff --check`: **PASS**;
lint giữ 0 errors/4 warning có sẵn ngoài allowlist. Không dùng unit/doubles hoặc mutation
check thay cho PostgreSQL, source authority, Finance signoff hay đối soát tiền runtime.

## 19. Cổng phát hành DEV cho migration W3 0004–0008 (06/11/2026)

Đây là gate phát hành **chỉ DEV**, không phải activation W3 và không đụng
Production. Source: `src/database/w3-dev-release-gate.ts` (planner + gate),
`src/database/w3-dev-release.ts` (entrypoint), unit
`src/database/w3-dev-release-gate.spec.ts` và PostgreSQL harness
`src/database/w3-dev-release.postgres.spec.ts`.

### Phạm vi và thứ tự

- Chỉ đúng năm migration W3 `1793466000004`–`1793466000008`, đúng thứ tự
  class/timestamp. Migration `DeliveryZeroFeeOperations1793466000008` là
  additive zero-fee operational slice: hai bảng private
  `delivery_operation_evidence`, `delivery_shipping_proposals`, guard
  evidence/proposal, trigger movement completion, guard thay thế cho event/
  movement 0007 (giữ function `_closed` cũ) và các guard request/item/invoice/
  order/assignment/source/warehouse. Nó không mở invoice/global gate.
- Prerequisite bắt buộc đã có trong ledger: bốn migration voucher/interruption
  (`1792994400000`, `1792994400001`, `1793116800000`, `1793203200000`), W1
  `WarehouseInventory1793379600003` và W2
  `WarehousePartFulfillment1793466000003`. Gate cũng kiểm base table/cột mà
  0008 cần (`part_request_items`, `additional_cost_items`, shipping fee,
  `warehouse_stock.updated_at`, warehouse responsible/status) trước khi apply.
- Cặp cash/reputation `CashPaymentIntents1793293200000`,
  `TechnicianResponsibility1793293200001` được phép còn pending để gate
  cash-first hiện có chạy tiếp; mọi migration pending khác bị từ chối. Gate W3
  không ghi ledger cash, nên transaction 0008 và cặp cash pending tách biệt.
- Deploy DEV chạy gate W3 trước, rồi gate cash/reputation không đổi, rồi mới
  restart Backend. Gate W3 chỉ apply schema W3, không chạy migration cash.

### Cơ chế fail-closed

- Opt-in: chỉ chạy khi `NODE_ENV=production` và `W3_DEV_RELEASE=1`; thiếu một
  điều kiện thì dừng, không in giá trị môi trường.
- Khóa advisory `pg_try_advisory_lock(1793466000, 4)` (khác khóa ghi policy W3
  `(1793466000, 6)`), đọc ledger `public.migrations` đúng một lần dưới khóa.
- Kiểm DB role (`public`, CREATE, superuser/bypass RLS), schema prerequisite,
  ledger order và replay marker. Marker 0008 là OR của hai bảng mới, function
  zero-fee, function `_closed` và trigger guard, nên schema 0008 dù chỉ còn một
  phần cũng không được replay DDL. Nếu schema W3 đã tồn tại nhưng ledger thiếu
  thì từ chối chạy lại DDL; không chạy `down()`.
- Apply các migration W3 còn thiếu trong **một transaction** cùng ledger row;
  lỗi giữa chừng rollback toàn bộ, kể cả 0008. Sau apply kiểm lại bảng/cột/
  constraint/index/trigger/function, RLS, PUBLIC/API-role revoke, quyền backend,
  function 0008 không execute cho PUBLIC, event/movement guard mới đã thay thế
  guard `_closed`, và gate physical phải đóng (đúng một row `enabled=false`,
  invoice CHECK cutover vẫn còn).

### Kiểm chứng

| Gate | Kết quả |
| --- | --- |
| `npx vitest run src/database/w3-dev-release-gate.spec.ts` | PASS — 6 tests |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors, 4 warning có sẵn |
| `npm run build` | PASS |
| `npx vitest run src/database/w3-dev-release.postgres.spec.ts` | NOT VERIFIED — local không có PostgreSQL/Docker; 10 tests skip, CI step chạy với `W3_DEV_ISOLATED_PG=1` |
| Shared DEV migration/restart, `/health` | NOT VERIFIED |

Unit test phủ exact order 0004–0008, cash pair coordination, thiếu prerequisite,
unknown pending, missing/reordered/partial W3, reversed cash ledger và no
downgrade. PostgreSQL harness (CI-only, database UUID riêng, không đọc `.env`)
phủ rollback khi 0007 hoặc 0008 lỗi giữa chừng, apply + idempotent replay không
`down`, legacy invoice default/immutability, unknown pending, thiếu index,
grant API-role, DB role yếu, replay khi ledger 0007/0008 thiếu, marker 0008
partial và việc cặp cash vẫn pending sau gate W3. Harness staged dùng
`import.meta.glob` cho 0008: branch gate compile trước integration, nhưng CI
fail-closed nếu migration 0008 chưa được cherry-pick.

CI thêm step PostgreSQL cô lập trước `npm run test:e2e`; deploy VPS chạy
`docker compose ... run --rm --no-deps -e W3_DEV_RELEASE=1 backend node
dist/database/w3-dev-release.js` trước gate cash và trước `up -d`.
Không có secret/env value trong output. Không push/merge/deploy hay ghi shared
DEV trong task này. Migration class 0008 do worktree W3 finance/delivery cung
cấp và được Lead cherry-pick vào Backend trước CI; gate chỉ whitelist/verify,
không sao chép hay sửa source 0008.

## 20. Aggregate shipping labor budget — preparatory source, 06/11/2026

Worktree `fixhome-w3-finance-aggregate-20261106`, base `e507653`.
`finance/order-shipping-labor-budget.policy.ts` thêm helper thuần
`assessOrderShippingLaborBudget`, schema `W3_ORDER_SHIPPING_LABOR_BUDGET_V1`.
Input phải khai rõ order, L/C/D, tập `deliveryRequestIds` cần tính và đúng một immutable
quote head cho mỗi request. Helper kiểm coverage, scope, version, số nguyên VND an toàn,
policy W3 và share từng shipment; cộng **t đã snapshot của từng delivery** bằng BigInt,
đòi `L-C-D-sum(t)>=0`, không clamp hoặc lấy NONLABOR/voucher bù thiếu.
Hai shipment S=1 vẫn cho tổng c=2,t=0, không chia lại tổng S=2.
Output chỉ số học, đóng băng và luôn `financialExecution=BLOCKED`.

`assessDeliveryOrderShippingLaborBudget` trong consent domain là adapter chuẩn bị:
replay/kiểm từng `DeliveryConsentState` bằng receipt hiện có trước khi chuyển các
quote head sang helper. Không dùng budget riêng của một quote làm budget chung của order.
Exact retry trên cùng canonical head không tăng tổng; gửi lặp head, kể cả cùng payload
hoặc hai quote version của cùng request, bị từ chối. Không tự chọn MAX(version), dedup,
coi thiếu sibling là 0 hoặc dùng trạng thái physical làm bằng chứng financial release.
REVISE chỉ thay head khi future adapter đã chứng minh replacement bằng canonical DB evidence.
Actual giảm vẫn giữ quote ceiling trong phần commitment; RELEASED/invalidated/cancelled
không tự nhả tiền. Nghĩa vụ courier cũ chưa giải quyết phải tiếp tục được tính; nếu một
request có nhiều nghĩa vụ chưa giải quyết thì chưa đủ canonical model để consume helper.
Không xóa lịch sử hoặc tự tạo release/debit ledger cho các trường hợp này.

**Chưa nối aggregate vào live spending transaction.** Hash/receipt domain và hai danh sách
đầu vào không chứng minh DB completeness, freshness, current head hoặc Finance approval.
Adapter tương lai phải đọc cả coverage/head và approved L/C/D dưới cùng khóa ServiceOrder
đã có trong `DeliveryOperationsService.scope`, rồi kiểm lại CAS trước ghi. Mọi writer thay
commitment phải dùng cùng khóa; cần PostgreSQL concurrency/rollback tests trước cutover.
Không nhận danh sách/verdict từ client hoặc dùng owner preview NON_ATOMIC làm authority.

Consumption live hiện có vẫn fail closed: `source()` đòi explicit phí 0 ở cả AdditionalCost
và PartRequest; POST proposal/actual dương vẫn chặn `FINANCE_LEDGER_SOURCE_REQUIRED`.
Không gọi aggregate với danh sách sibling rỗng tự dựng. Zero-spending sentinel không chứng
minh L/C/D hoặc sibling bằng 0; public quote tiếp tục `laborBudget=UNVERIFIED`.
Không sửa W1/W2/PICKUP, legacy invoice, shipping reader, Finance cutover, migration,
Admin policy/system-config, ENV hoặc consumer Web/Mobile/AI.

Review BA/PM: đúng phạm vi source arithmetic, chưa hoàn thành positive shipping hoặc full W3.
Tech Lead/Senior: tái dùng split và receipt replay hiện có, không dependency/schema/API mới.
Security: fail closed coverage/duplicate/shape, không mở quyền/tiền hoặc tin client verdict.
Tester/QA: test thật trên domain/aggregate, service dùng persistence double; không coi đó là
bằng chứng row lock PostgreSQL, courier hoặc tiền thật. Đây là tự review, chưa có independent
Finance/legal signoff.

Blocker còn lại: canonical aggregate commitment/release source, ledger L/C/D và D>0,
seller-of-record/tax/consent, courier payable, refund/funding/custody và invoice aggregate
CHECK/cutover. PostgreSQL/E2E/concurrency, HTTP/provider, Docker/health, shared DEV và Web
runtime **NOT VERIFIED**. Không apply schema, ghi DB, commit/push/PR/merge/deploy.
`docs/CONTEXT.md` ngoài allowlist writer; Lead phải cập nhật theo section 0 trong cùng PR
tích hợp. Sau integration/release được duyệt, restart Backend trước runtime QA.

Kiểm chứng Node **24.15.0** (Node 20.19.5 theo `.nvmrc`: NOT VERIFIED): genuine RED
18 helper tests và 6 consent-adapter tests với implementation stub, sau đó GREEN.
Focused regression **21 files / 396 tests PASS**; `npm run typecheck`, `npm run build`
và `npm run lint` **PASS** (0 errors, 4 warning cũ). Focused ba spec aggregate/consent
adapter/operations: **47 PASS**. Full `npm test -- --maxWorkers=4`, TZ UTC, đã kết thúc
trước yêu cầu hủy của Lead: exit 0, **310 files passed / 6 skipped; 3973 tests passed /
68 skipped**, runner 112,61 giây; không chạy lại. Prettier ba file mới và
`git diff --check` **PASS**. Các kết quả này không mở Finance hoặc thay PG/runtime evidence.

**PREPARATORY SOURCE COMPLETE; SAFE_TO_ACTIVATE_FINANCE=NO.**
