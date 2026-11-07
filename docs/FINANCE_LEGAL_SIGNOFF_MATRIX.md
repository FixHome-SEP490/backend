# W3 Finance/legal signoff matrix — preparation only

Ngày lập: 06/11/2026. Base Backend `origin/dev cedfe4c`.
**SAFE_TO_ACTIVATE_FINANCE=NO. Mọi financialExecution vẫn BLOCKED.**

Tài liệu này mô tả hồ sơ cần ký, không phải biên bản phê duyệt. Owner đã chốt hướng
nghiệp vụ 1–5 tại mục 23 [hợp đồng W3](WAREHOUSE_W3_FINANCE_CONTRACT.md).
Chưa có bằng chứng Finance/legal độc lập cho cả sáu quyết định. Chưa biết danh tính,
mandate hoặc chữ ký người phê duyệt; tất cả hiện **UNASSIGNED / NOT SIGNED**.
Tên chức năng trong bảng là đề xuất bên chịu trách nhiệm để Lead xác nhận; không tự
tạo role `FINANCE`, quyền SQL, quyền Admin, seller, tax issuer hoặc courier payee.

## Sáu quyết định và tiêu chí nhận hồ sơ

| # / quyết định | Ai phải ký (cần chỉ định người thật + mandate) | Bằng chứng bắt buộc | Tiêu chí chấp nhận trước một cutover riêng | Hiện trạng |
| --- | --- | --- | --- | --- |
| 1. FixHome thu khách c=70% actual S, trừ t=30% actual từ payable labor của thợ, trả full S courier | Finance chịu trách nhiệm kế toán; Legal xác nhận cơ sở thu/khấu trừ và hợp đồng các bên; PO xác nhận nghiệp vụ | Sơ đồ dòng tiền và debit/credit từng rail, hợp đồng courier/thợ/khách, quy tắc làm tròn từng shipment, đối soát gross/net/fee/tax, nguồn chứng minh nghĩa vụ phải trả | c+t=S từng shipment, tổng từng shipment khớp order; không tính lại split trên tổng; không lấy ví/PlatformDue legacy để thay payable thợ; mỗi charge/disbursement có chủ thể và proof riêng; độc lập review kế toán | Owner direction có; Finance/legal NOT SIGNED; không charge/payable/payout W3 |
| 2. Freeze C trước positive quote; D là statement đầy đủ, kể cả explicit verified zero | Finance ký nguồn L, rate/version C, taxonomy D và mandate người attester/reviewer; Legal ký tính hợp pháp của từng loại khấu trừ; Lead xác nhận technical binding | Approved labor/config/version fingerprint; danh tính + phạm vi order/cohort + hạn và cơ chế thu hồi mandate; chứng từ gốc có digest, quyền truy cập/retention; quy trình maker/checker độc lập và sửa sai bằng revision mới; statement 0 có người chịu trách nhiệm | Thiếu D hoặc evidence/mandate hết hiệu lực phải chặn; tổng D tách C/t/shipping/parts, không double count; revision phải bind đúng C/current labor; kiểm chứng bytes/chứng từ và thẩm quyền trước khi approved; không dùng ADMIN/SM/config ACTIVE làm quyền Finance | C preparatory 0011; D metadata preparatory 0012, RECORDED_NOT_VERIFIED; taxonomy và mandate chưa approved |
| 3. Kiểm order-wide L-C-D-sum(t); thiếu phải revise, không nợ/âm ví/voucher bù | Finance ký nguồn ngân sách, thời điểm giữ/nhả và đối soát; PO ký hành vi revise; Lead ký protocol khóa/CAS/replay sau review độc lập | Persistent commitment/release ledger đầy đủ mọi DELIVERY sibling, immutable command receipts, quote/C/D revisions; order-lock protocol cho mọi writer; multi-instance race, rollback và crash/retry evidence | Từng COMMIT phải không vượt ngân sách ở mọi intermediate state; actual giảm không tự nhả; RELEASE đúng commitment/version/evidence trước dispatch và đúng một lần; unknown/missing sibling không thành 0; preparatory reservation nếu có phải PREPARATORY_ONLY, không coi là funded | Chỉ simulation; 0012 không tạo commitment hoặc reservation; live aggregateBudgetVerified=false |
| 4. Genuine actual không vượt current quote ceiling và approved source ceiling; vượt phải renew BOTH consents | Finance ký tính hợp lệ của chứng từ/đối soát; Operations/courier owner xác nhận nguồn courier; Legal ký cơ chế consent và dispute | Courier contract + identity binding, proof từ nguồn độc lập có thể xác minh, actual receipt liên kết shipment/quote/currency, hai consent của đúng actor cùng fingerprint và thời điểm | Chặn forged/manual/provider-return-only proof; verifier timeout/unknown không PASS; actual vượt một trong hai trần phải quote mới + hai consent mới trước bất kỳ financial admission; không dùng evidence quote làm actual | 0010 manual record và pure classifier; chưa có courier verifier; NOT SIGNED |
| 5. Trước dispatch chỉ refund remaining funding thật về original rail; sau dispatch manual courier review | Finance ký refund liability và reconciliation; Legal ký điều khoản hủy/hoàn; payment/courier owner xác nhận khả năng từng rail | Payment settled proof gốc + allocation theo scope, funded/refunded ledger bất biến, dispatch proof có thẩm quyền, original-rail adapter receipts, cơ chế xử lý unknown/partial/failure, maker/checker cho manual review | Không suy thiếu records là chưa thu; không refund quá remaining/nhầm rail/nhầm người; concurrent cancel/provider callback idempotent, crash-safe; sau dispatch/unknown không auto-refund/release; không đổi quy tắc wallet-only refund legacy/voucher | Classifier SIMULATION_ONLY, refundExecution BLOCKED; adapters/reconciliation chưa có; NOT SIGNED |
| 6. Seller of record, tax/invoice issuer, courier liability và payee | Đại diện Legal có thẩm quyền + Finance/kế toán thuế; đại diện pháp nhân/người được ủy quyền ký hợp đồng; PO/Lead chỉ xác nhận phạm vi triển khai | Tên pháp nhân/registration và hợp đồng đã ký được lưu riêng tư; ý kiến thuế/chứng từ; xác minh courier beneficiary/account ownership; currency/fee/tax treatment; invoice responsibility; trách nhiệm mất/hỏng/trả hàng; mandate và quy trình đổi payee | Một chủ thể hợp lệ cho từng nghĩa vụ; payee được xác minh độc lập, có lịch sử phiên bản và approval tách maker; không dùng tên SM/warehouse/Admin làm beneficiary; Finance/legal ký đủ trước thiết kế activation | UNKNOWN; không suy diễn từ 1–5, tài liệu kỹ thuật hoặc consent |

