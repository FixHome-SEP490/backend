# FixHome — Quy chuẩn UI/UX và ngôn ngữ chung cho Web & Mobile

> Version: 1.1.0 · Ngày cập nhật: 30/09/2026 · Phạm vi: tổ chức `FixHome-SEP490`.
> Trạng thái áp dụng vào sản phẩm: **một phần**. Mục 17 ghi các quyết định PO ngày 30/09/2026 đã triển khai trên web khu vực khách hàng và kỹ thuật viên; các mục khác vẫn là quy chuẩn đích.
> AI phải đọc toàn bộ file này trước khi sửa UI, nội dung hiển thị, điều hướng, theme, component hoặc dữ liệu ảnh hưởng đến cách hiển thị của FixHome.

## 1. Chỉ thị bắt buộc đối với AI

1. Đọc `AGENTS.md`, `docs/AI-TECHNICAL-GUIDE.md` của repository đang làm và file này trước khi triển khai. Giữ nguyên các quy tắc kỹ thuật hiện có.
2. Xác định actor, màn hình, dữ liệu, trạng thái nghiệp vụ và màn tương ứng trên nền tảng còn lại. Đọc code thực tế, không chỉ dựa vào README hoặc tài liệu cũ.
3. Một khái niệm nghiệp vụ phải có cùng thuật ngữ, nhãn trạng thái, ý nghĩa màu và quy tắc định dạng trên web/mobile. Bố cục được thích nghi với thiết bị và quyền của actor.
4. Dùng token, component, formatter và từ điển chung; tìm implementation hiện có trước khi tạo mới. Không tự chọn thêm màu, font, tên gọi hoặc kiểu nút cho từng màn.
5. Giữ nguyên API, enum, quyền, validation, state machine, cơ chế chống gửi trùng và ranh giới giữa các repository. Sửa giao diện không phải lý do để đổi nghiệp vụ.
6. Với thay đổi dùng chung, kiểm tra cả web và mobile. Nếu chỉ truy cập được một repo, hoàn thành phần được phép, ghi rõ phần còn lại và không kết luận đã đồng bộ toàn hệ thống.
7. Phân biệt dữ kiện đã đọc trong code với quy chuẩn đề xuất, tính năng đã triển khai với tính năng dự kiến, và kiểm tra đã chạy với kiểm tra chưa chạy.
8. Chỉ sửa phạm vi được giao. File này không yêu cầu tự động làm lại toàn bộ sản phẩm mỗi khi nhận một task nhỏ.
9. Trước khi bàn giao, thực hiện checklist ở mục 14 và báo cáo theo mục 15. Chưa kiểm tra thì ghi `NOT VERIFIED`.
10. Khi yêu cầu rõ ràng mới nhất của người dùng thay đổi một quyết định thiết kế, cập nhật quy chuẩn cùng các nơi bị ảnh hưởng; không âm thầm tạo ngoại lệ riêng cho một màn.

### 1.1 Cách gắn để AI đọc ở các lần sau

Cả năm repo hiện đã có `AGENTS.md`. **Không ghi đè các file đó bằng tài liệu này.**

- Đặt bản chuẩn tại root của `FixHome-SEP490/docs`, tên `FIXHOME-DESIGN-SYSTEM.md`.
- Đặt bản sao cùng phiên bản, cùng nội dung tại root của `web`, `mobile`, `backend`, `ai-service`. Bản sao giúp agent đọc được khi chỉ mở một repo hoặc không có mạng.
- Thêm đoạn sau vào phần “Mandatory pre-implementation gate” của `AGENTS.md` trong từng repo:

```markdown
Before every task, read FIXHOME-DESIGN-SYSTEM.md completely together with
docs/AI-TECHNICAL-GUIDE.md. Follow its cross-platform language, terminology,
design-token, typography, title, component, status, and verification rules.
For UI or user-facing output changes, inspect the matching Web/Mobile behavior.
Preserve this repository's architecture, API contracts, permissions, and tests.
If cross-repository verification is unavailable, explicitly report NOT VERIFIED.
```

Đoạn trên chỉ là nội dung cần chèn vào `AGENTS.md`, không thay thế các mục còn lại. `mobile/CLAUDE.md` hiện chứa `@AGENTS.md`, nên phải giữ liên kết đó. Với công cụ AI không tự nạp `AGENTS.md`, cấu hình rule đầu phiên hoặc đính kèm file và yêu cầu đọc; một file Markdown không thể bảo đảm mọi công cụ AI tự động tuân thủ.

Khi phát hành quy chuẩn mới, cập nhật bản chuẩn và các bản sao trong cùng đợt công việc; ghi version và các PR liên quan. So sánh nội dung hoặc SHA-256 để phát hiện lệch, không suy đoán rằng bản có tên giống nhau là cùng phiên bản. Nếu chưa đồng bộ được, ghi rõ repo còn thiếu; không âm thầm sửa độc lập một bản sao.

### 1.2 Thứ tự giải quyết mâu thuẫn

- Yêu cầu hiện tại của người dùng và các chỉ dẫn hệ thống/công cụ có thẩm quyền vẫn được ưu tiên theo môi trường thực thi.
- Quy tắc kiến trúc, bảo mật và phạm vi riêng của repo tiếp tục áp dụng.
- Đối với UI/UX: khi nhóm đưa tài liệu này vào sử dụng, các quyết định tại đây thay thế phần thiết kế cũ mâu thuẫn được liệt kê trong mục 3; không thay thế toàn bộ tài liệu nghiệp vụ.
- Đối với dữ liệu và hành vi đang chạy: đối chiếu DTO, enum, service/state machine và test của backend tại commit đang làm. Tài liệu cũ không phải căn cứ để gửi một enum không tồn tại.
- Code hiện tại là bằng chứng về implementation, không tự động là nghiệp vụ đúng. Nếu code trái yêu cầu được duyệt, ghi nhận xung đột và xử lý trong task phù hợp; không hợp thức hóa bằng cách sửa nhãn.

## 2. Bối cảnh hệ thống và phạm vi đã khảo sát

### 2.1 Các repository

| Repo | Vai trò thực tế liên quan đến đồng bộ |
| --- | --- |
| `web` | Vue 3, TypeScript, Vite, Tailwind 4, Pinia; có public, auth, Customer, Technician và Console/Admin/Service Manager |
| `mobile` | React Native, Expo, TypeScript, React Navigation, Zustand; có auth, Customer, Technician và chat |
| `backend` | NestJS, TypeORM; sở hữu API, quyền, enum, validation và nghiệp vụ có thẩm quyền |
| `ai-service` | FastAPI, schema chẩn đoán/hội thoại và nội dung tiếng Việt liên quan AI |
| `docs` | Yêu cầu, kiến trúc, tài liệu API, workflow và quy chuẩn liên repository |

Không giả định web chỉ có trang quản trị: router hiện có cả luồng khách hàng và kỹ thuật viên. Không tự bổ sung trang quản trị vào mobile chỉ để hai nền tảng có cùng số màn.

### 2.2 Snapshot đối chiếu

Nhánh khảo sát: `main`, ngày 27/09/2026. Đã kiểm kê toàn bộ cây tệp của 5 repo và quét nguồn dạng văn bản; đọc sâu phần theme, component, router/navigation, các luồng giao diện liên quan, hợp đồng trạng thái backend và tài liệu thiết kế. Đây là rà soát phục vụ quy chuẩn UI/UX, không phải chứng nhận audit từng dòng code, bảo mật toàn hệ thống hay kiểm thử ứng dụng đang chạy. Không rà soát lịch sử tất cả commit/nhánh và không đánh giá trực quan toàn bộ asset nhị phân.

