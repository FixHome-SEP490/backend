# Context repo backend — FixHome

> Cập nhật lần cuối: 2026-10-10 02:40 (UTC+7) · Người cập nhật (git): ToanAltF4 · Nhánh: feat/technician-auto-accept

## 0. Quy tắc cập nhật file này (bắt buộc)

File này là nguồn ngữ cảnh chung của repo cho cả dev lẫn AI agent. Đọc trước khi làm bất kỳ việc gì trong repo. Bốn repo `ai-service`, `backend`, `web`, `mobile` dùng chung một bộ quy tắc này; test `test/context-doc.spec.ts` kiểm tra định dạng mỗi lần chạy `npm test` và trong CI, sai quy tắc là CI đỏ.

### Khi nào phải cập nhật

Cập nhật trong cùng PR với thay đổi, không để PR sau. Bắt buộc khi PR làm thay đổi một trong các thứ sau:

1. Tính năng hoặc luồng nghiệp vụ người dùng thấy được.
2. API, sự kiện realtime, enum, schema gửi qua lại giữa các repo.
3. Biến môi trường, cổng, cách chạy, cổng kiểm thử (gate), CI, Docker.
4. Migration hoặc cấu trúc dữ liệu.
5. Quyết định của PO hoặc luật nghiệp vụ.
6. Việc đang dở, rủi ro mới phát hiện, hoặc một mục ở phần 8 đã xong.

Sửa lỗi không đổi hành vi bên ngoài thì không bắt buộc. Không chắc thì cập nhật.

### Cách cập nhật

1. Sửa nội dung mục 1 đến 8 cho đúng hiện trạng. Viết lại câu cũ cho đúng, không chồng thêm ghi chú lên câu đã sai.
2. Sửa dòng `> Cập nhật lần cuối:` ở đầu file theo đúng mẫu:
   `> Cập nhật lần cuối: YYYY-MM-DD HH:mm (UTC+7) · Người cập nhật (git): <git user.name> · Nhánh: <nhánh>`
   Giờ là giờ Việt Nam lúc sửa, lấy bằng lệnh dưới đây (chạy được trên Windows, macOS, Linux; đừng dùng `TZ=... date` vì Git Bash trên Windows lặng lẽ trả giờ UTC):
   `node -e "console.log(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()))"`
   hoặc `python -c "from datetime import datetime,timezone,timedelta;print(datetime.now(timezone(timedelta(hours=7))).strftime('%Y-%m-%d %H:%M'))"`.
   Tên lấy đúng chữ từ `git config user.name`. Nhánh lấy từ `git branch --show-current`.
3. Thêm một dòng lên đầu mục 9, cùng giờ và cùng tên với dòng đầu file:
   `- YYYY-MM-DD HH:mm (UTC+7) | <git user.name> | <nhánh hoặc PR #số> | <đã đổi gì trong context, một câu>`
4. Chạy `npx vitest run test/context-doc.spec.ts` trước khi commit.

### Viết gì và không viết gì

- Chỉ ghi điều đã kiểm chứng trong code, PR hoặc lần chạy thật. Điều chưa kiểm chứng ghi rõ `CHƯA KIỂM CHỨNG`.
- Repo là public. Tuyệt đối không ghi mật khẩu, khoá API, token, chuỗi kết nối có mật khẩu, địa chỉ IP máy chủ hay máy GPU, dữ liệu khách hàng. Biến môi trường chỉ ghi tên, không ghi giá trị. Test chặn các mẫu này.
- Không ghi ý kiến cá nhân, việc vặt, nhật ký làm việc hằng ngày, hay chỗ trống kiểu "để sau". Việc chưa làm ghi ở mục 8 với tên việc cụ thể.
- Không chép lại tài liệu khác; dẫn đường dẫn tới file đó.
- Tiếng Việt, câu ngắn. Tên kỹ thuật, tên file, tên API giữ nguyên tiếng Anh, đặt trong backtick.
- Không đổi tên, không xoá, không đổi thứ tự mười tiêu đề `##` số 0 đến 9; nội dung con dùng `###`. Không thêm tiêu đề `##` khác.
- Mục 9 mới nhất ở trên cùng, giữ tối đa 40 dòng; dòng cũ hơn thì xoá, lịch sử đã có trong git.
- File dài tối đa 700 dòng. Dài hơn thì rút gọn và dẫn link.

### Khi thay đổi chạm nhiều repo

Hợp đồng giữa các repo (mục 2 và mục 5) phải khớp nhau. Đổi API ở `backend` thì cập nhật context của `web`, `mobile` (và `ai-service` nếu liên quan) trong PR của từng repo đó, cùng ngày. Mục 2 của bốn repo giống nhau; sửa ở một repo thì sửa cả bốn.

### Với AI agent

Đọc file này trước, rồi `AGENTS.md`, rồi `docs/AI-TECHNICAL-GUIDE.md`. Không tạo file ngữ cảnh khác thay cho file này. Khi kết thúc việc, áp dụng đúng mục "Cách cập nhật" ở trên với tên git của máy đang chạy.

## 1. Repo này là gì trong FixHome

`backend` là NestJS 10 + TypeORM, chạy trên Supabase PostgreSQL. Đây là nguồn sự thật duy nhất về nghiệp vụ, phân quyền và dữ liệu của FixHome: marketplace nối khách hàng với kỹ thuật viên sửa đồ gia dụng, có AI gợi ý chẩn đoán sơ bộ. Bốn vai trò: `customer`, `technician`, `service_manager`, `admin`. `web` và `mobile` chỉ là client; `ai-service` chỉ được gọi từ đây.

API có tiền tố `/api/v1`, Swagger ở `/api/docs`, health ở `/health`. Cổng mặc định 3000.

## 2. Liên kết với các repo khác

FixHome gồm năm repo trong tổ chức GitHub `FixHome-SEP490`. Bốn repo mã nguồn có file context cùng cấu trúc:

| Repo | Vai trò | Nhánh tích hợp | Context |
| --- | --- | --- | --- |
| `backend` | NestJS, nguồn sự thật về nghiệp vụ, quyền và dữ liệu | `dev` | `https://github.com/FixHome-SEP490/backend/blob/dev/docs/CONTEXT.md` |
| `web` | Vue cho cả bốn vai trò; khu `/console` cho quản lý dịch vụ và admin | `dev` | `https://github.com/FixHome-SEP490/web/blob/dev/docs/CONTEXT.md` |
| `mobile` | Expo / React Native cho khách hàng và kỹ thuật viên | `dev` | `https://github.com/FixHome-SEP490/mobile/blob/dev/docs/CONTEXT.md` |
| `ai-service` | FastAPI, chẩn đoán từ ảnh và mô tả, chatbot tư vấn; chỉ mang tính gợi ý | `main` | `https://github.com/FixHome-SEP490/ai-service/blob/main/docs/CONTEXT.md` |
| `docs` | Tài liệu dự án | — | — |

Luồng gọi giữa các repo:

```text
web  ──┐  REST /api/v1 + Socket.IO (JWT)
       ├──────────────────────────────▶ backend ──HTTP──▶ ai-service (/api/v1/diagnosis/analyze, /api/v1/chat/ask)
mobile ┘                                   │
                                           ├──▶ Supabase PostgreSQL (TypeORM, migration); Supabase Storage (riêng ảnh KYC)
                                           ├──▶ Cloudinary (ảnh đại diện, ảnh booking, ảnh bằng chứng sửa chữa)
                                           ├──▶ VNPay (thanh toán hoá đơn, nạp ví) và payOS (chi tiền rút ví)
                                           ├──▶ MapTiler (gợi ý địa chỉ, đổi toạ độ ra địa chỉ)
                                           └──▶ Google OAuth (đăng nhập Google), SMTP (gửi OTP)
```

`web` hiển thị bản đồ bằng MapTiler; `mobile` dùng `react-native-maps`. Chat và gọi thoại dùng chung Socket.IO namespace `/chat` của `backend`; thông báo hiện chỉ đọc qua REST (chưa có đẩy realtime hay push).

Ba điều không đổi giữa các repo:

1. `web` và `mobile` không gọi thẳng `ai-service`, database hay cổng thanh toán; mọi thứ đi qua `backend`.
2. `backend` là nơi quyết định nghiệp vụ và phân quyền; kiểm tra phía client chỉ để trải nghiệm.
3. `ai-service` chỉ gợi ý. AI hỏng hoặc chậm không được chặn luồng đặt lịch; `backend` trả kết quả dự phòng.

Luật nghiệp vụ gốc nằm ở tài liệu dự án (bản chính thức của nhóm). Mâu thuẫn giữa code và tài liệu thì ghi vào mục 8 và hỏi PO, không tự quyết.

## 3. Trạng thái hiện tại

Đã chạy được trọn luồng: đăng ký có OTP email, đăng nhập (kể cả Google), hồ sơ và KYC kỹ thuật viên, danh mục dịch vụ và linh kiện, đặt lịch, mời tuần tự, nhận đơn, đi đến, check-in GPS, ảnh trước và sau, báo giá, chi phí phát sinh, yêu cầu linh kiện, hoá đơn, thanh toán VNPay hoặc tiền mặt, ví kỹ thuật viên (nạp, rút qua payOS), bảo hành, đánh giá, hỗ trợ và tranh chấp, huỷ đơn và vi phạm, chat và gọi thoại, AI chẩn đoán và chatbot qua `ai-service`.

### Luồng lõi

1. Khách tạo booking (`POST /bookings`), chọn 1 đến 2 kỹ thuật viên theo thứ tự (`POST /bookings/:id/shortlist`).
2. Lời mời gửi tuần tự: chỉ một lời mời `pending` tại một thời điểm, hạn theo `matching.invitation_ttl_minutes`.
3. Kỹ thuật viên nhận (`POST /invitations/:id/respond`) thì trong một transaction tạo `ServiceOrder` ở trạng thái `accepted` và `TechnicianAssignment`; sau đó gửi tin chào trong chat kèm tóm tắt AI. ServiceOrder không bao giờ được tạo lúc khách gửi booking.
4. `ServiceOrderStateMachine`: `accepted → en_route → under_repair → completed`; `cancelled` từ ba trạng thái đầu. Mọi đổi trạng thái phải đi qua state machine.
5. Hoá đơn snapshot tỉ lệ hoa hồng (`commission.rate_bps`, mặc định 10% trên tiền công, linh kiện không tính hoa hồng).
6. Online: VNPay (`POST invoices/:id/vnpay-url`, IPN `GET /api/v1/finance/vnpay/ipn`) khi `payment.mode` là `LIVE`. Tiền mặt: thợ khai, khách xác nhận; lệch thì mở support case cho quản lý xử lý.
7. Quyết toán (`SettlementService.trySettleOrder`): tiền mặt thì trừ phí nền tảng (hoa hồng + linh kiện FixHome + phí giao) vào ví thợ và đóng `PlatformDue`; online thì cộng thu nhập ròng vào ví.

### Thay đổi gần nhất (07/10/2026)

Các PR #67 đến #72 vào `dev` sửa 26 lỗi trong đợt rà soát backend: bảo mật tài khoản (Google redirect, mã bàn giao, OTP, đăng ký lại tài khoản bị khoá), luồng đơn và booking (tự huỷ quá hạn, đổi lịch, quản lý thay thợ, linh kiện của thợ cũ), tiền (snapshot hoa hồng, công thức PlatformDue khi quản lý xử lý tiền mặt, nạp ví, trừ ví admin, che số tài khoản), và kiểm dữ liệu (phân trang, id, lịch làm việc, giới hạn AI, giới hạn body 1 MB trừ hai route ảnh AI).

