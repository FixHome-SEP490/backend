// src/modules/messaging/accept-greeting.ts
import type { AiBookingSummary } from '../ai-diagnosis/ai-chat-summary';
import { hasAdvice } from '../ai-diagnosis/ai-chat-summary';
import { vnParts } from '../../shared/utils/vn-time';

/**
 * The first message a technician "sends" when they accept a job, written by the
 * system so the customer hears from the person coming to their home straight
 * away. When the booking came out of a conversation with the assistant, the
 * message also repeats what that conversation established, so neither side has
 * to start over. Everything in it comes from the booking; nothing is promised
 * that the platform does not already guarantee.
 */
export interface AcceptGreetingInput {
  technicianName: string | null;
  categoryName: string | null;
  serviceName: string | null;
  orderCode: string;
  preferredStartAt: Date | string | null;
  preferredEndAt: Date | string | null;
  aiSummary: AiBookingSummary | null;
}

/** Bound well under the 2000 characters a typed message may have. */
export const GREETING_MAX_LENGTH = 1800;

const pad = (n: number) => String(n).padStart(2, '0');

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** 1210000 -> "1.210.000 ₫", grouping by hand so the server locale does not matter. */
export function formatVnd(amount: number): string {
  return `${Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} ₫`;
}

/** "09:00–11:00 ngày 02/10/2026" in Vietnam time, or null without a start. */
export function formatAppointment(start: Date | string | null, end: Date | string | null): string | null {
  if (!start) return null;
  const s = vnParts(start);
  const day = `${pad(s.day)}/${pad(s.month)}/${s.year}`;
  const from = `${pad(s.hour)}:${pad(s.minute)}`;
  if (!end) return `${from} ngày ${day}`;
  const e = vnParts(end);
  const sameDay = e.year === s.year && e.month === s.month && e.day === s.day;
  const to = `${pad(e.hour)}:${pad(e.minute)}`;
  return sameDay ? `${from}–${to} ngày ${day}` : `${from} ngày ${day} đến ${to} ngày ${pad(e.day)}/${pad(e.month)}/${e.year}`;
}

function priceLine(summary: AiBookingSummary): string | null {
  if (summary.priceMin == null) return null;
  const range = summary.priceMax != null && summary.priceMax > summary.priceMin
    ? `${formatVnd(summary.priceMin)} – ${formatVnd(summary.priceMax)}`
    : `từ ${formatVnd(summary.priceMin)}`;
  return `Chi phí ước tính: ${range} (giá chính xác sau khi tôi kiểm tra)`;
}

export function buildAcceptGreeting(input: AcceptGreetingInput): string {
  const name = input.technicianName?.trim() || 'kỹ thuật viên phụ trách đơn này';
  const field = input.categoryName?.trim() || input.serviceName?.trim();
  const intro = `Chào anh/chị, tôi là ${name}${field ? `, kỹ thuật viên mảng ${field}` : ''} của FixHome.`;

  const service = input.serviceName?.trim();
  const appointment = formatAppointment(input.preferredStartAt, input.preferredEndAt);
  const order = `Tôi đã nhận đơn ${input.orderCode}${service ? ` (${service})` : ''}${appointment ? `, lịch hẹn ${appointment}` : ''}.`;

  const closing = 'Tôi sẽ kiểm tra trực tiếp và báo giá trước khi sửa, anh/chị đồng ý thì tôi mới làm. Anh/chị cần dặn thêm gì cứ nhắn cho tôi ở đây nhé.';

  const summary = input.aiSummary;
  if (!summary || !hasAdvice(summary)) {
    return [`${intro} ${order}`, closing].join('\n\n');
  }

  const lines: string[] = [];
  if (summary.deviceName) lines.push(`Thiết bị: ${clip(summary.deviceName, 120)}`);
  if (summary.customerText) lines.push(`Tình trạng anh/chị mô tả: ${clip(summary.customerText, 400)}`);
  if (summary.suspectedFaults.length) {
    lines.push(`Nhận định sơ bộ của trợ lý: ${summary.suspectedFaults.map((f) => clip(f, 120)).join('; ')}`);
  } else if (summary.conclusion) {
    lines.push(`Trợ lý nhận xét: ${clip(summary.conclusion, 300)}`);
  }
  const price = priceLine(summary);
  if (price) lines.push(price);
  if (summary.photoCount > 0) lines.push(`Anh/chị đã gửi ${summary.photoCount} ảnh cho trợ lý.`);

  const message = [
    `${intro} ${order}`,
    `Tôi đã xem phần anh/chị trao đổi với trợ lý AI:\n${lines.map((line) => `• ${line}`).join('\n')}`,
    `Đây là nhận định sơ bộ, chưa phải kết luận. ${closing}`,
  ].join('\n\n');
  return message.length > GREETING_MAX_LENGTH ? `${message.slice(0, GREETING_MAX_LENGTH - 1)}…` : message;
}