| Repo | Commit khảo sát | Tệp được quản lý bởi Git |
| --- | --- | ---: |
| `web` | `4e0a0312ee225e676dfea3a32bffd11cd2a35bef` | 211 |
| `mobile` | `bbf3cf1069f56cc8695a95a8f03cdbf3189962bd` | 184 |
| `backend` | `07da5515953076be12ea3fed74546acff55691ee` | 535 |
| `ai-service` | `9db1d946e2fca3cbf9117c629904c0395aff09b4` | 311 |
| `docs` | `dfdc9005df3ab0489a460526bd2374174b310241` | 49 |

Các số liệu và đường dẫn trong phần hiện trạng gắn với snapshot trên. Mỗi lần triển khai phải đọc lại nguồn bị ảnh hưởng tại commit mới, không coi snapshot này là bất biến.

## 3. Những điểm không đồng bộ đã xác định

| Vấn đề | Bằng chứng tại snapshot | Hướng chuẩn hóa |
| --- | --- | --- |
| Hai màu primary khác nhau | Web `src/assets/theme.css` và `FhButton.vue`: CTA `#2563EB`; mobile `src/constants/theme.ts`: `primary: brand[500]`, tức `#3B82F6` | Primary action thống nhất `#2563EB` |
| Nền và viền khác nhau dù tên palette giống | Web `ink-50=#F7F5F2`, `ink-200=#E2DDD6`; mobile lần lượt `#FFFFFF`, `#F2F2F2` | Tách token nền trang, surface và border; thống nhất light theme |
| Font chưa được đồng bộ | Web khai báo Be Vietnam Pro/Space Grotesk và nạp trong `index.html`; mobile chưa có cấu hình nạp hai font tương ứng trong nguồn khảo sát | Nạp font thật trên mobile, dùng typography token và kiểm tra dấu tiếng Việt |
| Nhãn và màu trạng thái thay đổi theo màn | Web `FhStatusPill.vue`: cancelled xám, “Đã huỷ”; mobile `CustomerBookingsScreen.tsx`: đỏ, “Đã hủy”; `TechnicianOrderDetailScreen.tsx` dùng “Hoàn tất” màu xám | Từ điển theo domain + status, cùng label/tone trên cả hai nền tảng |
| Tài liệu màu cũ mâu thuẫn code | `docs/FIXHOME-AI-BUILD-BRIEF-v2.0.md`, P7 là warm orange; theme hiện tại hai client dùng blue | Quy chuẩn này chọn blue dựa trên implementation hiện hành; cập nhật P7 khi áp dụng |
| Lifecycle cũ không khớp backend | Một số guide ghi `PENDING_CONFIRMATION` cho Service Order; enum hiện tại chỉ có `accepted/en_route/under_repair/completed/cancelled` | Không đưa trạng thái legacy vào đơn sửa chữa mới |
| Tiêu đề trộn tiếng Anh và viết hoa tùy ý | `web/src/router/index.ts`: “Workspace thực thi công việc”, “Board đơn sửa chữa”, “Công nợ Platform” | Tiếng Việt thống nhất, sentence case |
| Tiếng Việt lỗi mã hóa và thông báo kỹ thuật lộ ra UI | `mobile/src/screens/customer/customer-payment.ts` có chuỗi lỗi encoding; `CustomerOrderDetailScreen.tsx` có “Không gửi POST lại” | UTF-8; thông báo theo nhu cầu người dùng, giữ nguyên logic chống gửi trùng |
| Màu hard-code phân tán | `CustomerHomeScreen.tsx`, `CustomerBookingsScreen.tsx`, `TechnicianOrderDetailScreen.tsx` và một số trang web | Gom về token, ưu tiên component chung |
| Một component nhận status chung cho nhiều domain | `FhStatusPill.vue` gộp `ACTIVE/APPROVED/PAID`, `APPROVED` có thể nhận mặc định “Hoạt động” | Bắt buộc truyền domain hoặc metadata trạng thái đúng nghiệp vụ |

Các vấn đề trên chưa được sửa trong source bởi việc lập tài liệu này. Không dùng chúng để kết luận tính năng hỏng ở runtime khi chưa kiểm tra trực tiếp.

## 4. Ngôn ngữ và nội dung giao diện

### 4.1 Quy tắc chung

- Ngôn ngữ mặc định của mọi bề mặt do FixHome kiểm soát: **tiếng Việt có dấu**, locale `vi-VN`.
- Code identifier, route name, API key và enum giữ nguyên theo hợp đồng kỹ thuật. Chỉ dịch lớp hiển thị.
- Dùng giọng rõ ràng, lịch sự, trực tiếp; xưng “bạn” khi cần. Không trộn “quý khách”, “anh/chị”, “bro” hoặc cách nói đùa tùy màn.
- Dùng thống nhất “hủy”, “khóa”, “hóa đơn”, “kỹ thuật viên”. Tiêu đề viết hoa chữ đầu, giữ đúng tên riêng: “Chi tiết công việc”, không “Chi Tiết Công Việc”.
- Nhãn ngắn không đặt dấu chấm cuối. Câu hướng dẫn/lỗi hoàn chỉnh có dấu câu. Dùng ký tự `…` cho tiến trình thay vì nhiều kiểu dấu chấm.
- Tên thương hiệu giữ `FixHome`, không dùng `Fixhome`, `FIX HOME`. Tên nhà cung cấp như Google, VNPay giữ cách viết chính thức đang được tích hợp.
- Không dịch nội dung người dùng tự nhập, tên riêng, mã đơn hoặc mã linh kiện. Dialog thuộc hệ điều hành/provider có thể theo locale của hệ thống; ghi nhận đây là giới hạn nền tảng.
- Không hứa “đã thanh toán”, “đã nhận đơn”, “đã xác minh” nếu dữ liệu backend chưa xác nhận.
- Không hiển thị `POST`, `GET`, `Backend`, stack trace, SQL, JWT hoặc tên biến cho khách hàng/kỹ thuật viên. Mã lỗi hỗ trợ chỉ hiện có chủ đích, không thay thông báo dễ hiểu.

### 4.2 Từ điển thuật ngữ chuẩn

| Khái niệm kỹ thuật | Hiển thị chuẩn | Lưu ý |
| --- | --- | --- |
| Customer | Khách hàng | Không đổi thành “người mua” |
| Technician | Kỹ thuật viên | Không luân phiên “thợ”, “thợ sửa”, “KTV” trong UI mới |
| Service Manager | Quản lý dịch vụ | Không để “SM” làm nhãn chính |
| Admin | Quản trị viên | Giữ `admin` trong contract |
| Booking | Yêu cầu đặt lịch | Thực thể yêu cầu/tìm người thực hiện |
| Service Order | Đơn sửa chữa | Thực thể thực thi; không gộp status với Booking |
| Quotation | Báo giá | Khác chi phí AI ước tính |
| Additional cost | Chi phí phát sinh | Luôn thể hiện tình trạng phê duyệt |
| Labor | Tiền công | Không trộn “nhân công” và “tiền công” ở cùng nhóm chi phí |
| Parts/materials | Linh kiện và vật tư | Có thể dùng “Linh kiện” ở màn chỉ chứa linh kiện |
| Invoice | Hóa đơn | Hiển thị đúng loại chứng từ thực tế; không tự thêm cam kết hóa đơn thuế |
| Payment | Thanh toán | Phân biệt trạng thái thanh toán và trạng thái đơn |
| Cash settlement | Đối soát tiền mặt | Nội dung cho khách có thể diễn đạt “Xác nhận tiền mặt” |
| Warranty / claim | Bảo hành / Yêu cầu bảo hành | Hai khái niệm riêng |
| Review | Đánh giá | Không dùng “review” làm nhãn |
| Evidence BEFORE / AFTER | Ảnh trước sửa chữa / Ảnh sau sửa chữa | API giữ enum cũ |
| KYC | Xác minh danh tính | Có thể thêm “(KYC)” trong mô tả nghiệp vụ nội bộ |
| Dashboard | Tổng quan | Có thể là “Tổng quan vận hành” trong Console |
| Notification / messages | Thông báo / Tin nhắn | Không dùng thay nhau |
| AI diagnosis | Chẩn đoán sơ bộ bằng AI | Luôn giữ ý nghĩa tham khảo |
| Estimated cost | Chi phí ước tính | Không đổi thành “Giá cuối cùng” |
| Platform dues | Công nợ nền tảng | Dùng trong Console, không làm thay đổi cách tính |

