# FixHome SEP490 - W3 thanh toán phí giao theo luồng sẵn có (07/11/2026)

## Mục tiêu

FixHome là đồ án. Khi demo có thể thanh toán tiền thật qua những phương thức đang hoạt động, hoặc khách chuyển vào tài khoản nhóm và Admin xác nhận thủ công. Không bắt buộc hồ sơ Legal/Finance/courier contract/tax để build hoặc test demo trên DEV. Không dựng một hệ thống finance/settlement thứ hai; tận dụng invoice, cash intent/confirmation, VNPay/wallet, settlement và lịch sử ví hiện có. Không thay đổi PROD/main.

## Dữ liệu và phép tính chuẩn

- S = phí giao thực tế cho TỪNG DELIVERY W3, nguyên VND, được khách duyệt từ AdditionalCost riêng và có quote/dual consent của customer + technician; không vượt nguồn/quote. Phí 0 vẫn hợp lệ.
- Khách chịu c = floor((S*7 + 5)/10); thợ chịu t = S-c, nên c+t=S cho từng chuyến; cộng từng c và t khi cùng order. FixHome quản lý S (chi phí giao, có thể tự giao); không cần hệ thống chuyển tiền cho courier riêng.
- L là tiền công đã được duyệt, C là hoa hồng trên L theo snapshot tại thời điểm invoice, các khoản D khác chỉ được tính nếu có nguồn thật đã được chương trình định nghĩa; trong bản demo thông thường D=0; không suy giá linh kiện là L.
- Invoice customer gross = labor + các parts/warranty cần thu khách + tổng c; phải nhận chính xác một payment source. Technician net = labor - C - tổng t + các khoản thu nhập parts/warranty hợp lệ. Đơn W3 không được làm technician net từ labor âm.
- Ví dụ công 200000, C=20000, S=30000: khách trả 221000, thợ ròng 171000. CASH: thợ nhận 221000; wallet/platform due thu 50000 (20k C + 30k S). ONLINE/verified transfer: FixHome nhận 221000; wallet thợ cộng 171000, riêng 20k C và 30k S. Không charge/cộng double. Trường hợp commission 0%, ship 0 phải chạy.
- Existing LEGACY_100_0 invoices remain immutable and operate unchanged; no retroactive migration/rewrite.

## Workflow

1. Kho báo phí, AdditionalCost APPROVED và chọn delivery, phát sinh quote W3 theo cap admin; customer + technician xác nhận cùng phiên bản. Cap 0 nghĩa là chỉ báo phí mới 0, muốn phí dương Admin nâng cap; không biến phí có thật thành miễn phí.
2. Theo dõi kho/stock courier giao hàng dựa trên approved source, consent và version; recorded actual S <= 2 ceiling; vượt cần báo lại và lấy 2 consents.
3. Chỉ khi đúng source, physical receipt, actual và không có invoice cũ: freeze W3 invoice tách customerShippingShare/technicianShippingShare và optional per-shipment snapshot. Không lấy aggregate quote dự kiến làm actual; không tính mỗi chuyến hai lần.
4. Reuse CashIntent+received+customer-confirmed / existing confirmed cash path and Wallet/VNPay invoice payment; reuse SettlementService. W3-specific consumer allow-list chỉ mở khi invoice snapshot hợp lệ và source được freeze; keep completion hold and wallet idempotency.
5. Nếu khách chuyển trực tiếp tới tài khoản nhóm (không qua gateway), một thao tác Admin-only verified receipt, kiểm tra đúng order/amount/reference, một lần, transaction lock; trạng thái PENDING trước khi Admin xác nhận. Không coi hình chụp hoặc callback client là xác nhận. Không tự phát chuyển tiền ngân hàng.
6. Refund/hủy đúng phạm vi: trước thu thì hủy quote/commitment theo trạng thái; sau thu phải giữ immutable payment history, ghi nhận hoàn thủ công theo amount và rail, không auto refund vào wallet khi trả khoản bank/cash chưa chuyển thật.
7. UI Web cho customer/technician/SM/Admin theo flow Backend đã kiểm: báo giá 70/30, hai nút consent, shipping status, invoice breakdown, wallet result, Admin config và receipt confirmation. Mobile/backward compatibility không được biến đổi.

## Giới hạn triển khai và các bất biến an toàn

Không mở toàn bộ finance bằng một cờ duy nhất; bỏ gate cũ từng chỗ khi đã có thay thế bằng validate nguồn + snapshot + chống double charge. Giữ JWT/RBAC, source ownership, customer consent, version/CAS, idempotency, wallet/posting consistency, paid invoice uniqueness và dữ liệu lịch sử. Không xóa/truncate schema, không bỏ ràng buộc bảo vệ immutable invoice; chỉ tạo migration FORWARD nếu DB CHECK hiện chặn invoice mới W3. W1/W2/PICKUP/voucher/group/legacy phải tiếp tục chạy. Không dùng màn hình mô phỏng stateless thay cho đơn thật. DEV test bằng PostgreSQL riêng và provider fake, không test chuyển tiền thật tự động. Bật thanh toán tiền thật cho demo chỉ khi API code + UI + UAT đều đạt.
