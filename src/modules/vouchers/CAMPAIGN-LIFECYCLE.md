# Hợp đồng Admin campaign — P1, 27/10/2026

Source trên `foxonworld/fixhome-p1-backend-voucher-admin-20261027`, nền `1cb4915`.
Chỉ chuẩn bị code/migration; chưa apply DB, deploy hoặc kiểm chứng Web/Mobile runtime.
Tài liệu này là phần bổ sung hiện hành cho vòng đời campaign trong `INTEGRATION.md`.

## API cho Web Admin

Base `/api/v1/vouchers`. Tất cả route campaign yêu cầu JWT và role `admin`;
service kiểm lại role/identity. Giữ envelope chung `{success,statusCode,message,data}`.
Timestamp response là ISO string. `status` và `active` không chứa ý nghĩa hết hạn theo thời gian.
DTO nguồn: `dto/voucher.dto.ts` và `dto/admin-voucher-campaign-response.dto.ts`;
Swagger các route Admin dùng `AdminVoucherCampaignDto`.

```ts
type CampaignStatus = 'DRAFT' | 'PUBLISHED' | 'PAUSED' | 'ARCHIVED';
interface CampaignTerms {
  code: string; // 3–40, /^[A-Z0-9_-]{3,40}$/
  name: string; // 1–120, không chỉ khoảng trắng
  kind: 'GENERAL' | 'PERSONAL';
  autoCompensation?: boolean; // mặc định false, chỉ PERSONAL
  discount: 'PERCENT' | 'FIXED';
  value: number; // nguyên dương; PERCENT <= 100
  capVnd?: number | null; // null hoặc nguyên dương
  minimumVnd: number; // nguyên >= 0
  categoryIds: string[]; // UUID v4, tối đa 100, không trùng
  serviceIds: string[]; // UUID v4, tối đa 100, không trùng
  startsAt: string; endsAt: string; // ISO date, endsAt > startsAt
  quota: number; // nguyên 1..2147483647; cấu hình riêng từng campaign
}
interface Campaign {
  id: string; code: string; name: string; kind: 'GENERAL' | 'PERSONAL';
  startsAt: string; endsAt: string; createdAt: string; updatedAt: string;
  policy: Pick<CampaignTerms, 'discount' | 'value' | 'minimumVnd' | 'categoryIds' | 'serviceIds'>
    & {capVnd: number | null; components: ['LABOR', 'PARTS']};
  autoCompensation: boolean; quota: number; redeemed: number;
  status: CampaignStatus; active: boolean; publishedAt: string | null; version: number;
}
interface CampaignCommand { version: number; commandId: string }
// version = phiên bản vừa đọc, nguyên 1..2147483646; commandId = UUID v4.
```

| Method / path | Body | data / HTTP |
| --- | --- | --- |
| `POST /campaigns` | `CampaignTerms & {commandId?: string}` | `Campaign`, 201; luôn tạo DRAFT, active=false, publishedAt=null, version=1 |
| `GET /campaigns` | Không | `Campaign[]`, 200; tối đa 100, mới nhất trước như API cũ |
| `GET /campaigns/:id` | Không | `Campaign`, 200 |
| `PATCH /campaigns/:id` | `CampaignTerms & CampaignCommand` | `Campaign`, 200; thay toàn bộ điều kiện, chỉ DRAFT thật |
| `PATCH /campaigns/:id/lifecycle` | `CampaignCommand & {status:'PUBLISHED'\|'PAUSED'\|'ARCHIVED'}` | `Campaign`, 200 |
| `PATCH /campaigns/:id/status` | `{active:boolean}` | Tương thích API cũ: chỉ PUBLISHED↔PAUSED; không publish DRAFT, không hồi sinh ARCHIVED |

Không có `DELETE`. Dùng ARCHIVED cho thao tác bỏ bản nháp/lưu trữ campaign.
Route grant PERSONAL và các API customer giữ nguyên hợp đồng trước đó.

Chuyển trạng thái hợp lệ:

- DRAFT → PUBLISHED: công bố lần đầu, lưu `publishedAt` theo giờ DB, khóa điều kiện vĩnh viễn.
- DRAFT → ARCHIVED: bỏ bản nháp nhưng giữ bản ghi/audit; `publishedAt` vẫn null.
- PUBLISHED → PAUSED hoặc ARCHIVED; PAUSED → PUBLISHED hoặc ARCHIVED.
- ARCHIVED là cuối cùng. Không có đường về DRAFT. Campaign đã công bố không sửa được dù chưa có claim.