Ngoại lệ rút gọn chỉ được dùng có chủ đích trong không gian hẹp và phải có key riêng, ví dụ tab “Công việc” nhưng tiêu đề chi tiết “Chi tiết công việc”. Không tạo từ đồng nghĩa khác cho cùng badge trạng thái.

### 4.3 Nút, thông báo và lỗi

| Ngữ cảnh | Nội dung chuẩn |
| --- | --- |
| Hành động chung | “Lưu thay đổi”, “Tiếp tục”, “Quay lại”, “Đóng”, “Thử lại” |
| Đặt lịch | “Đặt lịch sửa chữa”, “Gửi yêu cầu đặt lịch” |
| Báo giá | “Duyệt báo giá”, “Từ chối báo giá”, “Xem báo giá” |
| Phát sinh | “Duyệt chi phí phát sinh”, “Từ chối chi phí phát sinh” |
| Loading | “Đang tải…”, “Đang lưu…”, “Đang gửi yêu cầu…” |
| Lỗi tải danh sách | “Không thể tải danh sách đơn sửa chữa. Vui lòng thử lại.” |
| Không có quyền | “Bạn không có quyền xem nội dung này.” |
| Hết phiên | “Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.” |
| Mất mạng | “Không có kết nối mạng. Kiểm tra kết nối rồi thử lại.” |
| Kết quả thanh toán chưa rõ | “Chưa xác nhận được kết quả thanh toán. Vui lòng kiểm tra trạng thái trước khi thanh toán lại.” |
| Nút đối chiếu thanh toán | “Kiểm tra thanh toán” |
| Kết quả thao tác chưa rõ | “Chưa xác nhận được kết quả. Vui lòng kiểm tra trạng thái trước khi thực hiện lại.” |
| Danh sách đơn trống | “Bạn chưa có đơn sửa chữa.” + giải thích ngắn + “Đặt lịch sửa chữa” nếu có quyền |

Dialog hủy đơn có tiêu đề cụ thể “Hủy đơn sửa chữa?”, mô tả hậu quả lấy từ quy tắc thật; nút an toàn “Giữ lại đơn”, nút phá hủy “Hủy đơn sửa chữa”. Không dùng hai nút mơ hồ “Có/Không”; không tự bịa phí hủy, số lần vi phạm hoặc chính sách hoàn tiền.

### 4.4 Tổ chức nội dung dùng chung

Đích triển khai: một tập key ổn định dùng ở cả web/mobile, ví dụ `common.action.save`, `screen.customer.orders.title`, `status.serviceOrder.accepted`, `error.payment.unknownResult`. Nội dung UI được tham chiếu qua key hoặc hàm typed, không rải các bản sao trong từng màn.

Hiện chưa xác nhận có hệ thống i18n chung trong hai client. Tận dụng cấu trúc hiện có; có thể bắt đầu bằng dictionary TypeScript/JSON nhỏ, không bắt buộc cài một framework đa ngôn ngữ chỉ để gom chuỗi tiếng Việt. Nếu bổ sung ngôn ngữ sau này, key phải đầy đủ và fallback được kiểm tra.

Lưu UTF-8, chuẩn hóa Unicode NFC ở nguồn nội dung khi phù hợp. Kiểm tra chuỗi có dấu như “Đặt lịch sửa chữa”, “Nguyễn”, “Đặng”, “Quận”, “Phường”. Không sửa encoding bằng replace toàn repository thiếu kiểm soát; xem từng chuỗi lỗi và cập nhật test liên quan.

## 5. Màu sắc và design token

### 5.1 Quyết định thiết kế

Quy chuẩn đích sử dụng **xanh dương + nền trung tính ấm**, kế thừa theme hiện tại của web. Màu primary là `#2563EB`. Đây là lựa chọn để chuẩn hóa theo yêu cầu, không phải khẳng định mọi màn đã tuân thủ hoặc đã có quyết định thương hiệu trước đó.

Không đưa palette cam từ P7 cũ trở lại trong task UI mới. Cam/vàng/tím chỉ xuất hiện qua semantic hoặc palette minh họa được đặt tên và dùng nhất quán. Không dùng màu thương hiệu thay cho mọi trạng thái.

### 5.2 Primitive palette dùng chung

| Bậc | `brand` | Bậc | `ink` |
| --- | --- | --- | --- |
| 50 | `#EFF6FF` | 25 | `#FCFBF9` |
| 100 | `#DBEAFE` | 50 | `#F7F5F2` |
| 200 | `#BFDBFE` | 100 | `#EFECE7` |
| 300 | `#93C5FD` | 200 | `#E2DDD6` |
| 400 | `#60A5FA` | 300 | `#CBC4BA` |
| 500 | `#3B82F6` | 400 | `#A69D91` |
| 600 | `#2563EB` | 500 | `#7D7468` |
| 700 | `#1D4ED8` | 600 | `#5C554C` |
| 800 | `#1E40AF` | 700 | `#443E37` |
| 900 | `#1E3A8A` | 800 | `#2B2722` |
| — | — | 900 | `#1A1714` |

### 5.3 Semantic token cho light theme

Tên dưới đây là contract đích; adapter CSS/TypeScript có thể giữ tên cũ để tương thích nhưng phải map cùng ý nghĩa và giá trị.

| Token | Giá trị | Công dụng |
| --- | --- | --- |
| `action.primary` | `#2563EB` | Nút chính, thành phần được chọn |
| `action.primaryHover` | `#1D4ED8` | Hover trên web |
| `action.primaryPressed` | `#1E40AF` | Active/pressed |
| `action.onPrimary` | `#FFFFFF` | Chữ/icon trên primary |
| `background.page` | `#F7F5F2` | Nền trang |
| `background.surface` | `#FFFFFF` | Card, dialog, input |
| `background.subtle` | `#FCFBF9` | Vùng nền phụ |
| `text.primary` | `#1A1714` | Nội dung chính |
| `text.secondary` | `#5C554C` | Mô tả, metadata cần đọc |
| `text.placeholder` | `#5C554C` | Placeholder, không thay label |
| `border.default` | `#E2DDD6` | Viền card/phân chia trang trí |
| `border.control` | `#7D7468` | Biên control khi cần để nhận biết vùng tương tác |
| `focus.ring` | `#2563EB` | Focus nhìn thấy rõ trên light theme |
| `selection.background` | `#DBEAFE` | Vùng chọn nhẹ |

| Tone | Nền nhạt | Màu chính/icon | Màu chữ badge |
| --- | --- | --- | --- |
| `success` | `#E7F6F0` | `#0E8A5F` | `#08734F` |
| `warning` | `#FEF6E0` | `#B07D00` | `#805B00` |
| `danger` | `#FEECEB` | `#D92D20` | `#B42318` |
| `info` | `#EAF1FE` | `#175CD3` | `#175CD3` |
| `violet` | `#F3EEFE` | `#6335D9` | `#6335D9` |
| `repair` | `#EFF6FF` | `#2563EB` | `#1D4ED8` |
| `neutral` | `#EFECE7` | `#7D7468` | `#5C554C` |

Các màu chữ success/warning/danger đậm hơn là bổ sung đích để cải thiện khả năng đọc, chưa phải token có sẵn trong theme. Tính toán trên màu đặc: chữ trắng trên `#2563EB` khoảng 5,17:1; trên `#3B82F6` khoảng 3,68:1. Vì vậy không dùng `brand-500` làm nền nút chứa chữ trắng nhỏ. Cặp màu thực tế có opacity, gradient, ảnh nền hoặc dark mode phải đo riêng.

Không dùng `ink-400` cho thông tin bắt buộc đọc. Viền trang trí nhạt không thay thế dấu hiệu tương tác/focus. Trạng thái disabled cần thuộc tính tương tác thật; giảm opacity không tự vô hiệu hóa nút.

