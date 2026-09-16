# DEV1 FINAL REPORT

Ngày: 2026-09-15. Baseline: MASTER v1.4 + DEV1 IMPLEMENTATION PLAN v1.4.

**Kết luận:** đã sửa trực tiếp và kiểm thử lõi Backend + Web. **Chưa đạt điều kiện demo/defense toàn scope DEV1.** Mobile, một số nghiệp vụ và tích hợp DEV2 còn thiếu. PASS build không đồng nghĩa hoàn thành requirement.

## Completed

- Đọc MASTER/PLAN, đối chiếu source và lập bảng P0/P1/P2 trước khi sửa: `dev1-current-code-gap.md`.
- Giữ Technology Stack; không triển khai production, không chạy migration vào DB dùng chung.
- `Pending Confirmation` thuộc Booking/matching. ServiceOrder chỉ được tạo khi Accept, theo MASTER 8.9/DEV1 3.5; wire enum giữ lowercase.
- Luồng được kiểm chứng bằng HTTP/JWT/RBAC/PostgreSQL: Booking → shortlist → Accept → En Route → arrival/evidence → repair → customer confirmation + cash confirmation → Completed.

## Fixed

### P0

- Ownership cho order và nested invoice/evidence/quotation/additional/cash/history/review; chặn customer đọc board toàn hệ thống, thợ khác chuyển trạng thái hoặc duyệt tài chính.
- Accept dùng khóa Booking/User, đọc lại invitation, kiểm tra expiry sau khi chờ khóa; chống hai Accept tạo hai order và hai booking trùng lịch cho cùng thợ.
- Eligibility dùng chung: active account, verification, service skill, area, lịch làm việc/time off, assignment conflict, suspension, unpaid PlatformDue. Giới hạn kết quả sau hard filters.
- GPS tính khoảng cách từ address snapshot; không còn distance=0 hoặc fallback tọa độ giả.
- Start/complete bị chặn khi thiếu arrival, ảnh, approved inspection quote, customer confirmation hoặc payment. Route complete cũ không vượt qua điều kiện.
- Xác nhận cash giao dịch nguyên tử/idempotent; sai số chuyển disputed, không ghi PAID/due. Xác nhận công việc và thanh toán có thể đến theo hai thứ tự.
- Không đánh dấu online invoice/PlatformDue là PAID khi chưa có provider xác thực. Không tự áp strike khi decline/cancel. Chặn monetary cancellation compensation trái MASTER.
- Upload ảnh thật bằng multipart; kiểm tra loại/kích thước/chữ ký file; private Supabase bucket, server-generated object reference và URL ký 5 phút sau ownership check. Không nhận URL ảnh do client tự khai.
- Sửa migration enum và thiếu `commission_dues.due_date` gây HTTP 500 ở cash confirmation.

### P1/P2

- DTO runtime cho booking, thời gian, shortlist, invitation, GPS, quotation/additional, cash, review và assignment.
- Snapshot giá fixed/scope/quantity/địa chỉ; rebook dùng giá hiện tại và thời gian mới. Web rebook là form tạo booking mới được điền sẵn, gửi đúng service/address người dùng chọn.
- Quyết định quotation/additional có ownership, locking, idempotency; approved data không sửa trực tiếp. Additional hết hạn không được approve hoặc tính vào invoice.
- Technician parts mặc định không bảo hành; paid warranty chỉ áp dụng khi khách chọn item. Fee tách khỏi labor commission. FixHome parts chưa có catalog authority trả lỗi thay vì tin giá client.
- Thợ rút trước arrival: đóng assignment cũ, giữ cùng order và toàn bộ lịch sử, mời lại ứng viên kế tiếp sau hard filters. Thợ cũ không còn quyền thực thi. Không thêm trạng thái hoặc chuyển ngược state machine.
- Manual assignment chỉ hỗ trợ trước departure, có reason, kiểm tra eligibility và khóa. Replacement sau arrival cần workflow xử lý ngoại lệ.
- History trả bookingId, status, service snapshot, technician và thời điểm completed/cancelled để Web hiển thị và rebook.
- Web dùng API thật, sửa response envelope/payload/start route; bỏ mock success và ảnh mẫu trong luồng đã sửa. Matching có polling, theo dõi order sau Accept. Form địa chỉ có lấy GPS; customer chọn paid warranty rõ ràng.
- Thêm regression nghiệp vụ/concurrency, kiểm thử storage boundary và hợp đồng API Web. Test auth Web mock transport riêng để không gọi localhost ngoài ý muốn.

## Remaining

