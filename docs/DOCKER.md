# Chạy backend bằng Docker

Viết cho người chưa từng dùng Docker. Đọc hết mất chừng năm phút.

## Docker giải quyết vấn đề gì

Không có Docker thì mỗi người phải tự cài Node đúng phiên bản, tự cài thư viện,
và khi máy ai đó chạy được mà máy người khác không chạy được thì mất cả buổi để
tìm ra khác nhau chỗ nào.

Docker gói sẵn Node, thư viện và cách khởi động vào một khối gọi là **image**.
Ai chạy image đó cũng ra kết quả y hệt, trên Windows hay Mac hay máy chủ đều
vậy. Một khối đang chạy gọi là **container**.

Với đồ án này, cái lợi cụ thể: người mới vào nhóm chỉ cần cài Docker Desktop,
sao chép `.env`, gõ một dòng lệnh là backend chạy — không cần cài Node, không
cần `npm install`, không cần biết dự án dùng Node 20 hay Node 22.

## Ba lệnh cần nhớ

```
docker compose up -d      bật backend lên chạy nền
docker compose logs -f    xem log, bấm Ctrl+C để thoát khỏi màn hình log
docker compose down       tắt đi
```

Chạy ba lệnh này ngay trong thư mục repo backend. Sau khi bật, mở:

- `http://localhost:3000/health` — kiểm tra sống chết
- `http://localhost:3000/api/docs` — Swagger

## Sửa code có phải dựng lại không

**Không.** Container đang chạy ở chế độ theo dõi file. Sửa bất cứ thứ gì trong
`src/` là nó tự biên dịch lại và khởi động lại trong vài giây. Đo thật trên máy
Windows: sửa một dòng trong `health.service.ts` thì sau **6 giây** endpoint đã
trả giá trị mới, không phải gõ lệnh gì.

Cơ chế: `docker-compose.yml` gắn thư mục `src` trên máy thật vào trong
container, nên container nhìn thấy đúng file bạn đang sửa trong VS Code.

Chỉ bốn trường hợp sau mới phải dựng lại image:

| Khi nào | Lệnh |
|---|---|
| Thêm hoặc gỡ thư viện (`package.json` đổi) | `docker compose up -d --build` |
| Sửa `Dockerfile` | `docker compose up -d --build` |
| Sửa `tsconfig.json` hoặc `nest-cli.json` | `docker compose up -d --build` |
| Thêm biến mới vào `.env` | `docker compose up -d` (khởi động lại là đủ) |

## Swagger có cần container riêng không

Không. Swagger không phải một dịch vụ rời — nó do chính NestJS sinh ra lúc khởi
động, ở `src/setup-app.ts` dòng `SwaggerModule.setup('api/docs', app, document)`.
Nó chỉ là thêm một đường dẫn trong cùng tiến trình backend.

Container backend chạy là có luôn `http://localhost:3000/api/docs`, và
`http://localhost:3000/api/docs-json` nếu cần file OpenAPI thô để nạp vào
Postman.

## Database nằm ở đâu

**Supabase**, dùng chung với cả đội, đọc từ `.env` của bạn. Không có PostgreSQL
cục bộ trong Docker.

Trước kia file compose có dựng một Postgres riêng, nhưng nó tạo ra database
rỗng: `synchronize` tắt, không có bước chạy migration, và file khởi tạo chỉ bật
đúng một extension chứ không tạo bảng nào. Container lên là gặp database trắng.
Nay bỏ hẳn, trỏ thẳng Supabase cho giống hệt lúc chạy `npm run dev`.

Hệ quả cần nhớ: **đây là database chung**. Chạy migration hay xoá dữ liệu là ảnh
hưởng tới cả nhóm.

## Biến môi trường

`docker-compose.yml` nạp nguyên file `.env` bằng `env_file`. Nghĩa là thêm một
dòng vào `.env` thì container tự có biến đó, **không phải sửa compose**. Đây là
điểm khác quan trọng so với bản cũ — bản cũ liệt kê tay từng biến, nên cứ thêm
tính năng mới là quên truyền biến và tính năng chết trong Docker mà chạy ngoài
Docker thì vẫn tốt.

Hai biến bị ghi đè có chủ ý:

`PORT` luôn là 3000 bên trong container, bất kể `.env` ghi gì. Muốn đổi cổng
nhìn thấy từ máy thật thì sửa mục `ports` trong compose, ví dụ `'3001:3000'`.

`AI_SERVICE_URL` xét theo ba mức từ trên xuống: `AI_SERVICE_URL_DOCKER` nếu có,
không thì `AI_SERVICE_URL` trong `.env`, không nữa thì đoán là AI chạy trên máy
thật.

Cách dùng thường ngày chỉ có một bước. Sau mỗi lần thuê GPU mới:

```
npm run ai:point -- http://<ip>:<port>
```

Lệnh này kiểm GPU đã nạp xong model chưa, ghi địa chỉ vào `.env`, **tự nhận ra
backend đang chạy trong Docker và restart đúng container**, rồi chờ tới khi
backend báo đã nối được với AI mới dừng. Không phải nhớ thêm biến nào.

`AI_SERVICE_URL_DOCKER` chỉ cần tới trong đúng một trường hợp: AI Service chạy
ngay trên máy này. Khi đó `localhost` bên trong container là chính container chứ
không phải máy thật, nên phải đặt `AI_SERVICE_URL_DOCKER=http://host.docker.internal:8000`.
Trỏ sang địa chỉ công khai như GPU vast.ai thì bỏ trống, vì địa chỉ đó trong hay
ngoài Docker đều gọi được như nhau.

## Khi gặp lỗi

**Cổng 3000 đã bị chiếm** — có một backend khác đang chạy ngoài Docker. Tắt nó,
hoặc đổi `ports` trong compose.

**Container lên rồi tắt ngay** — xem `docker compose logs`. Hay gặp nhất là
`.env` thiếu `JWT_ACCESS_SECRET` hoặc `JWT_REFRESH_SECRET`, hai cái phải khác
nhau và mỗi cái ít nhất 32 ký tự.

**Sửa code mà không thấy gì xảy ra** — kiểm xem file bạn sửa có nằm trong `src/`
không. Chỉ `src/` và `test/` được gắn vào container.

**`docker` không tìm thấy** — Docker Desktop chưa bật. Mở nó lên, chờ biểu tượng
cá voi hết nhấp nháy.

## Quy tắc khi thêm tính năng mới

Đây là phần dễ quên nhất, và quên thì người khác lãnh hậu quả.

Thêm biến môi trường mới thì khai vào cả `.env.example` lẫn
`src/config/env.validation.ts` như bình thường. Compose đã nạp nguyên `.env` nên
không phải đụng tới nó.

Thêm thư viện mới thì sau khi `npm install`, nhớ báo cả nhóm chạy
`docker compose up -d --build`, vì thư viện nằm trong image chứ không nằm trong
thư mục gắn vào.

Thêm một dịch vụ ngoài mà backend phải gọi tới, và dịch vụ đó chạy trên máy thật
chứ không trong Docker, thì địa chỉ phải là `host.docker.internal` chứ không
phải `localhost`.

Đổi cổng backend lắng nghe thì sửa cả `ports` trong compose, `HEALTHCHECK` trong
compose, và `CORS_ORIGIN` trong `.env`.