### 5.4 Cách triển khai token

- Web tiếp tục dùng `src/assets/theme.css`, Tailwind 4 và CSS variables. Dùng semantic class/variant trong component thay vì thêm literal HEX trong page.
- Mobile tiếp tục dùng `src/constants/theme.ts` và `useAppTheme()`. Bổ sung token thiếu, không hard-code màu light trong màn có dark theme.
- HEX chỉ nằm ở nguồn token/adapter, asset có màu cố định hoặc ngoại lệ được ghi nhận. Không đổi màu ảnh, bản đồ, logo provider theo regex.
- Màu danh mục dịch vụ nếu cần có palette riêng, ví dụ `category.electrical`; không tự tạo màu khác nhau cho cùng danh mục trên web và mobile.
- Nguồn canonical machine-readable dùng để sinh token là **hướng triển khai**, chưa có sẵn. Nếu bổ sung, đặt tại repo `docs` trong phạm vi task; sinh adapter riêng cho Vue và React Native, không import CSS/Vue trực tiếp vào mobile và không cần đổi sang monorepo.

### 5.5 Dark mode

Mobile hiện có light/dark qua `src/store/ui.store.ts`; web chưa có một dark theme tương đương trong nguồn theme đã khảo sát. Không tuyên bố đã đồng bộ dark mode và không xóa lựa chọn dark hiện tại để đạt đồng bộ hình thức.

Light theme là baseline đối chiếu ban đầu. Mọi màn mobile được sửa phải kiểm tra cả light và dark; màu semantic theo vai trò, chữ/viền/focus phải đủ tương phản. Bộ token dark hoàn chỉnh là một hạng mục cần đặc tả riêng trước khi mở rộng sang web. Không dùng phép đảo màu tự động làm tiêu chuẩn nghiệm thu, không dùng bảng HEX light ở trên trực tiếp cho dark.

## 6. Kiểu chữ, cỡ chữ và phân cấp nội dung

Font nội dung: **Be Vietnam Pro**. Font số tiền/metric: **Space Grotesk**, với tabular numerals khi được hỗ trợ. Nội dung tiếng Việt không chuyển sang font số. Nếu glyph tiền tệ không có, dùng fallback đã kiểm tra.

| Token | Web size/line-height | Mobile size/line-height | Weight | Mục đích |
| --- | --- | --- | ---: | --- |
| `display` | 36/44 | 32/40 | 700 | Hero hoặc số liệu nổi bật |
| `pageTitle` | 28/36 | 24/32 | 700 | Tiêu đề trang/màn |
| `sectionTitle` | 20/28 | 20/28 | 600 | Tiêu đề section |
| `body` | 16/24 | 16/24 | 400 | Nội dung chính, input |
| `bodySmall` | 14/20 | 14/20 | 400 | Nội dung phụ, bảng |
| `label` | 14/20 | 14/20 | 500 | Nhãn field, control |
| `caption` | 12/16 | 12/16 | 500 | Timestamp, badge ngắn |
| `overline` | 11/16 | 12/16 | 600 | Nhãn nhóm phụ, dùng hạn chế |

Đây là thang đích thích nghi theo nền tảng: web dùng CSS px ở kích thước gốc, mobile dùng đơn vị layout/font của React Native và hỗ trợ font scaling; không nhân thủ công với mật độ pixel màn hình. Giá trị mobile khác web trong bảng là khác biệt có chủ đích, không phải sai lệch.

- Một màn có một tiêu đề chính rõ ràng; section bên dưới dùng đúng cấp. Web dùng heading semantic; không chọn h1/h2 chỉ vì kích thước mặc định.
- Chữ nút thường 14/20, weight 600; CTA lớn dùng 16/24. Không đặt mỗi màn một cỡ chữ riêng.
- Mobile cần nạp font thật, đúng weight và tên family bằng cơ chế tương thích Expo SDK hiện tại. Ghi nhận trạng thái tải/lỗi font; không chỉ khai báo `fontFamily` rồi cho rằng đã hoạt động.
- Giữ asset/license font hợp lệ và kiểm tra font trong build offline. Không nâng Expo hoặc eject chỉ để thêm font.
- Cho phép xuống dòng với tiêu đề dài. Không giảm chữ toàn màn để tránh tràn. Không cắt số tiền, trạng thái, CTA hoặc cảnh báo quan trọng.
- Không khóa `allowFontScaling=false` trên toàn app. Kiểm tra chữ lớn, line-height, dấu trên/dưới và chiều cao control để không cắt tiếng Việt.

## 7. Tiêu đề và điều hướng tương ứng

Cùng actor + cùng mục đích thì dùng cùng tiêu đề. Các route dưới đây là bằng chứng hiện có; bảng không yêu cầu tạo màn mới nếu chưa có chức năng tương ứng. Việc đổi title không được tự đổi route name, URL, deep link hoặc navigation param.

| Mục đích | Web hiện có | Mobile hiện có | Tiêu đề chuẩn |
| --- | --- | --- | --- |
| Đăng nhập | `pages/auth/LoginPage.vue` | `screens/auth/LoginScreen.tsx` | Đăng nhập |
| Đăng ký | `pages/auth/RegisterPage.vue` | `screens/auth/RegisterScreen.tsx` | Đăng ký tài khoản |
| Quên mật khẩu | `pages/auth/ForgotPasswordPage.vue` | `screens/auth/ForgotPasswordScreen.tsx` | Quên mật khẩu |
| Trang chủ khách hàng | `pages/customer/CustomerDashboard.vue` | `screens/customer/CustomerHomeScreen.tsx` | Trang chủ |
| Tạo Booking | `pages/customer/NewBookingWizardPage.vue` | `screens/customer/CustomerBookingCreateScreen.tsx` | Đặt lịch sửa chữa |
| Danh sách đơn của khách | `pages/customer/CustomerOrdersPage.vue` | `screens/customer/CustomerBookingsScreen.tsx` | Đơn của tôi |
| Chi tiết đơn của khách | `pages/customer/CustomerOrderDetailPage.vue` | `screens/customer/CustomerOrderDetailScreen.tsx` | Chi tiết đơn sửa chữa |
| Thông báo khách hàng | `pages/customer/CustomerNotificationsPage.vue` | `screens/customer/CustomerNotificationsScreen.tsx` | Thông báo |
| Hồ sơ khách hàng | `pages/customer/CustomerProfilePage.vue` | `screens/customer/CustomerProfileScreen.tsx` | Hồ sơ cá nhân |
| Danh sách công việc | `pages/technician/TechnicianJobsPage.vue` | `screens/technician/TechnicianJobsScreen.tsx` | Công việc |
| Chi tiết công việc | `pages/technician/TechnicianJobDetailPage.vue` | `screens/technician/TechnicianOrderDetailScreen.tsx` | Chi tiết công việc |
| Lời mời nhận việc | `pages/technician/TechnicianInvitationsPage.vue` | `screens/technician/TechnicianInvitationsScreen.tsx` | Lời mời nhận việc |
| Xác minh danh tính | `pages/technician/TechnicianKycPage.vue` | `screens/technician/TechnicianKycScreen.tsx` | Xác minh danh tính |
| Tin nhắn | `pages/chat/MessagesPage.vue` | `screens/chat/ChatListScreen.tsx` | Tin nhắn |

Đường dẫn trong bảng tính từ `src/` của repo tương ứng. Một màn web có thể tương ứng nhiều bước mobile; so sánh theo chức năng và dữ liệu, không ép quan hệ 1:1 về số lượng file.

Quy tắc bổ sung:

- Customer tab giữ “Trang chủ”, “Đơn của tôi”, “Thông báo”, “Tài khoản”; màn bên trong tab tài khoản có thể là “Hồ sơ cá nhân”.
- Technician tab giữ “Trang chủ”, “Công việc”, “Thông báo”, “Hồ sơ”; màn hồ sơ có thể là “Hồ sơ kỹ thuật viên”.
- Web route metadata, heading, breadcrumb và browser title dùng cùng nguồn title; browser title theo mẫu `{Tiêu đề} | FixHome`.
- `Board đơn sửa chữa` đổi thành “Bảng đơn sửa chữa”; `Workspace thực thi công việc` đổi thành “Chi tiết công việc”; `Công nợ Platform` đổi thành “Công nợ nền tảng”.
- Mã đơn là metadata bên cạnh/dưới tiêu đề hoặc thuộc title template được định nghĩa chung; không khiến một nền tảng chỉ hiện mã còn nền tảng kia không cho biết đang xem thực thể gì.

## 8. Trạng thái nghiệp vụ và màu hiển thị

### 8.1 Quy tắc mapping

Mapping phải dựa trên **domain + status**, ví dụ `serviceOrder.accepted`, `booking.matched`, `quotation.approved`. Không dùng một switch toàn hệ thống chỉ nhìn chuỗi `approved` rồi gán nhãn chung.

Giá trị backend trong các bảng là lowercase đúng với enum nguồn tại snapshot. Client có thể normalize uppercase trong view model hiện có, nhưng adapter phải rõ ràng và request phải theo đúng contract của endpoint. Không đổi API chỉ để khớp cách viết trên badge.

### 8.2 Service Order

| Enum backend | Nhãn tiếng Việt | Tone |
| --- | --- | --- |
| `accepted` | Đã nhận đơn | `violet` |
| `en_route` | Đang di chuyển | `warning` |
| `under_repair` | Đang sửa chữa | `repair` |
| `completed` | Hoàn thành | `success` |
| `cancelled` | Đã hủy | `neutral` |

`PENDING_CONFIRMATION` không phải một giá trị của `ServiceOrderStatus` hiện tại. Nếu gặp dữ liệu legacy, xử lý bằng adapter có kiểm chứng và thông báo phù hợp; không thêm ngược enum này vào backend hoặc timeline chuẩn. Trạng thái có tên tương tự ở domain đối soát tiền mặt không phải là trạng thái đơn sửa chữa.

### 8.3 Booking

| Enum backend | Nhãn tiếng Việt | Tone |
| --- | --- | --- |
| `submitted` | Đã gửi yêu cầu | `info` |
| `matching` | Đang tìm kỹ thuật viên | `warning` |
| `matched` | Đã ghép kỹ thuật viên | `success` |
| `cancelled` | Đã hủy | `neutral` |
| `closed` | Vòng tìm kỹ thuật viên đã kết thúc | `neutral` |

`closed` không có nghĩa sửa chữa hoàn thành. `matched` không có nghĩa đã thanh toán. Danh sách “Đơn của tôi” có thể chứa cả Booking và Service Order nhưng phải phân biệt loại bản ghi và điều hướng đúng thực thể.

### 8.4 Báo giá, chi phí phát sinh và thanh toán

| Domain | Enum backend | Nhãn | Tone |
| --- | --- | --- | --- |
| Quotation | `draft` | Bản nháp | `neutral` |
| Quotation | `sent` | Chờ duyệt báo giá | `warning` |
| Quotation | `approved` | Đã duyệt báo giá | `success` |
| Quotation | `rejected` | Đã từ chối báo giá | `danger` |
| Quotation | `superseded` | Đã được thay thế | `neutral` |
| Additional cost | `pending_approval` | Chờ duyệt chi phí phát sinh | `warning` |
| Additional cost | `approved` | Đã duyệt chi phí phát sinh | `success` |
| Additional cost | `rejected` | Đã từ chối chi phí phát sinh | `danger` |
| Additional cost | `expired` | Đã hết hạn | `neutral` |
| Additional cost | `cancelled` | Đã hủy | `neutral` |
| Payment | `unpaid` | Chưa thanh toán | `warning` |
| Payment | `paid` | Đã thanh toán | `success` |
| Payment | `refunded` | Đã hoàn tiền | `info` |
| Payment attempt | `pending` | Đang chờ xác minh thanh toán | `warning` |
| Payment attempt | `verified` | Đã xác minh giao dịch | `success` |
| Payment attempt | `failed` | Giao dịch thất bại | `danger` |
| Payment attempt | `refunded` | Đã hoàn tiền giao dịch | `info` |
| Payment attempt | `cancelled` | Đã hủy giao dịch | `neutral` |

Các domain khác như verification, support case, warranty, invitation cần bảng riêng lấy từ enum thật. Không tự động áp một bảng hiện có chỉ vì trùng tên trạng thái.

- Badge, filter, Kanban, timeline và thông báo của cùng domain/status dùng cùng label/tone. Nhãn bước tiếp theo có thể diễn đạt khác, ví dụ “Bắt đầu di chuyển”, nhưng không thay badge “Đã nhận đơn”.
- Trạng thái không biết: hiển thị “Trạng thái chưa xác định”, tone neutral; vô hiệu hành động phụ thuộc trạng thái khi chưa đủ dữ liệu; ghi mã kỹ thuật an toàn phục vụ chẩn đoán. Không hiển thị raw enum và không mặc định thành công.
- Badge hủy thông thường dùng neutral. Nút xác nhận hành động phá hủy vẫn dùng danger; badge và nút có vai trò khác nhau.
- Không chỉ dựa vào màu: luôn có nhãn chữ, icon bổ trợ khi cần.
- Bảng này chỉ quy định hiển thị. Quyền và điều kiện thực hiện vẫn do backend kiểm soát, bao gồm điều kiện bổ sung ngoài state machine.

## 9. Khoảng cách, bố cục, bo góc và icon

| Hạng mục | Quy chuẩn đích |
| --- | --- |
| Spacing | `4, 8, 12, 16, 24, 32, 48, 64` |
| Padding ngang trang | Desktop 24; mobile và web hẹp 16 |
| Gap field trong form | 16; nhóm nội dung 24 |
| Card padding | 16 ở mobile; 24 ở desktop khi phù hợp |
| Radius nhỏ | 8: input, badge, icon tile |
| Radius vừa | 14: card, nút chính |
| Radius lớn | 20: dialog, sheet, panel |
| Pill/circle | Chỉ cho avatar/chip có vai trò rõ ràng; không thay mọi radius bằng 999 |
| Icon chức năng | Lucide outline; cỡ 16/20/24; stroke 1,75 làm baseline |
| Touch target | Ít nhất 44×44 điểm logic; mobile ưu tiên 48×48 khi không làm chật layout |
| Desktop content | Console tối đa 1440; form tối đa 720; nội dung đọc tối đa 760 |
| Motion | 120 ms cho phản hồi nhanh, 200 ms cho menu/tab, 320 ms cho dialog/sheet |

Giá trị 1–2 cho border/focus, 6 cho status dot hoặc điều chỉnh quang học nhỏ không bị ép thành spacing 4. Ngoại lệ phải theo component, không lặp tùy ý từng màn.

- Dùng các mức elevation hiện có ở web: e1 card, e2 floating/hover, e3 dialog; mobile dùng shadow/elevation tương đương về phân cấp, không sao chép chuỗi CSS vào React Native.
- Tiêu đề, section, card cùng mép lề. Tránh cộng padding hai lần giữa card và list row.
- Web desktop được dùng sidebar/table; mobile được dùng bottom tab/card/bottom sheet. Giữ thứ tự thông tin quan trọng và CTA, không ép mobile thành bản thu nhỏ của bảng desktop.
- Không thêm chức năng chỉ để lấp khoảng trống. Không tạo CTA giả hoặc điều hướng đến màn demo trong luồng thật.
- Tôn trọng safe area, bàn phím, nút back Android, gesture và khả năng cuộn; sticky CTA không che field cuối hoặc tab bar.
- Mobile đang trộn Lucide, Ionicons và các bộ khác. Migrate dần icon chức năng về Lucide theo task; logo provider và minh họa chuyên biệt là ngoại lệ có chủ đích. Không dùng emoji thay icon nghiệp vụ chính.
- Định nghĩa layer theo vai trò content/sticky/menu/dialog/toast; không tự tăng `z-index` hoặc elevation tùy màn để che lỗi layout.
- Motion ưu tiên transform/opacity; tôn trọng reduced motion. Không để gradient/blur/animation trở thành ngôn ngữ riêng của một màn.