| Priority | Phần còn thiếu | Tác động |
| --- | --- | --- |
| P1 | Mobile đang có mock auth/workflows; chưa nối và kiểm thử toàn bộ API DEV1 | Chưa có demo mobile đáng tin cậy; Node hiện tại 20.19.5 thấp hơn yêu cầu Mobile >=22.13 |
| P1 | Booking media và Booking-bound chat chưa hoàn chỉnh | Không tính repair evidence adapter là hoàn tất tất cả media/chat |
| P1 | FixHome Part Catalog, source/pickup/price/warranty integration | FixHome part bị chặn; cần tích hợp DEV2, không dùng giá client |
| P1 | Online invoice payment, PlatformDue payment, cash dispute/timeout resolution | Chỉ cash hợp lệ được kiểm chứng; không có demo thanh toán online/due thật |
| P1 | Additional bị reject và base scope không khả thi | Chưa có UI/API dừng việc chuyên biệt; cần Manager exception, không được ép khách trả phần phát sinh |
| P1 | Mid-job replacement, policy xác nhận violation/strike/boost | Chưa hoàn tất support workflow và phân chia tài chính; không tự suy diễn policy |
| P1 | Fixed-service labor warranty snapshot; chuẩn hóa mã tỉnh/quận; ranking đầy đủ | Cần khóa contract với catalog/technician DEV2; không dùng bảo hành mặc định tự đặt |
| P1 | Scheduler expiry/reminders và realtime/notifications | Matching hiện tiến theo request/poll; không có bảo đảm background khi không client nào hoạt động |
| P1 | Reschedule khi order đang chờ replacement và không còn active assignment | Backend hiện từ chối; cần hoàn thiện recovery UX |
| P2 | Browser/device end-to-end, accessibility, toàn bộ edge cases/pagination và lỗi UI | Unit/API tests không thay thế kiểm thử tương tác thật |

## DEV2 Dependencies

- Auth/RBAC seed, verified technician, skill/working schedule/time off, thống nhất mã service area.
- Service Catalog và cấu hình giá/scope/warranty; Part Catalog + pickup/return authority.
- Payment provider/webhook xác thực, đối soát PlatformDue và cash dispute; Manager support/policy resolution.
- Private Supabase bucket và credential backend; notification transport/background jobs.
- Không thay Auth để cho phép technician tự đăng ký. Fixture test tạo technician qua DB cô lập rồi login thật; đây không phải API bypass production.

## Database Changes

- `1725896000000-SpecV14GapFixes`: chuyển kiểu enum Booking theo cách PostgreSQL cho phép chạy trong transaction; giữ ý nghĩa trạng thái v1.4.
- `1725897000000-Dev1Integrity`: province/district/service name snapshots; unique invitation theo booking+priority, một pending invitation/booking, một invoice/order; kiểm tra quantity/time window.
- `1725898000000-Dev1EvidenceAndDueMetadata`: migration bổ sung riêng cho `due_date`, `repair_evidences.mime_type/file_size`; áp dụng được khi migration trước đã chạy.
- Fresh migration, revert/reapply và legacy adoption được test trên schema UUID riêng. Không dùng synchronize/drop DB ứng dụng.
- Downgrade về unique booking+technician không thể chứa lịch sử mời lại. Migration từ chối rõ ràng trước khi sửa schema, không xóa history; production cần forward migration hoặc kế hoạch chuyển đổi riêng. Test chỉ xóa fixture trong schema disposable để kiểm tra legacy migrations.

## API Changes

| API | Contract/behavior |
| --- | --- |
| POST `/bookings` | `description`, UUID service/address, future start/end; validation thực thi |
| GET `/bookings/:id` | Có `serviceOrderId` khi đã tạo order; invitation của thợ chỉ trả về thợ đó |
| POST `/bookings/:id/shortlist` | 1–5 UUID User IDs khác nhau, tuần tự và recheck eligibility |
| POST `/invitations/:id/respond` | ACCEPT/DECLINE; idempotent cùng quyết định, khóa chống race |
| PATCH `/bookings/:id/schedule`; POST `/bookings/:id/cancel` | Owner-only, kiểm tra trạng thái/assignment |
| POST `/bookings/:id/rebook` | Start/end mới bắt buộc; optional problemDescription/quantity |
| POST `/service-orders/:id/evidence` | **Multipart**: `file`, `type`, optional `note/capturedAt`; JSON mediaUrl cũ bị từ chối |
| GET `/service-orders/:id/evidence` | URL ký có thời hạn; ownership trước khi ký |
| POST `/service-orders/:id/start-repair` | Canonical route; inspection cần approved quotation |
| POST quotation/additional decisions | Optional `paidWarrantyItemIds`; mặc định không mua paid warranty |
| request/confirm/complete, cash declare/confirm | Khóa order, điều kiện nghiệp vụ, retry không tạo invoice/due trùng |
| POST online invoice/due pay | Không giả lập PAID; chưa kết nối provider |
| GET `/repair-history` | Có cancelled/completed, bookingId và display snapshots |
| POST canonical `/reviews` | Dùng `serviceOrderId`; nested order review route vẫn hỗ trợ |
| Manual assignment | UUID, reason bắt buộc, staff + hard filters; sau departure bị chặn |

