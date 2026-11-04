# W3 DELIVERY — ADR và hợp đồng tài chính (DRAFT, chưa kích hoạt)

Ngày: 04/11/2026. Nguồn: official dev `ba703298`, owner order W3 04/11/2026.
Trạng thái: **CODE SCAFFOLD; KHÔNG PHẢI ACTIVATED W3**. Team Finance phải review độc lập
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