### 9.1 Chuyển động cho landing page Web

Theo yêu cầu trực tiếp ngày 28/09/2026, landing page Web sử dụng kể chuyện theo cuộn: ghim từng phần khi nội dung vừa khung nhìn, parallax nhiều lớp và chữ marquee chuyển động theo vị trí cuộn. Đây là quyết định riêng cho trang giới thiệu, không áp dụng lên màn giao dịch hoặc Mobile native.

- Giữ cuộn tự nhiên và điều hướng bàn phím; không chặn hoặc chiếm thao tác cuộn.
- Nội dung và CTA luôn truy cập được. Ở màn hình hẹp, thấp hoặc nội dung dài, chuyển sang bố cục cuộn thông thường.
- Khi người dùng bật giảm chuyển động, bỏ ghim, parallax và marquee động.
- Ưu tiên transform; cập nhật theo requestAnimationFrame khi có cuộn/resize, dọn listener và observer khi rời trang. Không thêm vòng animation liên tục.
- Giữ nguyên màu, font, thuật ngữ, API và quyền. Nội dung AI vẫn là gợi ý sơ bộ; ảnh và ví dụ minh họa phải ghi rõ.

## 10. Contract của các component chung

Web đã có nhiều component `Fh*`. Mobile chưa có một bộ tương đương đầy đủ tại snapshot. Tên mobile trong bảng là đích đề xuất; kiểm tra component hiện có và mức độ tái sử dụng trước khi tạo.

| Component/khái niệm | Quy tắc chung cho cả hai client |
| --- | --- |
| Button (`FhButton`) | Primary/secondary/ghost/danger; md 44, lg 52; web sm 36 chỉ cho ngữ cảnh phù hợp, mobile giữ hit area tối thiểu; loading chặn gửi trùng, có nhãn đang xử lý |
| Input/select | Label rõ, helper/error bên dưới, required nhất quán, input type/keyboard đúng; không dùng placeholder làm label duy nhất |
| Status (`FhStatusPill`) | Domain + status → label/tone; min-height 24, cho tăng chiều cao khi chữ lớn; không cắt trạng thái dài |
| Card (`FhCard`) | Surface/radius/border/elevation từ token; card nhấn được có dấu hiệu tương tác và semantics |
| Money (`FhMoney`) | Một formatter tiền; căn phải trong cột, tabular nums; phân biệt null, 0 và số âm |
| Cost breakdown (`FhCostBreakdown`) | Chi tiết tiền công, linh kiện/vật tư, phát sinh và tổng theo dữ liệu thật; không tự cộng phí hoặc bịa thành phần còn thiếu |
| Confirm (`FhConfirmDialog`) | Nêu đối tượng, hậu quả thật, nhãn hành động rõ; keyboard/focus/back/cancel phù hợp nền tảng |
| Empty/error/loading | Cùng cấu trúc tiêu đề–giải thích–hành động; loading không giả thành danh sách trống |
| Timeline (`FhTimeline`) | Cùng nhãn sự kiện, timezone, dữ liệu và status tone; trạng thái tiến trình và loại sự kiện được phân biệt |
| Upload/evidence | Loại ảnh, giới hạn và yêu cầu lấy từ contract; preview/progress/retry/error/xóa đúng quyền; không hard-code số ảnh tối thiểu từ tài liệu cũ |
| Notification/toast | Tiếng Việt, cùng ý nghĩa với server event; không báo thành công trước khi chắc chắn; lỗi quan trọng có vùng hiển thị bền vững |
| Table/list | Cùng label trường, sort/filter và cách format; mobile đổi bố cục nhưng giữ dữ liệu quyết định |
| Pagination/search | Không mất filter khi quay lại nếu luồng yêu cầu giữ; phân biệt không có dữ liệu với không có kết quả tìm kiếm |

Không yêu cầu dùng component phân tích chi phí cho mọi con số đơn lẻ: số tiền trong một hàng list có thể chỉ cần Money; màn báo giá/hóa đơn/duyệt phát sinh mới cần breakdown tương ứng.

Trích logic dùng chung một cách nhỏ gọn; giữ component thuần trình bày khi có thể. Không tạo “super component” chứa cả quyền, networking, thanh toán và nhiều domain status.

## 11. Định dạng tiền, thời gian, dữ liệu và AI

### 11.1 Tiền và dữ liệu trống

- Tiền VND: `1.250.000 ₫`; cách hiển thị số âm `-50.000 ₫`; không trộn `đ`, `VNĐ`, `VND` tùy màn. Mã tiền tệ trong API vẫn giữ `VND`.
- Giá trị 0 hợp lệ hiển thị `0 ₫`. Giá trị thiếu, không hợp lệ hoặc chưa xác định hiển thị `Chưa xác định` hoặc `—` theo ngữ cảnh; không tự đổi thành 0.
- Backend sở hữu tính tiền và quy tắc làm tròn. Formatter chỉ trình bày, không thay đổi payload hoặc tổng nghiệp vụ.
- Cùng một amount phải cho cùng kết quả trên web/mobile. Không dùng `parseFloat` để lặng lẽ chấp nhận chuỗi không hợp lệ.
- Tên, địa chỉ dài được wrap hoặc mở rộng; không làm mất phần địa chỉ quan trọng. Dữ liệu thiếu không được thay bằng dữ liệu demo.

### 11.2 Ngày giờ

- Ngày hiển thị `dd/MM/yyyy`; giờ 24 giờ `HH:mm`; kết hợp `HH:mm, dd/MM/yyyy`.
- Lịch hẹn FixHome tại Việt Nam hiển thị theo `Asia/Ho_Chi_Minh`. Timestamps lưu/truyền theo contract ISO hiện hành; chuyển timezone ở formatter, không sửa thời gian trong API.
- Date-only phải xử lý như ngày lịch, không biến thành UTC rồi làm lệch ngày. Không parse chuỗi `dd/MM/yyyy` bằng `new Date(string)` phụ thuộc engine.
- Không dựa riêng vào timezone máy người dùng để hiển thị lịch hẹn. Nếu sản phẩm mở khu vực khác, bổ sung contract timezone trước.
- Countdown tính từ deadline server, không tự gán lại TTL khi mở màn hoặc quay lại từ background.

### 11.3 AI và nội dung do server trả về

- Cùng dữ liệu chẩn đoán phải giữ cùng ý nghĩa, cảnh báo, chi phí và đường tiếp tục trên web/mobile.
- Hiển thị `disclaimerVi` khi contract có; giữ thông tin thiếu chắc chắn/clarification. Không biến chẩn đoán sơ bộ thành kết luận chắc chắn.
- `requiresAssessment=true` hoặc `max=null` theo schema không được hiển thị là giá 0; dùng “Cần khảo sát để xác định chi phí”.
- Phân biệt kết quả diagnosis và hội thoại tư vấn; không tự đưa hành động tạo đơn/thanh toán vào câu trả lời AI.
- Khi AI lỗi/timeout/thiếu thông tin, giữ đường chọn dịch vụ thủ công. Không chặn đặt lịch chỉ vì AI không trả lời.
- Tiêu đề/nội dung thông báo do backend phát ra cũng thuộc phạm vi chuẩn hóa ngôn ngữ. Tên thiết bị/lỗi từ catalog của AI cần kiểm tra tương thích nhưng không tự thay mã catalog.
- Map lỗi từ `error.code` và dữ liệu đã chuẩn hóa trong adapter hiện có; không giả định mọi endpoint cùng shape. Đối chiếu `backend/src/common/filters/http-exception.filter.ts` trước khi sửa kiểu lỗi.