Nhánh `fix/order-timing-and-matching`: luật quá giờ hẹn BRX-063 (cảnh báo rồi tự huỷ sau 10 phút), tác vụ nền mỗi phút cho lời mời hết hạn và giờ xuất phát, ghép lại thợ có mở chat và báo thợ, đổi lịch khi đang ghép lại, mã lỗi `TECHNICIAN_NOT_ELIGIBLE`, mã đơn theo ngày giờ Việt Nam.

### Đặt lịch theo buổi, đơn vãng lai, GPS (PO 08/10/2026, nhánh `feat/booking-sessions`)

- Booking có `booking_mode` (scheduled | urgent), `slot` (morning 08-12 | afternoon 13-18 giờ VN) và `customer_note` (migration 028). Tạo booking gửi `mode` + `date` + `slot`, hoặc `mode: urgent` (khung = bây giờ tới `booking.urgent_window_minutes`, 120). Không gửi mode thì vẫn nhận khung giờ cũ (client cũ). Hàm: `bookings/booking-slots.ts`.
- `technicianEligibility`: đặt trước thì mỗi thợ một đơn mỗi buổi kể cả đơn đã xong (tối đa 2 buổi/ngày), ngày nghỉ trùng khung là chặn, phải có lịch tuần phủ buổi. Vãng lai thì thợ không được đang trong đơn nào, và nếu đang trong một buổi có đơn đặt trước chưa xong thì không nhận. Gốc toạ độ (`bookings/technician-location.ts`): vãng lai dùng GPS gửi trong `matching.gps_fresh_minutes` (15) nếu có, còn lại dùng địa chỉ thợ + khu vực đã chọn. Khu vực có hai bộ mã (quận cũ 1-3 chữ số, phường mới 5 chữ số), chỉ so trong cùng bộ, khác bộ thì bán kính quyết định.
- Đổi lịch (`PATCH /bookings/:id/schedule`) theo ngày + buổi; thợ của đơn không rảnh buổi mới thì trả TECHNICIAN_NOT_ELIGIBLE, không tự gỡ thợ nữa. `GET /bookings/:id/available-slots?days=14[&previous=1]` trả các buổi và thợ có rảnh không. Đặt lại thợ (`POST /bookings/:id/rebook`) chỉ từ booking đã huỷ hoặc đơn đã xong/huỷ, mời đúng thợ cũ nếu rảnh (`previousTechnicianInvited`).
- Xuất phát sớm nhất `order.depart_early_minutes` (60) trước giờ hẹn; chi tiết đơn có `departAvailableAt`, `customerNote`, `bookingMode`, `slot`. `PATCH /technicians/me/location` lưu vị trí lần cuối (bỏ qua sai số > 1 km). Bán kính 1-40 km.

### Các bước của thợ trong đơn (PO 08/10/2026, nhánh `feat/order-steps-photos`)

- Không còn bước "Bắt đầu sửa" riêng: `autoStartRepair` chuyển đơn sang UNDER_REPAIR ngay khi đủ điều kiện (check-in hợp lệ + ảnh sản phẩm, và với dịch vụ cần kiểm tra là báo giá đã duyệt). Gọi sau khi tải ảnh BEFORE và sau khi khách duyệt báo giá (`QuotationsService` lấy `ServiceOrdersService` qua ModuleRef). `POST /service-orders/:id/start-repair` vẫn giữ, gọi lại khi đã đang sửa thì trả đơn không đổi. Thông báo bắt đầu sửa dùng type REPAIR_STARTED.
- Ảnh bằng chứng đóng dấu "dd/mm/yyyy HH:mm · mã đơn" (giờ VN) vào ảnh gốc khi tải lên Cloudinary (`evidenceStampTransformation`).
- Case `technician_replacement` ("Cần thay đổi thợ", migration 029): thợ mở qua `POST /support/cases` khi đơn đang đi hoặc đang sửa và đã check-in hợp lệ. Trang xử lý của quản lý làm sau.

### Hoàn tất đơn

Đơn sang COMPLETED ở bước đến sau cùng trong ba bước: khách xác nhận công việc, tiền mặt được xác nhận (khách hoặc quản lý xử lý tranh chấp) và thanh toán online được xác minh. Cả ba đường gọi `applyOrderCompletionEffects` (`service-orders/order-completion-effects.ts`) trong cùng transaction: bắt đầu bảo hành cho dòng hoá đơn đủ điều kiện và ghi thông báo ORDER_COMPLETED cho khách và kỹ thuật viên (`notifications/order-completed-notice.ts`). Thông báo chỉ nhắc bảo hành khi có dòng bảo hành thật. Case tiền mặt chỉ chốt tiền khi quản lý xử lý với mã `CASH_SETTLEMENT_CONFIRMED_BY_MANAGER`.

### Tác vụ nền

Không dùng thư viện lịch; `src/common/background-job.ts` chạy mỗi `BACKGROUND_JOBS_INTERVAL_MS` (mặc định 60000, đặt 0 để tắt, không chạy khi test). Hai việc: `InvitationsService.sweepMatching` chuyển lời mời hết hạn sang kỹ thuật viên kế tiếp và báo khách khi hết người; `ServiceOrdersService.sweepDepartures` áp BRX-063. Chạy nhiều instance vẫn an toàn nhờ khoá dòng.

## 4. Kiến trúc và thư mục chính

Kiểu modular monolith: mỗi module `controller → service → TypeORM repository/entity`, DTO dùng `class-validator`, `ValidationPipe` toàn cục bật `whitelist` và `forbidNonWhitelisted`.

