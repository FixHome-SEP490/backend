# BUG DETECTOR #39 — gate đối soát VNPay trước khi chọn tiền mặt

Trạng thái: **BLOCKED — chưa sửa #39, không được dùng tài liệu này để mở tiền mặt**.
Rà soát tại nền `b3d5456`, nhánh
`foxonworld/fixhome-bug39-vnpay-safe-negative-reconcile-20261030`.
Chỉ thay tài liệu; không thay tiền, hóa đơn, linh kiện, voucher, API, IPN hoặc DB.

## Quy tắc D39 và nguồn provider

Chỉ cho chuyển VNPay sang tiền mặt khi provider chứng minh giao dịch đã kết thúc,
không thu tiền và không còn khả năng thu tiền muộn; mọi attempt liên quan phải hết
nghĩa vụ pending. Trạng thái nội bộ `failed` không đủ làm bằng chứng đó.

Nguồn đã tra ngày 30/10/2026:
[VNPay QueryDR/refund 2.1.0](https://sandbox.vnpayment.vn/apis/docs/truy-van-hoan-tien/querydr%26refund.html).
Trang trực tiếp timeout; nội dung được đối chiếu qua kết quả tìm kiếm của chính
domain VNPay, chưa xác nhận phiên bản hợp đồng riêng merchant đang dùng.

| Phản hồi QueryDR | Ý nghĩa được công bố | Quyết định D39 |
| --- | --- | --- |
| Response `00`, status `00` | Truy vấn thành công, đã thanh toán | Không mở cash |
| Response `00`, status `01` | Chưa hoàn tất | Giữ nghĩa vụ pending |
| Response `00`, status `02` | Giao dịch lỗi | Chưa có bảo đảm finality/no delayed payment; không mở cash |
| Response `00`, status `04` | Đảo giao dịch; khách đã bị trừ tiền | Không phải bằng chứng chưa thu; không mở cash |
| Response `91` | Không tìm thấy giao dịch | Không chứng minh kết thúc; không mở cash |
| Timeout/lỗi mạng/sai chữ ký/thiếu binding | Không có bằng chứng đáng tin | Không mở cash |

`vnp_ResponseCode=00` của QueryDR chỉ nói truy vấn thành công. Không chuyển bảng
mã QueryDR thành bảng mã IPN. Không suy ra finality từ tuổi giao dịch, TTL link,
khách quay về, hủy trên client hoặc một lần không tìm thấy giao dịch.

## Bằng chứng trong source và blocker

- `src/modules/finance/payment-verification.port.ts`: chỉ có `verified` hoặc
  `unavailable`; không có negative proof được xác minh, finality hay attempt binding.
- `vnpay/vnpay.util.ts`: `buildQueryDrRequest` ký request bằng chuỗi phân cách `|`;
  `verifySignature` dành cho IPN/return dùng query string đã sắp xếp. Chưa có
  verifier response QueryDR riêng. Tài liệu provider mô tả chuỗi response phân
  cách `|` với `ResponseId`, command, response, message, merchant, ref, amount,
  bank, PayDate, transaction number/type/status, OrderInfo và promotion fields.
  Phải chốt schema/version thực tế trước khi viết verifier; không dùng chữ ký IPN thay thế.
- `FinanceService.reconcileVnpayPayment` và `reconcileVisitVnpay` chỉ xử lý `00/00`.
  Legacy không kiểm chữ ký response hoặc đối chiếu response merchant/ref trước
  settlement; nhánh funded gửi response sang IPN verifier khác protocol. Đây là
  rủi ro tồn tại, không phải bằng chứng positive/negative reconciliation an toàn.
- `handleVnpayIpn` xác minh chữ ký, ref tìm attempt và amount; legacy chưa có
  merchant binding như funded. Legacy đánh dấu mọi numeric non-success là failed;
  #24 tests còn characterization unknown numeric outcome. Không mở rộng nghĩa
  `failed` thành `NOT_SETTLED`, không sửa IPN trong patch tài liệu này.
- `applyVerification` còn dùng `FAILED` cho unavailable/amount mismatch;
  `applyVisitVnpay` dùng `failed/ALLOCATION_CHANGED` khi đã nhận paid proof nhưng
  allocation thay đổi. Các trạng thái này có thể còn nghĩa vụ tiền thực tế.
- `createCashIntent` chặn PENDING/VERIFIED invoice attempts và các pending/verified
  parent attempts. Đây là guard hiện có; không phải đường reconcile negative.
  Nó không tự chứng minh mọi attempt FAILED/CANCELLED là hết nghĩa vụ provider.
- Replay/IPN: attempt đã khác pending bị bỏ qua; tự fail/cancel pending để mở cash
  có thể khiến callback PAID muộn bị bỏ qua. Khóa DB không thể ngăn ngân hàng thu
  tiền muộn. Unique ref/idempotency chỉ chống ghi trùng, không chứng minh finality.
- Khóa hiện tại: SOLO create intent khóa invoice rồi order; SOLO paid callback
  khóa payment rồi invoice. VISIT_GROUP paid callback khóa group rồi attempt,
  rồi invoices. Chưa kiểm chứng chung mọi rail/funded/receipt và nhiều instance.

## Hợp đồng tối thiểu owner/provider phải cung cấp

1. Schema và thuật toán response QueryDR chính xác cho merchant/version: thứ tự
   ký, encoding, empty/optional/promotion fields, HMAC và test vectors tổng hợp.
   Xác định cách correlation request/response thực sự được provider hỗ trợ;
   không mặc định `ResponseId` echo `RequestId`.
2. Quy định bằng văn bản trạng thái nào chứng minh terminal NOT_SETTLED và bảo đảm
   không thu/settle muộn cho đúng merchant + TxnRef + lần khởi tạo. Nếu QueryDR
   chỉ là snapshot, cần cancel/close/expiry acknowledgement có cùng bảo đảm từ
   provider. Timeout/91/04 và `failed` nội bộ tuyệt đối không thay được bảo đảm này.
3. Quy tắc xử lý PAID trái negative proof, IPN reorder/retry, reversal và khi nào
   ngân hàng hết nghĩa vụ; không âm thầm bỏ callback hoặc thu tiền lần hai.

Sau đó mới thiết kế bằng chứng bất biến gắn attempt, scope, merchant, ref,
amount/currency, thời điểm, protocol version và digest; server xác minh, không
nhận verdict của client. Kiểm hết tất cả attempt/parent/funded liability trong
transaction có thứ tự khóa thống nhất, re-read sau khóa và consume proof đúng
một lần. Không giữ khóa khi gọi mạng. PAID/quarantine/conflict hoặc attempt khác
còn pending đều chặn cash. Giữ nguyên invoice gross/NET, parts và ledger.

## Gate kiểm thử trước implementation/release

Chưa tạo RED test cho đường negative chưa được định nghĩa hợp đồng; không bịa
fixture `terminal=true` để biến thiếu bảo đảm provider thành PASS. Sau owner gate,
viết RED trước implementation cho SOLO/VISIT_GROUP, legacy/funded:

- PAID, incomplete, timeout, 91, reversal 04, malformed/missing signature, sai
  merchant/ref/amount/currency/command, response cũ hoặc không correlation.
- Chỉ đúng negative proof terminal mới cho cash; replay khác command/payload
  không tái sử dụng proof; scope còn attempt pending khác vẫn trả 409.
- IPN PAID đồng thời với reconcile/create/receive cash, hai request cash và
  duplicate IPN: PostgreSQL 16 dùng một lần, nhiều connection, cả hai thứ tự.
  Assert ledger/invoice/intent và rollback, không chỉ status HTTP.
- Owner quyết định riêng F4 wrong-amount response; không sửa chung vào #39.

Đã chạy focused guard/provider units: **130 passed, 16 skipped**; skipped là
PG16 opt-in, không chứng minh race. Docker daemon local không kết nối. Không chạy
E2E/shared DB/provider thật, không kiểm Web/Mobile/runtime. RED/GREEN negative
reconciliation và independent guard review: **NOT VERIFIED**.

Lead chỉ cho triển khai sau hợp đồng provider, tests cô lập, independent review
và CI xanh. Không merge/deploy DEV từ task đang BLOCKED. Sau khi có patch runtime
được duyệt, restart backend và kiểm `/health` cùng authenticated QA theo release gate.
