# T12 — Kết luận hỗ trợ và chuyển quản trị viên xem xét

Backend, base T11 `ee3c236`; sole writer `foxonworld`, nhánh
`foxonworld/fixhome-platform-first-support-case-t12-20261029`, ngày 29/10/2026.
Theo chỉ thị owner, giữ nguyên `docs/CONTEXT.md` cùng toàn bộ lịch sử đội dự án;
tài liệu này là addendum T12, tiếp nối cách bàn giao T11.

## Hợp đồng

- Giữ `POST /api/v1/support/cases/:id/resolve`, JWT, `service_manager` và quyền
  `support:resolve`; Admin vẫn chỉ đọc hồ sơ, không được thêm quyền xử lý/tài chính.
- Summary/detail bổ sung `resolutionExecutionKind`, `needsManualAction`, `nextActor`.
  `DECISION_RECORDED` chỉ là ghi nhận kết luận; `warning_issued`, `price_adjusted`,
  `refund_recorded`, `warranty_overturned` không thực hiện phạt, sửa giá, hoàn tiền
  hoặc sửa bảo hành. Giữ resolutionCode/history, số tiền ghi nhận và việc đóng
  hồ sơ/nhả hold đối với kết luận cuối thông thường. Thông báo nói rõ các thao tác
  nghiệp vụ chưa được thực hiện nếu chưa có xác nhận riêng.
- `refund_to_wallet` và lệnh xác nhận tiền mặt hiện hữu vẫn gọi đúng specialized
  command trong transaction cũ. Chỉ sau command thành công mới ghi strict audit
  `DOMAIN_ACTION_EXECUTED`. Detail xác minh marker cùng code/status/workflowVersion;
  thiếu bằng chứng mới, kể cả hồ sơ legacy đã đóng, trả `EXECUTION_NOT_VERIFIED`.
  List giữ giá trị thận trọng này, không truy vấn audit cho từng dòng. Không suy ra
  hoàn tiền từ `refund_recorded` hay amount. Không thêm money operation.

## Escalation không kết thúc hồ sơ

- Cùng endpoint, `resolutionCode: escalate_admin`, `finalStatus: resolved` chỉ giữ
  tương thích transport; kết quả thật là `in_review`, `resolvedAt: null`, giữ nguyên
  `holdCompletion`, tăng `workflowVersion`. Client phải dùng status/version trả về.
- Bắt buộc thêm `commandId` UUID v4 và `expectedVersion` bằng workflowVersion hiện
  tại. Lệnh cũ thiếu hai trường trả 400, không đóng hồ sơ. Không nhận amount,
  liableParty hoặc grossRefundVnd cho escalation. Evidence tùy chọn chỉ nhận UUID
  nội bộ; đây là tham chiếu do nhân viên cung cấp, không tự chứng thực nội dung ảnh.
- Transaction khóa dòng SupportCase bằng `pessimistic_write`, cập nhật có điều
  kiện version và ghi bắt buộc `SUPPORT_CASE_ESCALATE_ADMIN`: actor/role, owner,
  reason, evidence refs, trạng thái/hold trước sau, command/version và thời điểm
  AuditLog. Audit lỗi thì rollback; không sửa hoặc xóa lịch sử.
- Replay cùng case/command/actor/nội dung trả trạng thái hiện tại, không tăng version,
  ghi audit hoặc thông báo lần hai; khác nội dung/actor, trùng audit hoặc version
  cạnh tranh trả 409. Replay sau thay đổi tiếp theo không khôi phục trạng thái cũ.
- Admin active nhận `SUPPORT_CASE_ESCALATED_ADMIN` với referenceType `SUPPORT_CASE`
  và đúng case UUID; nội dung nêu chế độ chỉ đọc, SM tiếp tục phụ trách. Thông báo
  lỗi không làm mất escalation đã commit; chưa có outbox/retry giao thông báo.
- Không chạm assignment, đơn, booking, báo giá, bảo hành, ledger, kho/custody hoặc
  reputation. Không thêm gate SM/Admin cho khách tự đặt lại từ nguồn T8/T2 hợp lệ.
  Hồ sơ escalation terminal cũ không được tự mở lại hoặc sửa lịch sử.

## Kiểm chứng và giới hạn

- PASS: `npx vitest run src/modules/support-cases/support-case-truth.spec.ts` —
  4/4 tests, RED trước triển khai rồi GREEN. Storage double kiểm tra recorded-only,
  non-terminal escalation/hold/role, replay/version, audit rollback, notification
  failure và real ordinary wallet refund/rollback/readback. Lỗi audit và cảnh báo
  notification trong test fault injection là chủ đích; Vite có cảnh báo config cũ.
- PASS: `npm run typecheck` (exit 0); `git diff --check` (exit 0).
- Review nội bộ của sole writer: BA/PM đúng phạm vi; kiến trúc Nest/TypeORM giữ
  nguyên; Security giữ SM-only và strict audit/version; QA đối chiếu 4 test trên.
  Không có independent reviewer hoặc agent khác.
- NOT VERIFIED: full suite, lint/build, context-doc test, PostgreSQL/SQL/race/RLS,
  JWT/HTTP runtime, Docker/health, provider, shared DB, CI, browser và E2E. Owner yêu
  cầu chỉ focused tests + typecheck + diff; không push/PR/merge/deploy.
- Web/Mobile/Docs repo không sửa, parity NOT VERIFIED. Consumer cần gửi command/version
  mới cho escalation và dùng metadata thay vì dịch resolutionCode thành hành động
  đã xong. Customer/technician `mine` DTO chưa thêm các field staff mới.
- Hoãn triage T8/T9/legacy parts theo source proof và preview bằng chứng có phân
  quyền; không suy từ case prose rằng đã STOP/đã nhận kho/đã đối soát tài chính.
  `needsManualAction` ở đây chỉ mô tả kết luận, không chứng minh đã hết nghĩa vụ
  finance/parts. List chưa attestation execution; đọc detail để kiểm chứng.
- Restart Backend trước runtime QA được cấp phép sau này. Không migration,
  dependency, environment variable hoặc feature flag mới.