Mọi thay đổi điều kiện/trạng thái tăng version đúng một lần. Redeem/refund chỉ đổi counter,
không tăng version và không đổi điều kiện. Chỉ một PERSONAL active được `autoCompensation=true`;
nhiều draft có thể bật cờ này, nhưng publish/resume phải qua unique guard như trước.

Client giữ cùng `commandId`, version và payload khi retry sau timeout. Server lưu fingerprint
và actor trong `voucher_audit`, cùng transaction với campaign; UUID command được chuẩn hóa lowercase.
Replay hợp lệ không ghi thêm audit/version và trả **campaign hiện tại**; có thể đã được pause/archive
bởi thao tác sau. Đổi payload/actor/campaign hoặc dùng version cũ với command mới trả 409.
Create nên luôn gửi `commandId`; bỏ trường này giữ cách chống trùng theo unique code cũ (409).
Hai create đồng thời cùng command có thể trả một 201 và một 409; retry cùng command sẽ đọc lại
campaign đã tạo, không tạo bản thứ hai. `commandId` là duy nhất cho mọi lệnh campaign.

Lỗi: 400 DTO/UUID sai hoặc field thừa; 401 thiếu JWT; 403 sai role; 404 không có campaign;
409 stale version, published edit, chuyển trạng thái sai, code/command trùng hoặc xung đột cấu hình.
Không gửi `redeemed`, `active`, `publishedAt`, `policy`, actor hay counter từ form sửa/công bố.
Sau 409 đọc lại campaign trước khi quyết định thao tác mới; không đổi command tự động sau timeout.

## Quota và lịch sử tiền

Owner yêu cầu **một GENERAL cụ thể** có `quota=100`, tối đa một lượt PAID/customer.
Không hardcode 100 cho các GENERAL khác; campaign có quota 1 do người vận hành đặt có thể được
tạo bản mới với quota 100. Campaign cũ đã công bố phải giữ quota, dù chưa ai lưu mã.

`redeemed` đếm lượt đã xác minh thanh toán thành công, không đếm người lưu mã.
101 người có thể claim campaign quota 100. Reservation còn hiệu lực hoặc đang chờ đối soát giữ
slot tạm (`redeemed + RESERVED <= quota`), không được coi là PAID. GENERAL có một claim/customer;
claim đã PAID chặn dùng lại. F3 hoàn đủ scope đã xác minh khôi phục quota và khả năng dùng lại
của khách đúng một lần. Không thay đổi hoàn tiền NET vào ví FixHome, subsidy reversal, F4,
invoice gross, commission hoặc quyền lợi thợ.

Pause/archive chặn claim/grant mới và APPLY mới. Không xóa claim, hủy payment đang chờ hoặc làm mất
reservation/ledger đã có; settlement hợp lệ vẫn được đối soát, refund F3 vẫn đi luồng đã xác minh.
Grant/apply replay đã ghi nhận giữ semantics cũ. Không coi archive là hoàn tiền hay thu hồi tiền.

## Migration và cổng release của owner

Migration duy nhất mới: `VoucherCampaignLifecycle1793116800000`.

1. Lead kiểm ledger thực tế: Core `1792994400000` và F4 `1792994400001` phải đã tồn tại;
   không chạy lại migration lịch sử. Task writer không đọc/ghi shared DB.
2. Rehearse trên PostgreSQL cô lập: backfill active→PUBLISHED, inactive→PAUSED;
   `published_at=created_at` là mốc bảo thủ cho dữ liệu cũ, không phải bằng chứng giờ công bố thật.
   Policy, quota, redeemed, claim, reservation và funding/refund rows không bị rewrite.
3. Migration khóa bảng campaign, thêm cột/default/CHECK, thay **chỉ** trigger campaign.
   Điều kiện chỉ sửa khi OLD và NEW đều DRAFT, chưa publish và không có claim/reservation history.
   Generic `voucher_guard_write`, trigger claim/reservation, F3 và deferred counter checks giữ nguyên.
   Không có rollback tự động; `down` từ chối để giữ publication provenance. Recovery bằng forward fix.
4. RLS campaign được bật; thu hồi quyền PUBLIC và API roles `anon/authenticated/service_role`.
   Không tự cấp quyền backend. **Release blocker:** owner xác minh DB login thực của backend,
   grants SELECT/INSERT/UPDATE, quyền đọc history/audit, RLS policies hoặc quyền owner/BYPASSRLS
   hiện hành. Kiểm đúng app role, không lấy kết quả postgres owner làm bằng chứng cho app.
   Nếu backend dùng một API role bị thu hồi quyền, phải có kế hoạch role/policy riêng được duyệt.
