import { describe, expect, it } from 'vitest';
import { buildAcceptGreeting, formatAppointment, formatVnd, GREETING_MAX_LENGTH } from './accept-greeting';
import type { AiBookingSummary } from '../ai-diagnosis/ai-chat-summary';

const base = {
  technicianName: 'Nguyễn Văn An',
  categoryName: 'Điện lạnh',
  serviceName: 'Sửa điều hòa không mát / chảy nước',
  orderCode: 'FH-20261001-AB12CD34',
  // 02:00Z is 09:00 in Vietnam
  preferredStartAt: '2026-10-02T02:00:00.000Z',
  preferredEndAt: '2026-10-02T04:00:00.000Z',
  aiSummary: null,
};

const summary: AiBookingSummary = {
  deviceName: 'Máy lạnh',
  customerText: 'Máy lạnh không ra hơi lạnh, kêu lạch cạch',
  suspectedFaults: ['Máy chạy ồn, rung lắc', 'Hỏng mô tơ quạt dàn lạnh'],
  suggestedActions: [],
  conclusion: 'Có thể quạt dàn lạnh bị kẹt.',
  priceMin: 100000,
  priceMax: 1210000,
  requiresAssessment: true,
  recommendedServiceName: 'Sửa điều hòa',
  photoCount: 2,
  recordedAt: '2026-10-01T00:00:00.000Z',
};

describe('accept greeting', () => {
  it('greets with name, field, order and the appointment in Vietnam time when there is no AI conversation', () => {
    const text = buildAcceptGreeting(base);
    expect(text).toContain('Chào anh/chị, tôi là Nguyễn Văn An, kỹ thuật viên mảng Điện lạnh của FixHome.');
    expect(text).toContain('Tôi đã nhận đơn FH-20261001-AB12CD34 (Sửa điều hòa không mát / chảy nước), lịch hẹn 09:00–11:00 ngày 02/10/2026.');
    expect(text).toContain('báo giá trước khi sửa');
    expect(text).not.toContain('trợ lý');
  });

  it('adds the summary of the assistant conversation when the booking came from one', () => {
    const text = buildAcceptGreeting({ ...base, aiSummary: summary });
    expect(text).toContain('Tôi đã xem phần anh/chị trao đổi với trợ lý AI:');
    expect(text).toContain('• Thiết bị: Máy lạnh');
    expect(text).toContain('• Tình trạng anh/chị mô tả: Máy lạnh không ra hơi lạnh, kêu lạch cạch');
    expect(text).toContain('• Nhận định sơ bộ của trợ lý: Máy chạy ồn, rung lắc; Hỏng mô tơ quạt dàn lạnh');
    expect(text).toContain('• Chi phí ước tính: 100.000 ₫ – 1.210.000 ₫ (giá chính xác sau khi tôi kiểm tra)');
    expect(text).toContain('• Anh/chị đã gửi 2 ảnh cho trợ lý.');
    expect(text).toContain('Đây là nhận định sơ bộ, chưa phải kết luận.');
    expect(text.length).toBeGreaterThan(buildAcceptGreeting(base).length);
  });

  it('falls back to the assistant remark when no fault was named, and to a lower bound without max', () => {
    const text = buildAcceptGreeting({ ...base, aiSummary: { ...summary, suspectedFaults: [], priceMax: null, photoCount: 0 } });
    expect(text).toContain('• Trợ lý nhận xét: Có thể quạt dàn lạnh bị kẹt.');
    expect(text).toContain('Chi phí ước tính: từ 100.000 ₫');
    expect(text).not.toContain('ảnh');
  });

  it('sends the plain greeting when the summary holds no advice', () => {
    const empty = { ...summary, deviceName: null, suspectedFaults: [], conclusion: null, priceMin: null, priceMax: null };
    expect(buildAcceptGreeting({ ...base, aiSummary: empty })).not.toContain('trợ lý');
  });

  it('copes with missing names, dates and services', () => {
    const text = buildAcceptGreeting({ ...base, technicianName: '  ', categoryName: null, serviceName: null, preferredStartAt: null, preferredEndAt: null });
    expect(text).toContain('tôi là kỹ thuật viên phụ trách đơn này của FixHome.');
    expect(text).toContain('Tôi đã nhận đơn FH-20261001-AB12CD34.');
  });

  it('stays under the message limit with huge, emoji-filled input', () => {
    const noisy = '🔥❄️ ' + 'rất dài '.repeat(1000);
    const text = buildAcceptGreeting({
      ...base,
      technicianName: 'Thợ 😀',
      aiSummary: { ...summary, deviceName: noisy, customerText: noisy, suspectedFaults: [noisy, noisy, noisy], conclusion: noisy },
    });
    expect(text.length).toBeLessThanOrEqual(GREETING_MAX_LENGTH);
    expect(text).toContain('Thợ 😀');
  });

  it('formats money and appointments the Vietnamese way', () => {
    expect(formatVnd(0)).toBe('0 ₫');
    expect(formatVnd(1210000)).toBe('1.210.000 ₫');
    // 16:30Z is 23:30 in Vietnam; the end crosses midnight
    expect(formatAppointment('2026-10-02T16:30:00Z', '2026-10-02T18:00:00Z')).toBe('23:30 ngày 02/10/2026 đến 01:00 ngày 03/10/2026');
    expect(formatAppointment('2026-10-02T02:00:00Z', null)).toBe('09:00 ngày 02/10/2026');
    expect(formatAppointment(null, null)).toBeNull();
  });
});

describe('accept greeting line breaks', () => {
  it('never splits an amount from its currency symbol', () => {
    expect(formatVnd(1210000)).not.toMatch(/ ₫/);
    expect(formatVnd(1210000)).toBe('1.210.000\u00A0₫');
  });
});
