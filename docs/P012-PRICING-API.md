# P012 Catalog V2 — hợp đồng preview và Booking

Phạm vi: Backend worktree tích hợp, chưa deploy hoặc migrate DB dùng chung. P1 OFF;
GATE/LATER không mở. Client không được gửi tiền hoặc tự tính tier.

`GET /api/v1/services/:id/catalog-v2-pricing` là public, chỉ nhận UUID dịch vụ V2 có
service và category ACTIVE, phase M1/M2. Query phẳng tùy chọn:

- `selectedVariantCode` (canonical), hoặc alias `variantCode`; gửi cả hai phải giống nhau.
- `brand` (tối đa 64 ký tự), `acMounting=wall|ceiling|unknown`,
  `acHorsepower=up_to_1_5|2_to_2_5|unknown`.
- `washerLoadingStyle=top|front|unknown`, `washerCapacityKg` (0,1–50 kg, một số lẻ).

Facts phải phù hợp family dịch vụ. Response dùng envelope hiện có; `data` gồm:

| Trường | Ý nghĩa |
| --- | --- |
| `serviceId`, `serviceCode` | Dịch vụ đã kiểm tra |
| `status` | `FIXED_PRICE` hoặc `INSPECTION_REQUIRED` |
| `bindingReady` | Hiện có thể chứng minh đúng một tier/scope; POST vẫn kiểm tra lại |
| `priceBinding` | Luôn `false` ở GET; preview không chốt tiền |
| `selectedVariant` | `{variantId, variantCode, scopeVi, laborPriceVnd}` hoặc `null` |
| `possibleVariants` | Các tier ACTIVE, đúng amount/scope được owner duyệt, phù hợp facts hiện có |
| `missingAttributes` | Facts/scope còn thiếu; rỗng khi đã đủ điều kiện |
| `inspectionReason` | `MISSING_FACTS`, `SCOPE_CONFIRMATION_REQUIRED`, `NO_ACTIVE_APPROVED_TIER`, `SERVICE_REQUIRES_INSPECTION` hoặc `null` |
| `priceRange` | `{minLaborVnd,maxLaborVnd,labelVi:"Giá tham khảo",priceBinding:false}` chỉ khi có nhiều tier tạo khoảng có nghĩa; còn lại `null` |
| `messageVi` | Nội dung hiển thị tiền công/phạm vi, giá tham khảo hoặc cần khảo sát |

AC-02 treo tường cần cả mounting và nhóm HP. Âm trần cần mounting `ceiling` và chọn
rõ scope cassette tiêu chuẩn `AC-02-03`; không suy cassette từ mounting. WM-02 cần
cửa trên/ngang và kg: đúng 9 thuộc nhóm ≤9, 9,1 thuộc nhóm >9. Các tier của 15 dịch
vụ fixed khác cần khách chọn mã scope rõ ràng, kể cả chỉ có một tier. AC-03 scope
treo tường từ chối facts `ceiling`.

`POST /api/v1/bookings` giữ payload hiện có, thêm `selectedVariantCode`/`variantCode`
ở root và `deviceAttributes` tùy chọn chứa các facts cùng tên. Gửi selection sai
dịch vụ, không ACTIVE, drift amount/scope hoặc mâu thuẫn facts sẽ bị từ chối. Thiếu
facts/scope vẫn tạo Booking `inspection_required`, `fixedUnitPriceSnapshot=null`.
Không tự thêm phí khảo sát. 19 mức tham khảo inspection không trở thành giá chốt.

POST kiểm tra lại service/category/tier dưới khóa trong transaction. Nếu đủ điều
kiện, `pricingModeSnapshot=fixed_price`, `fixedUnitPriceSnapshot` lấy đúng S DB,
`scopeSnapshot` lấy đúng scope đã duyệt. `catalogV2PricingSnapshot` lưu kết quả với
variant ID/code và `priceBinding=true` khi đã chốt, `false` khi khảo sát. Trigger
#0040 giữ bất biến snapshot, service, facts, pricing mode, S, scope và quantity.
GET Booking trả snapshot lịch sử, không lấy giá hiện hành để thay snapshot.

Legacy giữ nguyên giá, media, lịch và AI; snapshot V2 là `null`. Rebook đi qua
resolver hiện tại, không tự dùng lại scope/facts cũ để chốt giá mới. Quotation sau
check-in và khách duyệt dùng module hiện có. P, ΔS, warranty, ví và settlement không
đổi.

Lỗi: input/query/selection V2 sai trả 400; dịch vụ inactive/non-V2/GATE/LATER trả 404;
gắn selection V2 vào legacy trả 422 theo lỗi nghiệp vụ hiện có. POST vẫn cần JWT,
quyền `booking:create` và địa chỉ thuộc khách.

Migration `1790000000040-BookingCatalogV2Pricing.ts` chỉ thêm cột/trigger; không seed,
backfill, activation hoặc finance. Phải migrate trước khi chạy code mới; rollback
từ chối khi đã có snapshot. Chỉ được áp dụng DB cô lập trong đợt này.

Kiểm tra cô lập: sau `npm run build`, chạy
`node scripts/p012-pricing-isolated.cjs` hoặc thêm `--full-e2e` để chạy suite E2E cũ
trên một database trống riêng. Harness không đọc `.env`, tự tạo và gỡ đúng container
PostgreSQL 16 của nó, dùng credential giả lập và loopback. Không dùng Compose hoặc
container preview 3101 cho kiểm tra này.

Web/Mobile cần dùng API này, không suy giá từ Service cha (V2 giữ `fixedPrice=null`).
UI/browser parity và preview 3101 với code mới: NOT VERIFIED; process đang chạy
được giữ nguyên, cần migration #0040 trên DB cô lập và restart có kiểm soát để QA.
