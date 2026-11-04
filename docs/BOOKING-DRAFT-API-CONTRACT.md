# Bản nháp đặt lịch thủ công — P2

Phạm vi: Backend + Web theo owner 04/11/2026. Không sửa Mobile/AI-service. Đây là source contract,
chưa phải xác nhận DB/deploy/runtime. Migration tiến: `1793379600002-BookingDrafts`.

## HTTP

JWT + role `customer` cho cả bốn route; chỉ dùng customer ID từ JWT. Prefix `/api/v1`.
Envelope thành công hiện có vẫn bao ngoài `{ data: ... }`. Mọi response đặt `Cache-Control: no-store`.

| Method / path | Body | `data` thành công |
| --- | --- | --- |
| GET `/booking-drafts/current` | — | `null` hoặc `{id,version,expiresAt,snapshot}` |
| PUT `/booking-drafts/current` | `{snapshot,expectedVersion:number\|null}` | `{id,version,expiresAt,snapshot}` |
| DELETE `/booking-drafts/current` | — | `{deleted:boolean}` |
| POST `/booking-drafts/:draftId/submit` | `{expectedVersion:number,operationKey:UUIDv4,request:{kind:'booking'\|'visit_group',data:CreateBookingDto\|CreateVisitGroupDto}}` | `{kind,bookingId:string\|null,visitGroupId:string\|null}` |

Tất cả thành công HTTP 200, kể cả replay. Version bắt đầu 1, integer 1–2147483646 cho request.
PUT dùng `expectedVersion:null` khi chưa có draft active, ngược lại phải đúng version đang có.
Xung đột generation/version/expiry/consumed hoặc cùng operation khác fingerprint trả 409 `CONFLICT`.
Body không hợp lệ trả 400; vượt ngân sách JSON trả 413; sai quyền 403; thiếu JWT 401.
Lỗi nghiệp vụ khi submit giữ status/code của create hiện hành, gồm 409 `PENDING_VISIT_LIMIT_REACHED`.
Rate limit pilot theo customer: PUT/DELETE chung 60/phút; submit chung bucket tạo lịch 20/10 phút.
Limiter theo từng process như P0, chưa đồng bộ replica.

## `SafeDraftSnapshot` canonical (phẳng)

Mọi field tùy chọn; chỉ nhận các key sau. Field vắng thì bỏ key, không dùng `undefined` trong JSON.
Không gửi shape UI lồng `activeDevice`, `extraDevices`, `selectedAddressId` hoặc `schedule`.

```ts
type SafeDraftSnapshot = {
  kind?: 'booking' | 'visit_group';
  savedDeviceCount?: number; // integer 0..5; số item đầu đã lưu vào danh sách
  quantity?: number;         // integer 1..1000, cùng giới hạn CreateBookingDto
  step?: number;             // integer 1..4
  addressId?: string;        // UUID địa chỉ thuộc khách; không có địa chỉ chữ/GPS
  mode?: 'scheduled' | 'urgent';
  date?: string;             // YYYY-MM-DD; không giữ chỗ
  slot?: 'morning' | 'afternoon' | 'evening';
  preferredStartAt?: string; // ISO timestamp legacy
  preferredEndAt?: string;
  customerNote?: string;     // tối đa 1000 ký tự; giờ mong muốn chỉ tham khảo
  urgency?: 'low' | 'medium' | 'high' | 'critical';
  items?: Array<{
    serviceId?: string;      // UUID, được để thiếu trong bản nháp
    deviceLabel?: string;    // tối đa 80 ký tự
    description?: string;    // tối đa 5000 ký tự
    selectedVariantCode?: string; // AA-00-00; null được chuẩn hóa thành bỏ key
    deviceAttributes?: {
      brand?: string;        // tối đa 64 ký tự
      acMounting?: 'wall' | 'ceiling' | 'floor' | 'unknown';
      acHorsepower?: 'up_to_1_5' | '2_to_2_5' | 'unknown';
      washerLoadingStyle?: 'top' | 'front' | 'unknown';
      washerCapacityKg?: number | null; // 0.1..50, tối đa 1 chữ số thập phân
      washerHasDryer?: boolean | null;
    };
    photoUploadIds?: string[]; // tối đa 7 UUID khác nhau; không URL/file
  }>; // 0..5 item tổng cộng
};
```

Nếu có `savedDeviceCount`, phải không lớn hơn `items.length`; chỉ có tối đa một item cuối là editor
đang soạn (`items.length <= savedDeviceCount + 1`). Năm item đã lưu thì không có editor thứ sáu
trong snapshot. Partial/incomplete được lưu, nhưng submit phải dùng DTO đầy đủ qua validation/create
hiện có. Metadata không quyết định nghiệp vụ, quota hoặc giá khi submit.