DEV2/Mobile cần cập nhật evidence multipart và các validation chặt hơn trước khi merge/deploy.

## Tests Performed

| Check | Kết quả |
| --- | --- |
| Backend typecheck | PASS |
| Backend lint | PASS, 0 warnings/errors |
| Backend unit | PASS, 108 tests / 16 files |
| Backend build | PASS |
| HTTP/JWT/RBAC/PostgreSQL/migrations | PASS, 55 tests |
| Web typecheck + production build | PASS |
| Web lint | PASS, max-warnings=0 |
| Web tests | PASS, 14 tests / 3 files |
| Git diff whitespace check | PASS; Git có thông báo line-ending Windows |
| Supabase Storage thực tế | NOT VERIFIED; transport được mock trong E2E, boundary có unit tests |
| Browser full flow / Android / iOS / production deployment | NOT VERIFIED |

E2E bao gồm owner/outsider/wrong technician, invalid DTO, invalid transitions, GPS ngoài vùng, fake evidence URL, duplicate/overlapping Accept, decline/expiry/reselection, pre-arrival replacement, completion thiếu điều kiện, cash retry/sai số, paid warranty opt-in, expired additional và giá rebook hiện tại. Cả thứ tự payment-before-confirmation và confirmation-before-payment đã được kiểm tra.

Test PostgreSQL: container riêng `fixhome-dev1-audit-postgres`, bind `127.0.0.1:55432`; schema test tự dọn sau chạy. Container vẫn được giữ để chạy lại. Không ghi vào DB DEV2.

Chạy lại trong Backend: `$env:DATABASE_PORT='55432'; npm.cmd run test:e2e`. Cần Docker container audit đang chạy. Các test dùng dữ liệu/credential test riêng, không dùng production.

Storage thật cần backend-only `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_EVIDENCE_BUCKET`. Bucket phải private; không đặt service key trong VITE/mobile. Ảnh URL legacy cần chuyển sang private reference trước khi đọc bằng endpoint mới. Chưa kiểm chứng cleanup orphan khi object upload thành công nhưng DB commit thất bại.

## Build Status: PASS

Áp dụng cho Backend và Web tại thời điểm báo cáo. Mobile/production không được tính PASS.

## DEV1 Completion: 65% (ước tính)

Đây là ước tính tiến độ triển khai, **không phải tỷ lệ test pass hay xác nhận đạt toàn bộ Done Check**. Thang 24 task: 1 = lõi đã thực hiện và kiểm chứng; 0.5 = còn UI/client/provider/nhánh nghiệp vụ; 0 = chưa tích hợp. Tổng 15.5/24 ≈ 65%.

| Task | Điểm | Giới hạn chính |
| --- | ---: | --- |
| D1-00 | 1 | Audit + contract notes đã có |
| D1-01 | 0.5 | Mobile discovery chưa tích hợp |
| D1-02 | 0.5 | Backend/Web có; Mobile chưa |
| D1-03 | 0.5 | Address/time có, booking media thiếu |
| D1-04 | 0.5 | Hard filters có; ranking/area contract còn |
| D1-05 | 1 | Shortlist validation/ownership |
| D1-06 | 0.5 | Tuần tự có; background scheduler thiếu |
| D1-07 | 0.5 | Web inbox có; Mobile/push thiếu |
| D1-08 | 1 | Accept/assignment/concurrency |
| D1-09 | 1 | Canonical transitions và completion gates |
| D1-10 | 0.5 | GPS API/Web có; device/manual path chưa |
| D1-11 | 0.5 | Private adapter có; provider/device chưa verify |
| D1-12 | 0.5 | Fixed price có; labor warranty contract còn |
| D1-13 | 1 | Quotation owner approval/immutability |
| D1-14 | 0.5 | Technician parts có; FixHome catalog thiếu |
| D1-15 | 0.5 | Approval/expiry có; stop-base exception thiếu |
| D1-16 | 1 | Completion và hai thứ tự payment/confirmation |
| D1-17 | 0.5 | Cash có; online/due provider thiếu |
| D1-18 | 0.5 | Read model có; full client acceptance chưa |
| D1-19 | 1 | Review owner/completed/duplicate gates |
| D1-20 | 1 | New booking/current price/new time |
| D1-21 | 0.5 | Pre-arrival rematch có; mid-job/manual còn |
| D1-22 | 0 | Chưa tích hợp realtime/notifications |
| D1-23 | 0.5 | Regression có; browser/mobile/provider còn |

Không release/demo toàn scope trước khi xử lý các Remaining và chạy walkthrough thật trên Web/Mobile với DEV2 providers.