- `src/modules/`: 29 module. Quan trọng nhất: `auth`, `users`, `bookings` (booking, shortlist, lời mời, điều kiện nhận việc), `service-orders` (state machine, check-in, bằng chứng, hoá đơn, tiền mặt, huỷ, vi phạm, bảo hành), `quotations`, `part-requests`, `finance` (VNPay, Payment, PlatformDue), `wallet` (ví, nạp, rút, quyết toán), `technician-assignment`, `messaging` (chat, Socket.IO, gọi thoại), `ai-diagnosis` (proxy tới `ai-service`), `support-cases`, `notifications`, `system-config`, `rbac`, `audit-log`, `technician-verifications` (KYC), `media` (Cloudinary).
- `src/database/migrations/`: migration TypeORM; mới nhất `1790000000025-OtherServiceCatalog.ts`. `src/database/seeds/`: dữ liệu demo.
- `src/shared/`: enum, hằng số, DTO dùng chung (`PaginationDto`, `PageSizeQueryDto`), validator văn bản và tên người.
- `src/common/`: guard (JWT, Roles, Permission), filter lỗi, interceptor bọc response.
- `test/`: e2e chạy migration trên Postgres sạch.

Response thành công `{ success, statusCode, message, data, meta? }`; lỗi `{ success: false, statusCode, error: { code, message, details? }, timestamp, path }`.

## 5. Hợp đồng với repo khác

### Với `web` và `mobile`

- REST `/api/v1`, JWT Bearer; refresh qua `POST /auth/refresh`. Role trong token viết thường (`customer`, `technician`, `service_manager`, `admin`).
- Danh sách nhận `page` (1 đến 1.000.000) và `pageSize` hoặc `limit` (1 đến 100); `status` phải đúng enum. Sai trả 400.
- Thu nhập kỹ thuật viên (`/technicians/me/earnings`, dashboard) lấy tiền công và hoa hồng từ hoá đơn, chỉ tính đơn kỹ thuật viên giữ tới lúc hoàn tất; "thu nhập tháng" tính từ đầu tháng theo giờ Việt Nam.
- Chẩn đoán AI (`POST /ai/diagnoses`) bắt buộc `description` có chữ (BRX-064), sai trả 400.
- Lỗi nghiệp vụ trả `error.code`: kỹ thuật viên không đủ điều kiện nhận việc là `TECHNICIAN_NOT_ELIGIBLE` (409) kèm lý do; chỉ tài khoản bị khoá hay tạm ngưng mới là `WORK_SUSPENDED` (403).
- Thông báo mới: `ORDER_DEPARTURE_WARNING` (đến giờ hẹn mà kỹ thuật viên chưa xuất phát), `BOOKING_MATCHING_EXHAUSTED` (hết kỹ thuật viên trong danh sách).
- Socket.IO namespace `/chat`, xác thực bằng `auth: { token }`. Server phát `connect:ready`, `message:new`, `message:updated`, `message:deleted`, `conversation:updated`, `typing`, và các sự kiện gọi thoại `call:*`. Client gửi `conversation:join`, `conversation:leave`, `typing`, `call:*`.
- Đăng nhập Google cho mobile: `GET /auth/google/start?redirect=...` rồi `POST /auth/google/exchange` với mã dùng một lần; redirect phải nằm trong `GOOGLE_ALLOWED_APP_REDIRECTS`.
- Ảnh tải lên qua `POST /media/upload` (multipart); `avatarUrl` gửi lên phải là URL http(s) đã host.

### Với `ai-service`

- Gọi `${AI_SERVICE_URL}/api/v1/diagnosis/analyze`, `/api/v1/chat/ask`, `/api/v1/chat/acknowledgements`, timeout 30 giây.
- Route phía client: `POST /ai/diagnoses`, `POST /ai/chat/ask`, `GET /ai/chat/acknowledgements`, `GET /ai/health`, `GET /ai/diagnoses/:id`.
- Giới hạn khớp schema của `ai-service`: mô tả 2000 ký tự, câu hỏi 1000, `sessionId` và gợi ý 64, tối đa 3 ảnh. Hai route ảnh nhận body tới 40 MB.
- AI lỗi thì trả HTTP 200 với `aiAvailable: false` và câu trả lời dự phòng; không bao giờ chặn đặt lịch.

### Biến môi trường (chỉ tên, xem `.env.example`)