JSON nhận tối đa 60 KiB UTF-8, depth 8 và 512 node, trước transform/recursive validation. DB có CHECK
JSON object và 64 KiB. Từ chối field lạ, URL và control characters không hợp lệ; không lưu File,
previewUrl, signed/private URL, price cache, transcript AI, token hoặc secret.

## Lưu, khôi phục và media

- Đúng một row/customer. PUT thành công chủ động mới tăng version và đặt `expiresAt` = giờ server +
  30 ngày. GET không gia hạn, không ghi lại snapshot. PUT thất bại không đổi clock.
- Đúng mốc hết hạn: GET trả null; submit 409. PUT `expectedVersion:null` thay row hết hạn bằng UUID
  mới, version 1. Sau discard/submit, lần lưu kế tiếp cũng có UUID mới.
- Kiểm ownership địa chỉ ở PUT; GET bỏ addressId đã mất quyền/đã xóa. Create kiểm lại khi submit.
- Upload TTL giữ nguyên 2 giờ. GET/PUT chỉ giữ ID của upload đúng chủ, chưa claim và còn hạn; không
  ký URL, claim ảnh hoặc gia hạn media. ID thiếu/hết hạn/không khả dụng được bỏ khỏi response.
  Web phải bỏ preview cũ và yêu cầu tải lại; không hứa giữ ảnh 30 ngày. Submit không âm thầm bỏ ảnh:
  claim hiện có kiểm lại quyền và hạn trong transaction, ảnh không hợp lệ làm rollback.
- PUT không tạo Booking, ServiceOrder, invitation, payment, giữ giá/chỗ hoặc dùng quota.

## Submit nguyên tử và retry

Trong một `DataSource.transaction`: khóa User customer theo `lockPendingVisitCustomer`, đọc receipt
`customerId + draftId + operationKey` TRƯỚC draft, rồi khóa draft version. Solo gọi chính xác
`bookings.create(dto,customer,{manager,visitGroupId:null})`; nhóm gọi `visitGroups.create(dto,customer,manager)`.
Solo có manager vẫn kiểm quota; nhóm tính một logical visit qua create hiện có.

Fingerprint SHA-256 của JSON `{expectedVersion,request}` với object keys sắp xếp, giữ array order,
phân biệt field vắng/null. Retry phải gửi đúng request/version/key ban đầu, kể cả sau kết quả chưa rõ;
không dựng lại payload theo giá/ảnh/draft mới. Group `idempotencyKey` trong DTO vẫn tham gia fingerprint
nhưng không chuyển xuống create: receipt draft là authority, tránh trả một nhóm cũ không liên quan.

Create target, insert receipt và delete đúng generation/version cùng commit; lỗi bất kỳ rollback
tất cả, kể cả photo claim/audit. Receipt không giữ request/snapshot, chỉ fingerprint và target IDs.
Unique theo customer/draft/operation và customer/draft, CHECK đúng target kind/ID; trigger cấm UPDATE/
DELETE receipt. Không FK receipt tới active draft.

A submit thành công → lưu B → retry A vẫn trả target A trước khi nhìn B; không tiêu thụ B. DELETE
chỉ bỏ row draft hiện tại, không bỏ receipt. `retainUntil` đánh dấu giữ tối thiểu 30 ngày sau submit,
khác expiry draft; không phải hạn replay. **Không có prune receipt trong P2**, cần quyết định retention
và thay đổi bảo vệ DB riêng nếu muốn dọn sau này. Không có receipt + generation đã mất thì 409,
không tự tạo target mới.

## Gate bàn giao

Migration additive, không sửa migration lịch sử. Hai bảng bật RLS, không cấp policy client;
Lead xác nhận DB server role có quyền owner/BYPASSRLS, schema, constraint, ledger và race/rollback
trên PostgreSQL trước release. Down khóa bảng và từ chối khi còn draft hoặc receipt.

Unit dùng persistence doubles; ca HTTP/PostgreSQL nằm trong harness `test/app.e2e-spec.ts` của CI,
không phải bằng chứng đã chạy PostgreSQL ở writer. Không chạy shared DB migration hoặc mutation.
Sau Lead migrate/deploy cần restart Backend, kiểm `/health` và authenticated Web cross-device restore,
version conflict, reupload, submit retry. Web/Mobile/AI/runtime ngoài worktree: NOT VERIFIED.