## Hồ sơ chữ ký có thể kiểm tra

Mỗi quyết định cần một record có decision ID/version, phạm vi DEV/cohort/order và thời
gian hiệu lực; danh tính người ký, tổ chức/chức trách, mandate đã xác minh và phạm vi ủy
quyền; nội dung chính xác được duyệt cùng digest; private references tới hợp đồng/proof;
ngày ký, thời hạn/revocation và reviewer độc lập. Finance/legal không phải người viết
implementation. Lead phải kiểm đủ hồ sơ và xác minh mandate qua nguồn tổ chức thật.
Không ghi dữ liệu pháp nhân nhạy cảm, tài khoản ngân hàng, chữ ký hoặc credentials vào
repo public; repo chỉ giữ reference an toàn tới kho hồ sơ được phân quyền.

Phê duyệt phải nêu rõ cả ngoại lệ, retention/access, xử lý drift và incident ownership.
Thiếu trường, chữ ký hết hạn, scope không khớp, quyết định mâu thuẫn hoặc mandate bị
thu hồi là **BLOCKED**. Test xanh, CI xanh, merged code, DB ledger hoặc Admin consent
không thay chữ ký. Không dùng cờ config hoặc biến môi trường để tự mở tiền.

## D preparation 0012: dữ kiện và giới hạn

`w3_deduction_preparations` là ledger statement đầy đủ theo order, append-only; revision
mới thay statement dùng cho diagnostics, không cộng dồn qua các revision. Order row lock
và `expected_revision` CAS tuần tự hóa INSERT. Unique `(order,command)` chặn ghi trùng;
không có automatic replay writer. Retry trực tiếp cùng revision bị từ chối; operator phải
đọc lại lịch sử khi kết quả chưa rõ, không cấp command mới để thử mù.

`actor_user_id` phải là user active có thật, `actor_role` do DB lấy từ user, kèm
`recorded_by_db_role` và thời gian DB. Đây là attribution do DB recorder khai báo; không
chứng minh actor đã đăng nhập hoặc ký statement. `mandate_ref` là claim chưa xác minh,
không là ACL hay Finance authorization. DB owner có quyền kỹ thuật, không tự có quyền
phê duyệt Finance. Không có HTTP/controller/DTO/provider writer, RPC công khai hoặc app
call site INSERT vào ledger. Recorder/authentication/maker-checker thật là slice sau.

Taxonomy **chưa được Finance/legal duyệt**, version `W3_D_PREPARATION_V1` chỉ phân loại
metadata để rà soát; không ánh xạ tài khoản kế toán hoặc cấp quyền khấu trừ:

| Category | Nội dung được khai báo để rà soát | Không được suy ra |
| --- | --- | --- |
| TAX_WITHHOLDING | Khoản thuế khấu trừ tiền công được người ghi đề nghị | Đã có nghĩa vụ thuế, tax rate, tax issuer hoặc được phép thu |
| LABOR_ADJUSTMENT | Điều chỉnh/khấu trừ tiền công khác có statement | Thợ đã đồng ý, có payable hoặc được trừ ví |
| OTHER_DOCUMENTED | Khoản D khác có chứng từ cần Finance phân loại | Catch-all approval, phí mới, C/t, linh kiện hoặc chi phí giao |

Mỗi entry có ID duy nhất trong revision, category đúng allowlist, amount nguyên VND >0,
private opaque `evidenceRef` và SHA-256 `contentDigest`. Statement có reference/digest
riêng và explicitZero bắt buộc. Empty entries chỉ hợp lệ với explicitZero=true; không
ghi statement thì `recordedDeductions=null`. Reference không được dereference tại đây;
digest là khai báo metadata, chưa kiểm bytes, authenticity, scope hoặc retention của
chứng từ. `RECORDED_NOT_VERIFIED` áp dụng cả statement 0 và số dương. Không seed/backfill
D=0. Không đưa dữ liệu giả từ fixture vào DEV.

DB bind snapshot C đầy đủ từ 0011; không nhận C/total/revision/fingerprint do caller tự
quyết. Fingerprint SHA-256 nhận diện nội dung canonical, không là chữ ký hay proof.
Nguồn C drift làm diagnostics stale và INSERT mới bị từ chối; không tự refreeze.
Guard khóa assignment/actor trước rate config, rồi Booking/quotation/additional và items
theo thứ tự 0011 trước khi kiểm C; giữ source locks đến commit, kể cả parent UPDATE để
chặn FK child INSERT. Actor-before-config tránh đảo khóa với terms của order khác.
Không có cột approval và không có chuyển từ preparatory sang approved; cần thiết kế
contract/migration mới sau signoff. Record cũ vẫn historical kể cả actor bị khóa sau đó.

## Diagnostics và release do Lead kiểm soát

Hàm nội bộ `w3_finance_readiness(uuid)` là `STABLE`, `SECURITY INVOKER`, một statement
snapshot, không khóa hoặc ghi dữ liệu. Operator DB đã được ủy quyền có thể gọi
`SELECT w3_finance_readiness($1::uuid)` bằng parameter order ID. Không có endpoint mới;
không trả actor/mandate/private evidence refs. Order không tồn tại trả SQL NULL, không
phải PASS. Hàm phân biệt C chưa có/current/stale và D chưa ghi/unapproved/stale; tổng
`recordedDeductions` chỉ là dữ kiện lịch sử. Luôn `approvedDeductions=null`,
`laborBudget=null`, `aggregateBudgetVerified=false`, `financialExecution=BLOCKED`.
Không dùng projection này làm input cho `simulateW3Commitments` hoặc live admission.

0012 enable RLS/no policy, revoke ALL table/function privileges từ PUBLIC và ba Data API
roles. Không có sequence/identity, SECURITY DEFINER, app grant, role mới hoặc policy mới.
DEV gate whitelist additive tới 0012, kiểm marker replay, constraints/indexes/columns,
trigger enabled đúng function, RLS/no policies, mọi table privilege (kể cả TRUNCATE,
REFERENCES, TRIGGER), column ACL và effective role/function ACL. Các quyền sequence
0011 vẫn được gate kiểm riêng; 0012 không tạo sequence cần grant/revoke.
Down chỉ khi ledger rỗng dưới exclusive lock; có history phải forward fix, không xóa
lịch sử hoặc disable trigger để downgrade.

Lead review code/diff, chạy CI và preflight đúng DEV schema/role/migration ledger trước
release; có lỗi thì giữ Backend cũ. Migration 0012 không mở financial/custody/positive
physical gate, không phát hành hóa đơn, capture, payout, settlement hoặc refund. Sau
Lead áp migration/release được duyệt, restart Backend rồi kiểm `/health` và API/JWT
legacy/zero-fee/PICKUP/W1/W2. Không cần dependency/env/Compose change mới trong slice này.

Shared DEV/schema, deploy/restart/health, provider thật, Web/Mobile/AI, Production và
Finance/legal signature verification đều **NOT VERIFIED**. Implementer chỉ chạy DB
cô lập và tạo commit local; không push/PR/merge/deploy. Các kết quả kiểm thử được ghi
tại mục 24 hợp đồng W3 và `CONTEXT.md`; không phải chứng nhận complete finance.