`PORT`, `CORS_ORIGIN`, `FRONTEND_URL`; `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_SSL`; `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`; `AI_SERVICE_URL`, `AI_SERVICE_URL_DOCKER`; `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_KYC_BUCKET`, `SUPABASE_KYC_SIGNED_URL_TTL_SECONDS`; `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`; `MAPTILER_API_KEY`; `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `GOOGLE_ALLOWED_APP_REDIRECTS`; `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_PAYMENT_URL`, `VNPAY_RETURN_URL`, `VNPAY_QUERYDR_URL`; `PAYOUT_PROVIDER`, `PAYOS_PAYOUT_CLIENT_ID`, `PAYOS_PAYOUT_API_KEY`, `PAYOS_PAYOUT_CHECKSUM_KEY`, `PAYOUT_RECONCILE_INTERVAL_MS`; `WEBRTC_ICE_URLS`; `BACKGROUND_JOBS_INTERVAL_MS`; `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM`; `MAIL_TRANSPORT=json` chỉ dùng cho test (CI e2e), cấm ở production.

## 6. Chạy, kiểm thử và cổng chất lượng

- Node theo `.nvmrc` (20.19.5). `npm ci`, chép `.env.example` thành `.env` và điền giá trị (hỏi trưởng nhóm, không lấy từ repo).
- Chạy: `npm run start:dev`. Docker: `docker compose up -d --build` (chỉ chạy backend, database là Supabase dùng chung), xem `docs/DOCKER.md`.
- Migration: `npm run migration:run`. Seed demo: `npm run seed:demo` (tạo admin, quản lý, kỹ thuật viên `tech1` đến `tech12`, khách `customer1` đến `customer7`, danh mục, 791 linh kiện).
- Gate trước mỗi commit: `npm run lint`, `npm run typecheck`, `TZ=UTC npm test`, `npm run build`; thêm `npm run test:e2e` khi đụng database. CI chạy thêm `npm audit --omit=dev --audit-level=high` và e2e trên Postgres sạch.
- Lưu ý: `npm run build` xoá `dist`, làm dev server đang chạy bằng `start:dev` dừng; kiểm build song song thì dùng `npx tsc -p tsconfig.build.json --outDir <thư mục tạm>`.
- Quy trình nhánh: tách nhánh từ `dev`, mở PR vào `dev`, CI xanh mới merge. Không ai merge vào `main` ngoài người giữ repo.

## 7. Quyết định đã chốt

- ServiceOrder chỉ tạo khi kỹ thuật viên nhận lời mời.
- Dữ liệu tài chính đã duyệt là bất biến; đổi thì tạo bản mới (báo giá, chi phí phát sinh, hoá đơn, tỉ lệ hoa hồng snapshot).
- AI chỉ gợi ý; AI hỏng không chặn đặt lịch.
- Khách chọn 1 đến 2 kỹ thuật viên cho một booking (PO xác nhận 07/10/2026).
- Ví kỹ thuật viên giữ tối thiểu 200.000 ₫ để được nhận việc (`wallet.minimum_balance`, PO xác nhận 07/10/2026).
- Giữ nguyên các cổng thanh toán VNPay và payOS; không chặn rút tiền thật (PO 07/10/2026).
- Không làm hoàn tiền; cuộc trò chuyện không tự đóng khi đơn hoàn tất hay bị huỷ (PO 07/10/2026).
- Linh kiện vượt báo giá đi qua chi phí phát sinh để khách duyệt; báo giá chỉ là ước tính (PO 07/10/2026).
- Duyệt KYC và quản lý danh mục chỉ admin làm; quản lý dịch vụ xử lý ngoại lệ (BRX-041, BRX-045).
- Huỷ đơn tự trừ điểm uy tín (thay BRX-032/033 theo PO 08-09/10/2026), không còn vi phạm do quản lý xác nhận (xem dưới).
- PlatformDue chỉ có ở đơn tiền mặt và bằng hoa hồng + linh kiện FixHome + phí giao (BRX-030, BRX-057); khi quyết toán được trừ thẳng vào ví kỹ thuật viên.
- BRX-063 (PO 07/10/2026): đến giờ hẹn (đầu khung giờ khách chọn, hoặc lúc nhận đơn nếu muộn hơn) mà kỹ thuật viên chưa bấm "Đang đến" thì báo cho kỹ thuật viên và khách; 10 phút sau vẫn chưa xuất phát thì tự huỷ đơn và booking. Hai mốc là cấu hình `order.departure_grace_minutes` (0) và `order.departure_cancel_minutes` (10).
- BRX-064 (PO 07/10/2026): chẩn đoán AI bắt buộc có mô tả, ảnh không bắt buộc.
- Khi tài liệu chính thức lệch với code thì code là chuẩn; tài liệu chính thức đã được sửa khớp ngày 07/10/2026 (shortlist 1 đến 2, có ví và mức tối thiểu, AI tự host, PlatformDue trừ qua ví).
- Không có xác thực giữa `backend` và `ai-service`; PO xác định đây không phải phạm vi cần làm.
- Không có dữ liệu hay luồng giả lập (PO 07/10/2026): không mã QR thử khi nhận linh kiện; nạp ví chỉ qua VNPay khi `payment.mode` là `LIVE` (mặc định `LIVE`); rút tiền chỉ qua payOS, chưa cấu hình thì từ chối trước khi trừ ví; chưa cấu hình SMTP thì báo lỗi chứ không giả vờ đã gửi email; kỹ thuật viên chưa có đánh giá thì API trả `rating: null`.
- Bỏ xác nhận vi phạm thủ công (PO 09/10/2026): huỷ đơn tự trừ điểm uy tín, `confirmViolation` trong `POST cancellations/:id/review` bị từ chối (422). `waiveStrike` chỉ còn cho vi phạm ghi từ trước. Danh sách `GET /cancellations` có `reputationDelta` (số điểm lần huỷ đó đã trừ, null nếu không trừ). Ngoại lệ không trừ duy nhất phía thợ: đã check-in và báo "Cần thay đổi thợ", đơn chuyển SM, SM huỷ thì không ai bị trừ.
- Trạng thái nhận việc (PO 08/10/2026): `GET /technicians/me/availability` trả `state` = `receiving` (trong lịch tuần và nút bật), `off_hours` (ngoài lịch, tự bật lại lúc `nextStartAt`), `paused` (thợ tự tắt bằng nút tay), `time_off` (đang nghỉ tới `until`), `no_schedule`; giờ Việt Nam (`technicians/availability-now.ts`). Việc ghép đơn vẫn như cũ: cần nút bật và lịch tuần phủ khung giờ của đơn, nên lịch tuần tự bật/tắt nhận việc, nút tay chỉ để tạm nghỉ.
- Admin tra cứu thợ (PO 08/10/2026): `GET /admin/technicians?search=&verificationStatus=&page=&pageSize=` (chỉ admin, quyền `user:read_all`) tìm theo tên (không phân biệt dấu tiếng Việt, `translate` trong SQL), email, SĐT (0912... và +84 912... đều khớp), CCCD (`citizen_id_number`, theo phần đầu), ID tài khoản hoặc ID hồ sơ (từ 6 ký tự đầu); không tìm theo địa chỉ. `GET /admin/technicians/:id` trả đủ: tài khoản (gồm CCCD, ngày sinh), hồ sơ thợ, kỹ năng, khu vực, lịch tuần, nghỉ sắp tới, số dư ví, số đơn theo trạng thái, 10 đơn gần nhất, KYC gần nhất, 10 thay đổi điểm uy tín.
- Đổi thợ sau khi thợ báo "Cần thay đổi thợ" (PO 08/10/2026): `POST /service-orders/:id/replace-technician {technicianId, reason}` (SM/admin, quyền `assignment:override`). Chỉ khi đơn EN_ROUTE/UNDER_REPAIR và có case `technician_replacement` đang mở; từ chối khi khách đã duyệt báo giá hoặc đã có hoá đơn (khi đó SM huỷ đơn, không ai bị trừ điểm). Thợ cũ rời đơn không qua huỷ nên không bị trừ điểm; báo giá chờ duyệt chuyển SUPERSEDED; đơn về ACCEPTED để thợ mới xuất phát và tự check-in (check-in gắn theo thợ); case đóng `worker_reassigned`; khách, thợ cũ, thợ mới nhận thông báo `TECHNICIAN_REPLACED`. Thợ rút đơn chỉ bị coi là đã tới nơi khi có check-in của chính mình.
- Tổng quan quản lý (PO 09/10/2026): `GET /dashboard/operations` có thêm `openReplacementCases` (case `technician_replacement` đang open/in_review) và `noDepartureCancellations7d` (đơn hệ thống tự huỷ trong 7 ngày vì thợ không xuất phát; lý do là hằng `NO_DEPARTURE_CANCEL_REASON` ở `service-orders/no-departure.ts`).
- Bỏ bước khách nghiệm thu (PO 09/10/2026): thợ `request-completion` (đủ ảnh sau sửa, tạo hoá đơn) là nghiệm thu; đơn sang COMPLETED khi hoá đơn đã thanh toán (VNPay, ví khách, tiền mặt đã xác nhận, SM chốt tiền mặt) và không bị giữ vì khiếu nại. `finalizeIfSatisfied` và hai chỗ `markInvoicePaidOnline` / `applyConfirmedCash` không còn đòi `CustomerServiceConfirmation`, chỉ đòi `completionRequestedAt`. `POST confirm-completion` giữ cho client cũ (mobile), không bắt buộc. Thông báo `COMPLETION_REQUESTED` nay nói "thanh toán hoá đơn để hoàn tất đơn".
- Tìm thợ nhanh hơn (10/10/2026): `GET /bookings/:id/technician-candidates` kiểm `technicianEligibility` theo lô 8 thợ cùng lúc (`first-eligible.ts`), giữ thứ tự xếp hạng, dừng khi đủ 20. Đo trên DB chung: 10,6-11 s xuống 2,5-3,3 s, cùng danh sách, cùng thứ tự. Trước đó web hay báo "Không thể tải danh sách kỹ thuật viên phù hợp" khi chờ quá lâu.
- Sửa lỗi tải ảnh trên 1 MB (10/10/2026): `formBodySizeGuard` (setup-app.ts) chặn mọi body khai báo > 1 MB, kể cả multipart, nên mọi ảnh thật (ảnh booking, ảnh đơn của thợ, media) bị 413 và web báo "Không thể tải ảnh ... lên" (lỗi từ #72). Nay multipart ở `FILE_UPLOAD_ROUTES` (`/media/booking-photo-upload`, `/media/upload`, `/service-orders/:id/evidence`) được tới `MAX_MULTIPART_BODY_BYTES` 11 MB; giới hạn 10 MB/file vẫn do multer từng route; JSON và multipart ở route khác vẫn 1 MB.
- Ví khách (PO 08/10/2026, module `customer-wallet`, migration 031, bảng `customer_wallets` + `customer_wallet_transactions` tách khỏi ví thợ, giao dịch chỉ thêm, khoá chống trùng theo `idempotency_key`): `GET /customer/wallet` (số dư + lịch sử), `POST /customer/wallet/top-up {amount}` tạo link VNPay (dùng chung purpose `wallet_top_up`, phân biệt theo vai trò người nạp; IPN cộng vào ví khách; trang trả về `/app/wallet`), `POST /invoices/:id/pay-with-wallet` trả trọn hoá đơn từ ví trong một giao dịch rồi đi chung đường với VNPay (`markInvoicePaidOnline`: hoa hồng thu ngay, không PlatformDue, thợ được `ONLINE_EARNING`), Payment `provider='wallet'`. Hoàn tiền: giải quyết khiếu nại với `resolutionCode: refund_to_wallet` + `amount` (chỉ khi RESOLVED, chỉ case `parts_dispute` / `warranty_dispute` tức linh kiện hỏng hoặc bảo hành (PO 09/10/2026), đơn đã thanh toán, tổng hoàn không vượt hoá đơn, khoá dòng hoá đơn), khách nhận thông báo `WALLET_REFUND`. FixHome chịu khoản hoàn (`liableParty` mặc định `platform`); muốn thu lại từ thợ thì admin điều chỉnh ví thợ. Không có rút tiền. Admin (PO 09/10/2026, migration 032 thêm loại `adjustment_credit` / `adjustment_debit`): `GET /admin/customer-wallets` (tìm theo tên không dấu, email, số điện thoại; `withBalance=true`; `meta.totalBalance`), `GET /admin/customer-wallets/:userId` (khách + lịch sử), `POST /admin/customer-wallets/:userId/adjustments` `{type: CREDIT|DEBIT, amount, reason ≥ 10}`: không trừ quá số dư, ghi audit `CUSTOMER_WALLET_ADJUSTMENT`, báo khách `WALLET_ADJUSTED`. Chỉ ADMIN. Danh sách thanh toán cho admin (PO 09/10/2026): `GET /admin/payments` (chỉ ADMIN, quyền `invoice:read_related`, chỉ đọc): mọi lần thanh toán (hoá đơn qua VNPay hoặc ví, công nợ thợ, nạp ví) kèm người trả, mã đơn, mã tham chiếu cổng; lọc `status`, `purpose`, `provider` (`none` = không qua cổng), `from`/`to` theo ngày giờ VN; `search` theo mã đơn, email/tên người trả, mã tham chiếu, đầu mã thanh toán; `meta.summary` có tổng tiền đã xác nhận và số lần theo trạng thái. Danh sách đánh giá cho admin (PO 09/10/2026): `GET /admin/reviews` (chỉ ADMIN, chỉ đọc; module reviews): ai đánh giá ai, đơn nào, số sao, nhận xét; lọc `rating` (đúng số sao), `maxRating` (từ số sao này trở xuống), `from`/`to` ngày VN; `search` tên không dấu/email thợ hoặc khách, mã đơn, nội dung; `meta.summary` có điểm trung bình và phân bố sao. Chưa có ẩn/kiểm duyệt đánh giá (tài liệu nguồn chưa có luật, cột `is_moderated` vẫn chưa dùng).
- Khách đổi lịch đơn thợ đã nhận (`PATCH /bookings/:id/schedule` với `mode: scheduled, date, slot`, đơn còn ACCEPTED/EN_ROUTE): chỉ được buổi thợ đó còn trống, lưu xong thợ nhận thông báo `BOOKING_RESCHEDULED` "Đơn #... chuyển sang Buổi ..., dd/mm/yyyy".
- Xem trước lời mời của thợ (`GET /invitations/my`, `GET /bookings/:id` khi là người được mời) có thêm `bookingMode` và `slot` để thợ biết buổi trước khi nhận; ghi chú của khách (`customerNote`) chỉ hiện sau khi nhận đơn vì có thể chứa thông tin riêng.
- Điểm uy tín (PO 08/10/2026, module `reputation`, migration 030): khách và thợ bắt đầu 100 điểm (`users.reputation_points`). Mỗi lần khách huỷ đơn đã có thợ nhận, thợ rút khỏi đơn trước khi đến, hoặc đơn bị tự huỷ vì thợ không xuất phát, bị trừ `reputation.violation_points` (10), ghi vào `reputation_events` cùng lần huỷ. Quản lý huỷ thì không ai bị trừ. Thợ đã báo "Cần thay đổi thợ" (case `technician_replacement`) trên đơn đó thì không bị trừ. Điểm sau khi trừ quyết định mức khoá: dưới 70 khoá 72 giờ, dưới 40 khoá 7 ngày, từ 20 trở xuống khoá 30 ngày, 0 khoá tài khoản (`status = locked`); khách bị khoá đặt lịch (`booking_suspended_until`), thợ bị khoá nhận việc (`work_suspended_until`), lần sau không bao giờ rút ngắn lần khoá đang chạy. Cứ `reputation.reset_months` (2) tháng điểm về lại 100 (job nền), tài khoản đã khoá giữ nguyên. SM/admin: `GET /reputation?role&search&page&pageSize` (điểm thấp trước), `GET /reputation/:userId/events`, `POST /reputation/:userId/adjust {delta, reason}` (lý do bắt buộc, chỉ khách và thợ, nâng lên từ 70 thì gỡ khoá). `/users/me` và `/me` trả `reputationPoints`, `reputationPeriodStart`. Khách và thợ xem điểm của mình ở `GET /reputation/me` (điểm, ngày làm mới `resetsAt`, `suspendedUntil` nếu đang bị khoá, `locked`, 20 thay đổi gần nhất).
- Đơn đã huỷ thì không thanh toán hoá đơn được nữa; các lần thanh toán đang chờ bị đóng với mã `ORDER_CANCELLED`. Không hoàn tiền.

## 8. Việc đang dở và rủi ro đã biết

- Lỗi của đợt rà soát 07/10/2026 đã sửa hết phần backend, trừ phần bảo hành (dev khác phụ trách).
- Migration `1790000000027-HonestTechnicianRatings` đưa điểm của kỹ thuật viên chưa có đánh giá về 0 và mặc định cột là 0; phải chạy `npm run migration:run` trên database dùng chung sau khi merge.
- `web` và `mobile` cần xử lý `rating: null` (chưa có đánh giá), nút "xác nhận vi phạm" ở trang huỷ đơn, và báo "chưa mở" khi nạp hay rút tiền bị từ chối.
- `matching.max_shortlist` chỉ để hiển thị (đặt 2); API shortlist cố định 1 đến 2. Các khoá `ai.timeout_ms`, `ai.rate_limit_per_user_per_hour`, `ai.provider`, `matching.mode` được seed nhưng code không đọc.
- Thông báo chỉ có REST, chưa có đẩy realtime hay push.
- `POST invoices/:id/pay` ở chế độ `LIVE` dùng cổng xác minh chưa cấu hình (từ chối an toàn); thanh toán online thật đi qua VNPay URL và IPN.
- `README.md`, `CONTRIBUTING.md`, `docs/AI-TECHNICAL-GUIDE.md` còn vài đoạn cũ (Postgres chạy local, nhánh `develop`, vòng đời có `PENDING_CONFIRMATION`); khi lệch, file này và code là chuẩn.

## 9. Nhật ký cập nhật context

- 2026-10-10 02:40 (UTC+7) | ToanAltF4 | feat/technician-auto-accept | Thợ bật/tắt tự nhận việc (technician_profiles.auto_accept_invitations, migration 034, PATCH /technicians/me/profile autoAcceptInvitations): lời mời tới thợ đang bật được nhận thay qua respond(ACCEPT) sau khi commit (tạo shortlist, chuyển lời mời kế tiếp, vòng quét mỗi phút), nhận không được thì để thợ tự trả lời; thợ nhận thông báo INVITATION_AUTO_ACCEPTED, lịch sử đơn và audit ghi là tự nhận
- 2026-10-10 02:09 (UTC+7) | ToanAltF4 | fix/booking-photo-seed-ids | Ảnh đặt lịch riêng tư không còn trả 404 cho tài khoản seed: kiểm id theo dạng uuid của PostgreSQL (shared/utils/db-uuid.ts) thay cho isUUID() vốn từ chối id không theo phiên bản RFC 4122
- 2026-10-10 01:20 (UTC+7) | ToanAltF4 | feat/technician-default-warranty | Thợ đặt bảo hành công mặc định (PUT /technicians/me/warranty-default, áp cho tất cả dịch vụ tuỳ chọn); đơn chụp bảo hành công lúc giao thợ (service_orders.labor_warranty_days, migration 033); báo giá/chi phí phát sinh để trống ngày bảo hành công thì lấy mặc định, vượt warranty.max_days bị từ chối; hoá đơn giá cố định ghi bảo hành công theo đơn thay vì 0; thẻ ứng viên không còn hiện 30 ngày khi thợ chưa đặt; warranty.default_days và warranty.max_days chuyển ACTIVE
- 2026-10-09 23:59 (UTC+7) | ToanAltF4 | fix/multipart-upload-size | Sửa lỗi tải ảnh trên 1 MB bị 413
- 2026-10-09 23:46 (UTC+7) | ToanAltF4 | perf/parallel-candidate-eligibility | Tìm thợ nhanh hơn: kiểm điều kiện theo lô song song
- 2026-10-09 23:28 (UTC+7) | ToanAltF4 | feat/no-customer-acceptance | Bỏ bước khách nghiệm thu: thợ hoàn thành có ảnh, thanh toán xong là hoàn tất
- 2026-10-09 21:42 (UTC+7) | ToanAltF4 | feat/admin-reviews | Admin xem danh sách đánh giá
- 2026-10-09 21:28 (UTC+7) | ToanAltF4 | feat/admin-payments | Admin xem danh sách thanh toán
- 2026-10-09 21:13 (UTC+7) | ToanAltF4 | feat/sm-dashboard-replacements | Tổng quan quản lý: số yêu cầu đổi thợ đang chờ, đơn tự huỷ vì không xuất phát
- 2026-10-09 20:40 (UTC+7) | ToanAltF4 | feat/admin-customer-wallets | Admin xem và điều chỉnh ví khách (migration 032)
- 2026-10-09 20:31 (UTC+7) | ToanAltF4 | feat/refund-parts-only | Hoàn tiền vào ví chỉ cho khiếu nại linh kiện, bảo hành; FixHome chịu
- 2026-10-09 19:51 (UTC+7) | ToanAltF4 | feat/availability-from-schedule | Trạng thái nhận việc theo lịch tuần, nút tay chỉ tạm nghỉ
- 2026-10-09 19:23 (UTC+7) | ToanAltF4 | feat/admin-technician-search | Admin tra cứu thợ theo tên, email, SĐT, CCCD, ID và xem đủ thông tin
- 2026-10-09 18:50 (UTC+7) | ToanAltF4 | feat/replace-after-report | SM đổi thợ sau khi thợ báo cần thay; thợ rút chỉ tính check-in của chính mình
- 2026-10-09 18:12 (UTC+7) | ToanAltF4 | feat/customer-wallet | Ví khách: nạp VNPay, trả hoá đơn bằng ví, hoàn tiền vào ví qua khiếu nại; migration 031
- 2026-10-09 17:13 (UTC+7) | ToanAltF4 | feat/reschedule-notify | Đổi lịch đơn đã có thợ thì báo cho thợ; e2e đổi lịch theo buổi
- 2026-10-09 16:57 (UTC+7) | ToanAltF4 | feat/customer-booking-sessions | Xem trước lời mời có buổi hẹn (bookingMode, slot), không lộ ghi chú của khách
- 2026-10-09 15:11 (UTC+7) | ToanAltF4 | feat/auto-reputation-only | Bỏ xác nhận vi phạm thủ công, huỷ đơn tự trừ điểm; danh sách huỷ đơn có số điểm đã trừ
- 2026-10-09 10:06 (UTC+7) | ToanAltF4 | feat/reputation-points | Điểm uy tín khách và thợ: trừ khi huỷ đơn đã có thợ, khoá theo mức điểm, reset 2 tháng, SM xem và điều chỉnh; vi phạm cũ không còn tự khoá; migration 030
- 2026-10-08 23:52 (UTC+7) | ToanAltF4 | feat/order-steps-photos | Thợ: tự chuyển đang sửa khi đủ điều kiện, ảnh đóng dấu giờ và mã đơn, case cần thay đổi thợ sau check-in.
- 2026-10-08 23:32 (UTC+7) | ToanAltF4 | feat/booking-sessions | Đặt lịch theo buổi sáng/chiều, đơn vãng lai theo GPS, đổi lịch chặn buổi thợ bận, buổi còn trống, đặt lại thợ cũ, xuất phát sớm 1 giờ, vị trí thợ.
- 2026-10-08 21:53 (UTC+7) | ToanAltF4 | fix/strike-role | Xác nhận vi phạm ghi role vào cancellation_strikes (cột bắt buộc), trước đây insert lỗi trên DB thật.
- 2026-10-07 21:27 (UTC+7) | ToanAltF4 | fix/fixed-price-and-waive-reason | Dịch vụ giá cố định bắt buộc có giá > 0; miễn vi phạm khi xét huỷ đơn bắt buộc có lý do, kiểm trước khi ghi.
- 2026-10-07 21:17 (UTC+7) | ToanAltF4 | fix/time-off-and-review-guards | Chặn khai báo ngày nghỉ đã qua; đánh giá trùng trả CONFLICT với câu tiếng Việt.
- 2026-10-07 21:03 (UTC+7) | ToanAltF4 | fix/order-completed-notices | Hoàn tất đơn qua tiền mặt hoặc VNPay giờ cũng gửi thông báo ORDER_COMPLETED; gom bảo hành và thông báo về applyOrderCompletionEffects.
- 2026-10-07 19:15 (UTC+7) | ToanAltF4 | fix/remaining-bugs-and-fake-data | Ghi các lỗi còn lại đã sửa, quy định không dữ liệu giả, vi phạm do quản lý xác nhận, thu nhập theo hoá đơn và migration 027
- 2026-10-07 18:53 (UTC+7) | ToanAltF4 | fix/order-timing-and-matching | Thêm luật quá giờ hẹn BRX-063, tác vụ nền, mã lỗi mới, quyết định PO ngày 07/10 và cập nhật việc đang dở
- 2026-10-07 14:43 (UTC+7) | ToanAltF4 | docs/repo-context | Tạo file context theo bộ quy tắc chung của bốn repo, ghi hiện trạng sau đợt sửa lỗi ngày 07/10/2026