5. Chạy focused/full unit, lint/typecheck/build; CI và rehearsal full legacy migration chain.
   Fixture `test/app.e2e-spec.ts` hiện chỉ loại F4 khỏi schema riêng và còn giả định rollback
   toàn chain: không phù hợp migration lifecycle public/forward-only. Lead phải phối hợp sửa fixture
   đúng phạm vi, không bỏ gate hay thay historical migrations. Chưa kiểm chứng full E2E ở đây.
6. Owner duyệt DB apply riêng, sau đó restart Backend, `/health`, QA JWT Admin/customer và
   consumer Web Admin tương ứng. Nếu dùng Docker release image: `docker compose up -d --build`.
   Chưa được chạy bước này trên shared DEV trong task writer.

Suite mới `voucher-campaign.postgres.spec.ts` chỉ opt-in bằng:

```powershell
$env:VOUCHER_CAMPAIGN_ISOLATED_PG='1'
npx vitest run src/modules/vouchers/voucher-campaign.postgres.spec.ts
Remove-Item Env:VOUCHER_CAMPAIGN_ISOLATED_PG
```

Suite tự tạo/gỡ đúng container ngẫu nhiên PostgreSQL 16, bind loopback cổng ngẫu nhiên;
không đọc `.env`, không nhận URL/credential ngoài. Chạy Core+F4 thật trên legacy-table fixture tối thiểu,
rồi migration mới, kiểm preservation, guard, counter, replay JSONB, race edit/publish và claim/archive,
RLS bằng non-owner probe. Không thay thế full-app/provider/production-role E2E.

Máy writer: Docker daemon không chạy, không có `psql/postgres/initdb` hoặc listener local được phát hiện.
PostgreSQL SQL/trigger/RLS/concurrency: **NOT_RUN / NOT VERIFIED**. Unit và DDL contract không phải
bằng chứng chạy SQL. Web source cũ đã đối chiếu `active/setActive`, writer Web phải cập nhật contract;
Mobile và browser/runtime: **NOT VERIFIED**. Đây vẫn là cổng release đang chặn.

## Bằng chứng kiểm tra writer

| Lệnh / gate | Kết quả |
| --- | --- |
| `npx vitest run src/modules/vouchers test/context-doc.spec.ts` | PASS — 193 passed, 16 skipped (hai suite PostgreSQL) |
| `npm test` | PASS — 2337 passed, 18 skipped; 227 files passed, 2 skipped |
| `npx vitest run test/context-doc.spec.ts` sau cập nhật cuối | PASS — 2 passed |
| `npm run typecheck` | PASS — exit 0 |
| `npm run lint` | PASS — 0 errors, 2 warnings có sẵn ngoài phạm vi |
| `npm run build` | PASS — exit 0 |
| `git diff --check` và kiểm allowlist file | PASS — đúng phạm vi, một migration mới, không staged file |
| PostgreSQL isolated / SQL / trigger / RLS / concurrency | NOT_RUN / NOT VERIFIED — Docker daemon không chạy |
| `npm run test:e2e`, Docker Compose, `/health`, JWT/provider/Web/Mobile runtime | NOT VERIFIED — không có DB cô lập/runtime; không chạy lên shared DEV |

Đã quan sát RED cho draft mặc định, API edit/publish chưa tồn tại, replay tạo và UUID casing,
rồi GREEN. Các test nghiệp vụ cũ công bố draft trước claim/apply; giữ kiểm thử 100th/101st,
GENERAL một lượt PAID/customer và hồi phục quota F3. HTTP test dùng RolesGuard thật cùng
authentication double, không chứng minh JWT thật. DDL contract chỉ kiểm SQL phát ra.

Tự review BA/PM, kiến trúc, bảo mật và QA: giữ Nest controller→service→entity, DTO allowlist,
Admin-only, khóa/version, audit nguyên tử; không đổi Finance/payout/AI/T1 hoặc historical migrations.
Chưa có review độc lập, CI hoặc bằng chứng PostgreSQL thật trong lượt writer.

File thay đổi: `vouchers.controller.ts`, `vouchers.service.ts`, `voucher.types.ts`,
`entities/voucher.entity.ts`, `dto/voucher.dto.ts`, `dto/admin-voucher-campaign-response.dto.ts`,
`vouchers.service.spec.ts`, `vouchers.contract.spec.ts`, `vouchers.postgres.spec.ts`,
`voucher-campaign-migration.spec.ts`, `voucher-campaign.postgres.spec.ts`, tài liệu này,
`src/database/migrations/1793116800000-VoucherCampaignLifecycle.ts` và `docs/CONTEXT.md`.
Không stage/commit/push/merge/deploy; không sửa personal memory hoặc apply DB.
