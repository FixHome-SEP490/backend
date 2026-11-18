// The permissions an admin may switch on or off for the service manager role (BUG 177).
// Only the service manager's own default grants are listed, so an admin can narrow what a
// service manager does and give it back, never hand a service manager an admin-only power.
// Basic access the console cannot work without (profile, orders it handles, service list)
// is not listed and stays granted.
export const SERVICE_MANAGER_ROLE = 'service_manager';

export const SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS: ReadonlyArray<{
  code: string;
  group: string;
  label: string;
}> = [
  { code: 'dashboard:read_operational', group: 'Tổng quan', label: 'Xem tổng quan vận hành' },
  { code: 'booking:read_all', group: 'Đơn sửa chữa', label: 'Xem tất cả đơn đặt' },
  { code: 'order:update_status', group: 'Đơn sửa chữa', label: 'Cập nhật trạng thái đơn' },
  { code: 'order:cancel', group: 'Đơn sửa chữa', label: 'Huỷ đơn thay khách hoặc thợ' },
  { code: 'support:read_all', group: 'Hỗ trợ', label: 'Xem yêu cầu hỗ trợ' },
  { code: 'support:resolve', group: 'Hỗ trợ', label: 'Xử lý yêu cầu hỗ trợ, đối soát tiền mặt' },
  { code: 'compensation:decide', group: 'Hỗ trợ', label: 'Quyết định bồi hoàn' },
  { code: 'strike:read_all', group: 'Vi phạm và uy tín', label: 'Xem vi phạm và điểm uy tín' },
  { code: 'strike:waive', group: 'Vi phạm và uy tín', label: 'Gỡ vi phạm, điều chỉnh điểm uy tín' },
  { code: 'rating:moderate', group: 'Vi phạm và uy tín', label: 'Kiểm duyệt đánh giá' },
  { code: 'user:read_all', group: 'Người dùng', label: 'Xem danh sách người dùng' },
  { code: 'config:read', group: 'Hệ thống', label: 'Xem cấu hình hệ thống' },
  { code: 'audit:read', group: 'Hệ thống', label: 'Xem nhật ký thao tác' },
];

export const SERVICE_MANAGER_TOGGLEABLE_CODES = new Set(
  SERVICE_MANAGER_TOGGLEABLE_PERMISSIONS.map((p) => p.code),
);