## 12. Ranh giới kỹ thuật và bảo mật khi sửa design

- Web giữ Vue/Pinia/router/API client; mobile giữ Expo/React Navigation/Zustand/SecureStore. Không đổi stack để chia sẻ component.
- UI có thể ẩn/disable hành động để hướng dẫn người dùng; backend vẫn phải kiểm tra quyền và ownership. Không gọi endpoint nhạy cảm chỉ vì nút đã xuất hiện.
- Trạng thái mutation chưa rõ phải giữ cơ chế đối chiếu server và chống gửi trùng. Đổi “Không gửi POST lại” thành câu dễ hiểu không được mở khóa nút gửi lại vô điều kiện.
- Không coi việc quay về từ VNPay, hết spinner, đổi route hoặc nhận event cục bộ là thanh toán thành công nếu backend chưa xác nhận.
- Giữ dữ liệu riêng tư ngoài log, screenshot test, fixture và tài liệu. Dùng dữ liệu giả rõ ràng, không copy token/CCCD/ảnh khách hàng thật.
- Nội dung người dùng và AI phải render an toàn; không dùng HTML thô không kiểm soát để giữ định dạng.
- Bổ sung font, icon hoặc native dependency phải kiểm tra bundle/build, license và Expo compatibility. Không nâng version framework ngoài phạm vi.
- Giữ quy tắc Docker/env/CI trong `AGENTS.md`. Thay theme/copy không tự cho phép deploy, sửa migration hoặc chạy mutation lên dữ liệu thật.

## 13. Quy trình làm việc và thứ tự triển khai

### 13.1 Quy trình cho từng task

1. **Đọc và xác định:** commit hiện tại, hướng dẫn repo, file này, màn/component, contract backend và màn đối ứng.
2. **Phân tích tác động:** actor, chức năng, nội dung/tokens thay đổi, các repo bị ảnh hưởng, khác biệt thiết bị được giữ.
3. **Chọn nguồn dùng chung:** token/dictionary/formatter/component đã có; chỉ bổ sung phần thiếu cần thiết.
4. **Triển khai tối thiểu:** sửa nguồn dùng chung trước, rồi các màn trong phạm vi; bảo toàn behavior và dữ liệu.
5. **Đối chiếu:** cùng fixture, cùng trạng thái, cùng actor trên web/mobile; kiểm tra các trạng thái không phải happy path.
6. **Kiểm tra:** thực thi gate repo và checks trực quan phù hợp; không sửa test chỉ để bỏ qua khác biệt chưa giải thích.
7. **Bàn giao:** file thay đổi, bằng chứng, repo còn thiếu, ngoại lệ, kết quả từng kiểm tra.

### 13.2 Thứ tự chuẩn hóa ban đầu

| Ưu tiên | Hạng mục | Điều kiện hoàn tất |
| --- | --- | --- |
| P0 | Cài điểm đọc ở AGENTS, xác định nguồn chuẩn, ghi rõ design cũ | Các repo có bản quy chuẩn đúng phiên bản; giữ hướng dẫn kỹ thuật cũ |
| P1 | Sửa lỗi mã hóa, copy kỹ thuật, mapping domain/status | Chữ tiếng Việt đúng; không lộ raw enum; không thay logic giao dịch |
| P1 | Primary/background/border/semantic tokens | Web/mobile light dùng cùng giá trị; chữ badge đủ tương phản |
| P1 | Font và typography | Font thật nạp đúng; dấu tiếng Việt, offline, scaling đã kiểm tra |
| P2 | Title/dictionary/formatter/common components | Màn tương ứng dùng cùng nội dung và formatter |
| P2 | Migrate các luồng chính | Auth → đặt lịch → đơn → báo giá/phát sinh → thanh toán → lịch sử/thông báo |
| P3 | Các màn Console, trạng thái phụ, dark parity và visual regression | Không còn drift ngoài ngoại lệ đã ghi; kiểm tra theo phạm vi triển khai |

Đây là thứ tự làm việc, không phải lịch ước lượng hoặc lời khẳng định các task đã được thực hiện. Migrate theo từng luồng hoàn chỉnh, tránh đổi hàng loạt bằng regex hoặc sửa mọi màn trong một PR khó review.

### 13.3 Ngăn sai lệch tái diễn

Đích bổ sung khi triển khai tooling: kiểm tra token/key/status giữa repo bằng cùng version; quét màu/font literal mới ngoài allowlist; kiểm tra đầy đủ dictionary/status map; test formatter và component theo hành vi; lưu screenshot chuẩn của luồng quan trọng. Các gate này hiện là đề xuất, không được báo là CI đã có sẵn.

Không cần so sánh pixel tuyệt đối giữa DOM và native. Kiểm tra cùng contract thị giác/nội dung; so sánh screenshot riêng từng nền tảng để phát hiện hồi quy. Nếu dùng cùng JSON làm nguồn, thêm cơ chế kiểm tra adapter đã cập nhật theo JSON, không chỉ so sánh bản JSON giữa hai repo.

## 14. Checklist nghiệm thu

### 14.1 Nội dung và design

- [ ] Đã đọc hướng dẫn repo, quy chuẩn và nguồn thực tế bị ảnh hưởng.
- [ ] Ngôn ngữ tiếng Việt nhất quán, không có lỗi encoding hoặc thông báo kỹ thuật thô.
- [ ] Màn tương ứng có title, thuật ngữ, nhãn field và CTA đồng nhất theo actor/ngữ cảnh.
- [ ] Primary, background, surface, border, text và semantic color lấy từ token.
- [ ] Cùng domain/status có cùng label và tone trong badge, filter, timeline và thông báo.
- [ ] Font đã được nạp thật; đúng weight; không lỗi dấu hoặc cắt chữ.
- [ ] Spacing, radius, icon và hierarchy tuân theo component/token.
- [ ] Tiền 0 khác null; ngày giờ đúng timezone; không tự đổi dữ liệu nghiệp vụ.
- [ ] Không thay API, RBAC, mutation safety, state machine hoặc nghiệp vụ để làm đẹp UI.

### 14.2 Trạng thái và thiết bị

- [ ] Đã xem loading, empty, error, offline, unauthorized/forbidden và dữ liệu thành công khi áp dụng.
- [ ] Đã xem disabled/submitting/success/unknown-result cho hành động có mutation.
- [ ] Tên dài, địa chỉ nhiều dòng, giá trị tiền lớn, thiếu ảnh, thiếu dữ liệu, một/nhiều bản ghi không vỡ layout.
- [ ] Web kiểm tra các bề rộng đại diện 360, 768, 1440 CSS px khi có liên quan; không có tràn ngang ngoài vùng bảng được thiết kế cuộn.
- [ ] Mobile kiểm tra iOS/Android trong phạm vi hỗ trợ, màn nhỏ, safe area, bàn phím và font scaling lớn.
- [ ] Mobile có dark theme: phần sửa đã xem ở cả light và dark.
- [ ] Focus bàn phím trên web rõ; screen reader có label/role/state; error gắn field; modal giữ và trả focus đúng.
- [ ] Mục tiêu kiểm tra tương phản: chữ thường ít nhất 4,5:1, chữ lớn 3:1, dấu hiệu control/focus thiết yếu 3:1; không kết luận đạt nếu chưa đo tổ hợp thực tế.
- [ ] Motion không cản thao tác, có reduced motion; không dùng màu làm tín hiệu duy nhất.
- [ ] Đã so cùng fixture/actor/status ở hai nền tảng hoặc ghi rõ phần chưa kiểm tra.

### 14.3 Gate kỹ thuật

Đọc lại scripts tại commit triển khai; bảng dưới phản ánh script/hướng dẫn tại snapshot, không yêu cầu chạy application suite cho một lần chỉ soạn tài liệu độc lập.

| Repo bị sửa | Gate cần thực hiện theo hướng dẫn repo |
| --- | --- |
| Web | `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` |
| Mobile | `npm run check:expo`, `npm run lint`, `npm run typecheck`, `npm test`; kiểm tra thiết bị ghi riêng |
| Backend | Các gate lint/typecheck/test/build theo AGENTS; E2E khi hành vi/DB cần kiểm tra |
| AI service | Các gate Ruff, pytest, compile/import/startup theo AGENTS khi sửa implementation |
| Docs | `npm run lint`, `npm run check:links`, `npm run validate` khi tích hợp vào repo |

Chỉ ghi `PASS` khi đã chạy và thành công; lỗi là `FAIL`; chưa chạy hoặc thiếu môi trường là `NOT VERIFIED`. Test unit không thay cho kiểm tra font thực tế, visual QA hoặc kiểm tra thiết bị. Không dựng bằng chứng hoặc screenshot giả.

## 15. Mẫu báo cáo kết thúc task của AI

```text
Task:
Repository + branch/commit:
Design-system version:
Actor / màn / component:

Phân tích: yêu cầu, phạm vi, hợp đồng dữ liệu và màn đối ứng.
File đã thay đổi:
Thay đổi: ngôn ngữ / title / token / typography / component / behavior.
Nguồn dùng chung được tái sử dụng:
Web-Mobile parity: phần đã đối chiếu, fixture và phần chưa kiểm tra.

Review:
- CTO/Tech Lead: kiến trúc, ownership và tương thích liên repository.
- BA/PM: đúng use case, thuật ngữ, scope và tiêu chí nghiệm thu.
- Senior Developer: tái sử dụng, maintainability, không hard-code mới.
- Designer: màu, chữ, phân cấp, responsive và accessibility.
- Security: quyền, dữ liệu riêng tư, render an toàn, chống gửi trùng.
- Tester/QA/QC: happy/negative/boundary/error/regression và bằng chứng.
- DevOps: font/assets/dependency/build/env/CI nếu bị ảnh hưởng.

Kiểm tra đã chạy: lệnh, kết quả PASS/FAIL, bằng chứng ngắn.
Kiểm tra chưa chạy: NOT VERIFIED + lý do.
Sai lệch đã xử lý:
Sai lệch còn lại / repo hoặc PR cần phối hợp:
Ngoại lệ có chủ đích: lý do, phạm vi, nguồn quyết định, thời hạn nếu có.
Kết luận task: hoàn tất trong phạm vi hay còn hạng mục bị chặn.
```

Các vai trò là góc nhìn review, không phải bằng chứng đã có nhiều chuyên gia hoặc agent độc lập tham gia. Task nhỏ có thể trình bày gọn nhưng phải giữ các kiểm tra và giới hạn có liên quan.

## 16. Nguồn code cần tra cứu

Các đường dẫn sau đã tồn tại tại snapshot, tính từ root repo tương ứng. Khi file di chuyển, cập nhật danh mục và điểm đọc; không tạo file mới chỉ vì đường dẫn cũ không còn đúng.

| Repo | Nguồn trọng yếu |
| --- | --- |
| Web | `AGENTS.md`; `docs/AI-TECHNICAL-GUIDE.md`; `src/assets/theme.css`; `index.html`; `src/components/FhButton.vue`; `src/components/FhStatusPill.vue`; `src/components/FhMoney.vue`; `src/router/index.ts`; `src/layouts/`; `src/pages/`; `src/api/` |
| Mobile | `AGENTS.md`; `CLAUDE.md`; `docs/AI-TECHNICAL-GUIDE.md`; `App.tsx`; `src/constants/theme.ts`; `src/store/ui.store.ts`; `src/navigation/`; `src/components/`; `src/screens/`; `src/api/` |
| Backend | `src/shared/enums/`; `src/modules/service-orders/service-order-state-machine.ts`; service/DTO của domain liên quan; `src/common/filters/http-exception.filter.ts`; `src/modules/notifications/` |
| AI service | `app/schemas/diagnosis.py`; `app/schemas/chat.py`; `app/data/`; `docs/AI-TECHNICAL-GUIDE.md` |
| Docs | `PROJECT_DOCUMENTATION.md`; `AI_DEVELOPMENT_WORKFLOW.md`; `FIXHOME-AI-BUILD-BRIEF-v2.0.md` P7; `api/`; `architecture/booking-vs-service-order.md` |

Repository nguồn: [Web](https://github.com/FixHome-SEP490/web), [Mobile](https://github.com/FixHome-SEP490/mobile), [Backend](https://github.com/FixHome-SEP490/backend), [AI service](https://github.com/FixHome-SEP490/ai-service), [Docs](https://github.com/FixHome-SEP490/docs).

Lưu ý khi dùng tài liệu cũ: phần màu cam trong build brief, `PENDING_CONFIRMATION` trong một số guide và bảng Booking legacy là các điểm phải đối chiếu lại với code hiện hành. Không sao chép chúng vào tính năng mới như những contract đã được xác minh.

## 17. Quyết định PO ngày 30/09/2026 (đã áp dụng)

Các quyết định dưới đây thay thế phần mâu thuẫn ở mục 5 và 11 cho khu vực khách hàng (`/app/*`) và kỹ thuật viên (`/tech/*`) trên web. Console và landing page giữ nguyên.

- **Tông trung tính theo mobile.** Web khách hàng và kỹ thuật viên dùng thang xám lạnh của `mobile/src/constants/theme.ts` (nền `#F8FAFC`, chữ `#0F172A`, viền `#E2E8F0`). Web cài bằng lớp `.fh-app` trên `<html>` đổi giá trị token `ink-*`, nên code vẫn dùng tên token cũ. Màu chủ đạo `#2563EB` giữ nguyên.
- **Bốn sắc thái có nghĩa.** Xanh dương cho hành động và thông tin, xanh lá cho thành công, **vàng cho ghi chú**, **đỏ cho cảnh báo và lỗi**. Tím và các màu khác gộp về xanh dương trong khu vực này. Không dùng gradient trang trí; mỗi trang tối đa một khối nhấn xanh dương.
- **Không mã lỗi, không thuật ngữ kỹ thuật** trước khách hàng và kỹ thuật viên. Web đưa mọi lỗi qua `src/utils/user-facing-error.ts`: giữ câu tiếng Việt của server, bỏ tiền tố mã (`607: `), đổi câu tiếng Anh hoặc câu kỹ thuật thành câu dự phòng của màn. API client tự áp dụng cho mọi request lỗi.
- **Giờ Việt Nam ở mọi tầng.** Web `src/utils/vn-time.ts`, mobile `src/utils/vn-time.ts`, backend `src/shared/utils/vn-time.ts` tính theo UTC+7 cố định; không phụ thuộc múi giờ máy. Ngày hiển thị `dd/MM/yyyy`, giờ `HH:mm`. Database Supabase đặt `timezone = Asia/Ho_Chi_Minh` (migration 1790000000022); dữ liệu vẫn là `timestamptz`.
- **Một khung nổi mỗi lúc.** Chat với người và trợ lý AI dùng chung trạng thái trong chat store; mở cái này thì cái kia đóng. Trang Tin nhắn không có nút chat nổi.
- **Không xuống dòng tùy tiện.** Nút, chip, badge, mục điều hướng, số tiền, ngày giờ không gãy dòng; tiêu đề cân dòng (`text-wrap: balance`), đoạn văn tránh chữ mồ côi. Chỉ dùng weight 400–700 vì Be Vietnam Pro chỉ nạp 300–700.
- **Khung trang.** Kỹ thuật viên: sidebar có nhóm từ 1024px, thanh tab đáy dưới 1024px. Khách hàng: thanh điều hướng trên từ 1024px, thanh tab đáy dưới 1024px.
- **Giữ nội dung quảng cáo hiện có** (số thợ, ưu đãi, hotline) theo quyết định PO; chỉ làm dịu hình thức.
- **Giao diện mobile không đổi** trong đợt này; mobile chỉ sửa helper thời gian.
